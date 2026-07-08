import * as React from 'npm:react@18.3.1'
import { renderAsync } from 'npm:@react-email/components@0.0.22'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { TEMPLATES } from '../_shared/transactional-email-templates/registry.ts'
import { resolveTenantSender } from '../_shared/tenantEmailSender.ts'

// Generate a cryptographically random 32-byte hex token
function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Auth note: this function uses verify_jwt = true in config.toml, so Supabase's
// gateway validates the caller's JWT (anon or service_role) before the request
// reaches this code. No in-function auth check is needed.

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables')
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Parse request body
  let templateName: string
  let recipientEmail: string
  let idempotencyKey: string
  let messageId: string
  let templateData: Record<string, any> = {}
  let tenantId: string | null = null
  try {
    const body = await req.json()
    templateName = body.templateName || body.template_name
    recipientEmail = body.recipientEmail || body.recipient_email
    tenantId = body.tenantId || body.tenant_id || null
    messageId = crypto.randomUUID()
    idempotencyKey = body.idempotencyKey || body.idempotency_key || messageId
    if (body.templateData && typeof body.templateData === 'object') {
      templateData = body.templateData
    }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON in request body' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (!templateName) {
    return new Response(
      JSON.stringify({ error: 'templateName is required' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 1. Look up template from registry (early — needed to resolve recipient)
  const template = TEMPLATES[templateName]

  if (!template) {
    console.error('Template not found in registry', { templateName })
    return new Response(
      JSON.stringify({
        error: `Template '${templateName}' not found. Available: ${Object.keys(TEMPLATES).join(', ')}`,
      }),
      {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Resolve effective recipient: template-level `to` takes precedence over
  // the caller-provided recipientEmail. This allows notification templates
  // to always send to a fixed address (e.g., site owner from env var).
  const effectiveRecipient = template.to || recipientEmail

  if (!effectiveRecipient) {
    return new Response(
      JSON.stringify({
        error: 'recipientEmail is required (unless the template defines a fixed recipient)',
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Create Supabase client with service role (bypasses RLS)
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // 2. Check suppression list (fail-closed: if we can't verify, don't send)
  // Scope: match either global suppressions (tenant_id IS NULL) OR this tenant's own suppressions.
  const suppressionQuery = supabase
    .from('suppressed_emails')
    .select('id, tenant_id')
    .eq('email', effectiveRecipient.toLowerCase())
  const { data: suppressedRows, error: suppressionError } = tenantId
    ? await suppressionQuery.or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    : await suppressionQuery.is('tenant_id', null)
  const suppressed = suppressedRows && suppressedRows.length > 0 ? suppressedRows[0] : null

  if (suppressionError) {
    console.error('Suppression check failed — refusing to send', {
      error: suppressionError,
      effectiveRecipient,
    })
    return new Response(
      JSON.stringify({ error: 'Failed to verify suppression status' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (suppressed) {
    // Log the suppressed attempt
    await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
    })

    console.log('Email suppressed', { effectiveRecipient, templateName })
    return new Response(
      JSON.stringify({ success: false, reason: 'email_suppressed' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 3. Get or create unsubscribe token (one token per email address)
  const normalizedEmail = effectiveRecipient.toLowerCase()
  let unsubscribeToken: string

  // Check for existing token for this email
  const { data: existingToken, error: tokenLookupError } = await supabase
    .from('email_unsubscribe_tokens')
    .select('token, used_at')
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (tokenLookupError) {
    console.error('Token lookup failed', {
      error: tokenLookupError,
      email: normalizedEmail,
    })
    await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'failed',
      error_message: 'Failed to look up unsubscribe token',
    })
    return new Response(
      JSON.stringify({ error: 'Failed to prepare email' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (existingToken && !existingToken.used_at) {
    // Reuse existing unused token
    unsubscribeToken = existingToken.token
  } else if (!existingToken) {
    // Create new token — upsert handles concurrent inserts gracefully
    unsubscribeToken = generateToken()
    const { error: tokenError } = await supabase
      .from('email_unsubscribe_tokens')
      .upsert(
        { token: unsubscribeToken, email: normalizedEmail },
        { onConflict: 'email', ignoreDuplicates: true }
      )

    if (tokenError) {
      console.error('Failed to create unsubscribe token', {
        error: tokenError,
      })
      await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
        message_id: messageId,
        template_name: templateName,
        recipient_email: effectiveRecipient,
        status: 'failed',
        error_message: 'Failed to create unsubscribe token',
      })
      return new Response(
        JSON.stringify({ error: 'Failed to prepare email' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // If another request raced us, our upsert was silently ignored.
    // Re-read to get the actual stored token.
    const { data: storedToken, error: reReadError } = await supabase
      .from('email_unsubscribe_tokens')
      .select('token')
      .eq('email', normalizedEmail)
      .maybeSingle()

    if (reReadError || !storedToken) {
      console.error('Failed to read back unsubscribe token after upsert', {
        error: reReadError,
        email: normalizedEmail,
      })
      await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
        message_id: messageId,
        template_name: templateName,
        recipient_email: effectiveRecipient,
        status: 'failed',
        error_message: 'Failed to confirm unsubscribe token storage',
      })
      return new Response(
        JSON.stringify({ error: 'Failed to prepare email' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }
    unsubscribeToken = storedToken.token
  } else {
    // Token exists but is already used — email should have been caught by suppression check above.
    // This is a safety fallback; log and skip sending.
    console.warn('Unsubscribe token already used but email not suppressed', {
      email: normalizedEmail,
    })
    await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
      error_message:
        'Unsubscribe token used but email missing from suppressed list',
    })
    return new Response(
      JSON.stringify({ success: false, reason: 'email_suppressed' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 4. Render React Email template to HTML and plain text, and resolve the
  // tenant's sender identity. Wrapped so a crash here (bad templateData,
  // missing tenant email settings, etc.) still gets logged — otherwise it's
  // a silent failure with no trace in email_send_log.
  let html: string
  let plainText: string
  let resolvedSubject: string
  let sender: Awaited<ReturnType<typeof resolveTenantSender>>
  try {
    html = await renderAsync(React.createElement(template.component, templateData))
    plainText = await renderAsync(React.createElement(template.component, templateData), { plainText: true })
    resolvedSubject =
      typeof template.subject === 'function' ? template.subject(templateData) : template.subject
    sender = await resolveTenantSender(supabase, tenantId)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('Failed to render email or resolve sender', { templateName, error: errorMsg })
    await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'failed',
      error_message: `Render/sender resolution failed: ${errorMsg}`.slice(0, 1000),
    })
    return new Response(
      JSON.stringify({ error: 'Failed to prepare email' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // 6a. Custom-domain tenants: send DIRECTLY through Resend (bypass Lovable queue,
  // which is bound to the platform's verified domain).
  if (sender.provider === 'resend' && sender.usingCustomDomain) {
    const lovableKey = Deno.env.get('LOVABLE_API_KEY')
    const resendKey = Deno.env.get('RESEND_API_KEY')

    if (!lovableKey || !resendKey) {
      console.error('Resend credentials missing for custom-domain tenant', { tenantId })
      await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
        message_id: messageId,
        template_name: templateName,
        recipient_email: effectiveRecipient,
        status: 'failed',
        error_message: 'Resend not configured',
      })
      return new Response(JSON.stringify({ error: 'Email provider not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'pending',
    })

    const resendRes = await fetch('https://connector-gateway.lovable.dev/resend/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        'X-Connection-Api-Key': resendKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: sender.from,
        to: [effectiveRecipient],
        subject: resolvedSubject,
        html,
        text: plainText,
        reply_to: sender.replyTo,
        headers: { 'X-Entity-Ref-ID': messageId },
        tags: [
          { name: 'template', value: templateName },
          { name: 'tenant', value: tenantId || 'none' },
        ],
      }),
    })

    const resendBody = await resendRes.json().catch(() => ({}))

    if (!resendRes.ok) {
      console.error('Resend send failed', resendRes.status, resendBody)
      await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
        message_id: messageId,
        template_name: templateName,
        recipient_email: effectiveRecipient,
        status: 'failed',
        error_message: resendBody?.message || `Resend ${resendRes.status}`,
      })
      return new Response(
        JSON.stringify({ error: resendBody?.message || 'Failed to send via Resend' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'sent',
    })

    console.log('Transactional email sent via Resend', {
      templateName,
      effectiveRecipient,
      tenantId,
    })
    return new Response(
      JSON.stringify({ success: true, sent: true, provider: 'resend', id: resendBody?.id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // 6b. Platform sender: enqueue for the Lovable queue dispatcher.
  await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
    message_id: messageId,
    template_name: templateName,
    recipient_email: effectiveRecipient,
    status: 'pending',
  })

  const { error: enqueueError } = await supabase.rpc('enqueue_email', {
    queue_name: 'transactional_emails',
    payload: {
      message_id: messageId,
      to: effectiveRecipient,
      from: sender.from,
      sender_domain: sender.senderDomain,
      reply_to: sender.replyTo,
      tenant_id: tenantId,
      subject: resolvedSubject,
      html,
      text: plainText,
      purpose: 'transactional',
      label: templateName,
      idempotency_key: idempotencyKey,
      unsubscribe_token: unsubscribeToken,
      queued_at: new Date().toISOString(),
    },
  })

  if (enqueueError) {
    console.error('Failed to enqueue email', {
      error: enqueueError,
      templateName,
      effectiveRecipient,
    })

    await supabase.from('email_send_log').insert({ tenant_id: tenantId ?? null,
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'failed',
      error_message: 'Failed to enqueue email',
    })

    return new Response(JSON.stringify({ error: 'Failed to enqueue email' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  console.log('Transactional email enqueued', { templateName, effectiveRecipient })

  return new Response(
    JSON.stringify({ success: true, queued: true }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
})
