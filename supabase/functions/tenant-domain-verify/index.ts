// Register a tenant's custom sending domain with Resend and return DNS records.
// Caller must be an admin of the target tenant.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/resend'

interface ResendDnsRecord {
  record: string
  name: string
  type: string
  ttl?: string | number
  status?: string
  value: string
  priority?: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const lovableKey = Deno.env.get('LOVABLE_API_KEY')
  const resendKey = Deno.env.get('RESEND_API_KEY')

  if (!lovableKey || !resendKey) {
    return json({ error: 'Email provider not configured' }, 500)
  }

  const authHeader = req.headers.get('Authorization') || ''
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401)

  let body: { tenantId?: string; domain?: string; fromLocalPart?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const tenantId = body.tenantId
  const domain = (body.domain || '').trim().toLowerCase()
  const fromLocal = (body.fromLocalPart || 'noreply').trim().toLowerCase()

  if (!tenantId || !domain) return json({ error: 'tenantId and domain required' }, 400)
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
    return json({ error: 'Invalid domain' }, 400)
  }
  if (!/^[a-z0-9._-]{1,64}$/.test(fromLocal)) {
    return json({ error: 'Invalid from local part' }, 400)
  }

  const admin = createClient(supabaseUrl, serviceKey)

  // Verify caller is admin of this tenant
  const { data: membership } = await admin
    .from('tenant_users')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('user_id', userData.user.id)
    .maybeSingle()
  if (!membership || membership.role !== 'admin') {
    return json({ error: 'Forbidden' }, 403)
  }

  // Look up any existing settings row / prior resend domain id
  const { data: existing } = await admin
    .from('tenant_email_settings')
    .select('resend_domain_id, sending_domain')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  // If the tenant already registered a *different* domain, delete the old one to avoid orphans
  if (existing?.resend_domain_id && existing.sending_domain !== domain) {
    await fetch(`${GATEWAY_URL}/domains/${existing.resend_domain_id}`, {
      method: 'DELETE',
      headers: gatewayHeaders(lovableKey, resendKey),
    }).catch((e) => console.warn('Failed to delete stale resend domain', e))
  }

  // Create domain in Resend
  const createRes = await fetch(`${GATEWAY_URL}/domains`, {
    method: 'POST',
    headers: { ...gatewayHeaders(lovableKey, resendKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: domain }),
  })
  const createBody = await createRes.json().catch(() => ({}))

  let resendDomainId: string | undefined = createBody?.id
  let dnsRecords: ResendDnsRecord[] | undefined = createBody?.records

  // If domain already registered, look it up
  if (!createRes.ok) {
    const listRes = await fetch(`${GATEWAY_URL}/domains`, {
      method: 'GET',
      headers: gatewayHeaders(lovableKey, resendKey),
    })
    const listBody = await listRes.json().catch(() => ({}))
    const match = (listBody?.data || []).find((d: any) => d.name === domain)
    if (!match) {
      console.error('Resend domain create failed', createRes.status, createBody)
      return json(
        { error: createBody?.message || 'Failed to register domain with email provider' },
        502,
      )
    }
    resendDomainId = match.id
    const detailRes = await fetch(`${GATEWAY_URL}/domains/${match.id}`, {
      method: 'GET',
      headers: gatewayHeaders(lovableKey, resendKey),
    })
    const detailBody = await detailRes.json().catch(() => ({}))
    dnsRecords = detailBody?.records
  }

  const status: 'pending' | 'verified' =
    createBody?.status === 'verified' ? 'verified' : 'pending'

  const { error: upsertErr } = await admin.from('tenant_email_settings').upsert(
    {
      tenant_id: tenantId,
      sending_mode: 'custom',
      provider: 'resend',
      sending_domain: domain,
      from_address: `${fromLocal}@${domain}`,
      resend_domain_id: resendDomainId,
      dns_records: dnsRecords || [],
      domain_status: status,
      verified_at: status === 'verified' ? new Date().toISOString() : null,
      last_verification_error: null,
    },
    { onConflict: 'tenant_id' },
  )

  if (upsertErr) {
    console.error('Failed to save email settings', upsertErr)
    return json({ error: 'Failed to save settings' }, 500)
  }

  return json({ success: true, domainStatus: status, dnsRecords, resendDomainId })
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
