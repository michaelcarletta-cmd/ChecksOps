// Re-check verification status of a tenant's custom sending domain by
// polling Resend and updating tenant_email_settings.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/resend'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const lovableKey = Deno.env.get('LOVABLE_API_KEY')
  const resendKey = Deno.env.get('RESEND_API_KEY')

  if (!lovableKey || !resendKey) return json({ error: 'Email provider not configured' }, 500)

  const authHeader = req.headers.get('Authorization') || ''
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401)

  let body: { tenantId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  const tenantId = body.tenantId
  if (!tenantId) return json({ error: 'tenantId required' }, 400)

  const admin = createClient(supabaseUrl, serviceKey)

  const { data: membership } = await admin
    .from('tenant_users')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('user_id', userData.user.id)
    .maybeSingle()
  if (!membership) return json({ error: 'Forbidden' }, 403)

  const { data: settings } = await admin
    .from('tenant_email_settings')
    .select('resend_domain_id, sending_domain')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!settings?.resend_domain_id) {
    return json({ error: 'No custom domain configured' }, 400)
  }

  // Ask Resend to (re-)verify — this triggers a DNS re-check server-side.
  await fetch(`${GATEWAY_URL}/domains/${settings.resend_domain_id}/verify`, {
    method: 'POST',
    headers: gatewayHeaders(lovableKey, resendKey),
  }).catch((e) => console.warn('verify trigger failed', e))

  // Read the latest status
  const detailRes = await fetch(`${GATEWAY_URL}/domains/${settings.resend_domain_id}`, {
    method: 'GET',
    headers: gatewayHeaders(lovableKey, resendKey),
  })
  const detail = await detailRes.json().catch(() => ({}))

  if (!detailRes.ok) {
    console.error('Resend get domain failed', detailRes.status, detail)
    return json({ error: detail?.message || 'Failed to check status' }, 502)
  }

  const providerStatus = String(detail?.status || 'pending').toLowerCase()
  // Resend statuses: pending, verified, failed, temporary_failure, not_started
  let status: 'pending' | 'verified' | 'failed' = 'pending'
  let errorMsg: string | null = null
  if (providerStatus === 'verified') status = 'verified'
  else if (providerStatus === 'failed') {
    status = 'failed'
    errorMsg = 'DNS verification failed. Confirm the records are published at your DNS provider.'
  }

  await admin
    .from('tenant_email_settings')
    .update({
      domain_status: status,
      dns_records: detail?.records || [],
      verified_at: status === 'verified' ? new Date().toISOString() : null,
      last_verification_error: errorMsg,
    })
    .eq('tenant_id', tenantId)

  return json({
    success: true,
    domainStatus: status,
    providerStatus,
    dnsRecords: detail?.records || [],
    error: errorMsg,
  })
})

function gatewayHeaders(lovableKey: string, resendKey: string) {
  return {
    Authorization: `Bearer ${lovableKey}`,
    'X-Connection-Api-Key': resendKey,
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
