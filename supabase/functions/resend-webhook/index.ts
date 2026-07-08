// Resend webhook receiver: bounces / complaints / unsubscribes.
// Routes each event to the correct tenant using the "tenant" tag we attach
// in send-transactional-email, and writes a tenant-scoped row into
// suppressed_emails so one tenant's suppressions don't block another tenant.
//
// Configure in Resend dashboard:
//   URL: https://<project-ref>.supabase.co/functions/v1/resend-webhook
//   Events: email.bounced, email.complained, email.delivery_delayed (optional)
//   Signing secret: store in Supabase secrets as RESEND_WEBHOOK_SECRET
//
// verify_jwt must be false for this function.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'

const encoder = new TextEncoder()

async function verifySvixSignature(
  secret: string,
  msgId: string,
  msgTimestamp: string,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  // Resend uses Svix. Header format: "v1,<base64sig> v1,<base64sig> ..."
  // Signed payload: `${msgId}.${msgTimestamp}.${body}`
  const secretBytes = secret.startsWith('whsec_')
    ? Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0))
    : encoder.encode(secret)

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const toSign = `${msgId}.${msgTimestamp}.${body}`
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(toSign))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))

  return signatureHeader
    .split(' ')
    .map((s) => s.split(',')[1])
    .filter(Boolean)
    .includes(expected)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET')

  const rawBody = await req.text()

  // Verify Svix signature if secret is configured
  if (secret) {
    const svixId = req.headers.get('svix-id') || ''
    const svixTs = req.headers.get('svix-timestamp') || ''
    const svixSig = req.headers.get('svix-signature') || ''
    if (!svixId || !svixTs || !svixSig) {
      console.warn('Missing Svix headers on resend webhook')
      return new Response('Missing signature', { status: 401 })
    }
    const ok = await verifySvixSignature(secret, svixId, svixTs, rawBody, svixSig).catch(
      () => false,
    )
    if (!ok) {
      console.warn('Invalid Svix signature on resend webhook')
      return new Response('Invalid signature', { status: 401 })
    }
  } else {
    console.warn('RESEND_WEBHOOK_SECRET not set — accepting webhook without signature check')
  }

  let event: any
  try {
    event = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  const type: string = event?.type || ''
  const data = event?.data || {}
  const to: string[] = Array.isArray(data.to) ? data.to : data.to ? [data.to] : []
  const tags: Array<{ name: string; value: string }> = Array.isArray(data.tags) ? data.tags : []
  const tenantTag = tags.find((t) => t.name === 'tenant')?.value
  const tenantId = tenantTag && tenantTag !== 'none' ? tenantTag : null

  let reason: 'bounce' | 'complaint' | 'unsubscribe' | null = null
  if (type === 'email.bounced') reason = 'bounce'
  else if (type === 'email.complained') reason = 'complaint'
  else if (type === 'contact.unsubscribed' || type === 'email.unsubscribed') reason = 'unsubscribe'

  if (!reason || to.length === 0) {
    // Not something we suppress (delivered, opened, clicked, delivery_delayed, etc.)
    return new Response(JSON.stringify({ ignored: true, type }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const admin = createClient(supabaseUrl, serviceKey)

  const rows = to.map((email) => ({
    email: email.toLowerCase(),
    tenant_id: tenantId,
    reason,
    metadata: {
      provider: 'resend',
      event_type: type,
      resend_email_id: data.email_id || data.id || null,
      bounce_type: data?.bounce?.type || null,
      bounce_message: data?.bounce?.message || null,
      created_at: event?.created_at || null,
    },
  }))

  const { error } = await admin.from('suppressed_emails').upsert(rows, {
    onConflict: 'email, (COALESCE(tenant_id::text, \'GLOBAL\'))',
    ignoreDuplicates: true,
  })

  if (error) {
    // upsert may fail on the functional index expression syntax in some pg-rest versions;
    // fall back to insert-ignore-on-conflict via raw approach: try individual inserts.
    console.warn('Bulk upsert failed, falling back to per-row inserts:', error.message)
    for (const row of rows) {
      const { error: insErr } = await admin.from('suppressed_emails').insert(row)
      if (insErr && !String(insErr.message).includes('duplicate')) {
        console.error('Failed to insert suppression', insErr, row)
      }
    }
  }

  // Also append status rows to email_send_log for the health dashboard
  const templateTag = tags.find((t) => t.name === 'template')?.value || 'unknown'
  const logStatus = reason === 'bounce' ? 'bounced' : reason === 'complaint' ? 'complained' : 'suppressed'
  const messageId = data?.email_id || data?.id || crypto.randomUUID()
  await admin.from('email_send_log').insert(
    to.map((email) => ({
      tenant_id: tenantId,
      message_id: `webhook-${messageId}-${email}`,
      template_name: templateTag,
      recipient_email: email.toLowerCase(),
      status: logStatus,
      error_message: data?.bounce?.message || null,
      metadata: { provider: 'resend', event_type: type },
    })),
  )

  return new Response(JSON.stringify({ suppressed: to.length, tenant_id: tenantId, reason }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
