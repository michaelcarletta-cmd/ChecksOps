// Nightly re-verification of tenant custom sending domains.
// Iterates every tenant with a resend_domain_id and polls Resend for the
// current status. Flips verified -> failed on DNS drift and stamps
// last_verification_error so the settings UI shows the issue.
//
// Called by pg_cron via net.http_post; no user auth. verify_jwt should be
// true (invoked with the service role key from cron).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/resend'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const lovableKey = Deno.env.get('LOVABLE_API_KEY')
  const resendKey = Deno.env.get('RESEND_API_KEY')

  if (!lovableKey || !resendKey) {
    return json({ error: 'Email provider not configured' }, 500)
  }

  const admin = createClient(supabaseUrl, serviceKey)

  const { data: rows, error } = await admin
    .from('tenant_email_settings')
    .select('tenant_id, sending_domain, resend_domain_id, domain_status')
    .eq('provider', 'resend')
    .not('resend_domain_id', 'is', null)

  if (error) {
    console.error('Failed to load tenant settings for recheck', error)
    return json({ error: 'Failed to load tenants' }, 500)
  }

  const results: Array<Record<string, unknown>> = []

  for (const row of rows || []) {
    try {
      const detailRes = await fetch(`${GATEWAY_URL}/domains/${row.resend_domain_id}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          'X-Connection-Api-Key': resendKey,
        },
      })
      const detail = await detailRes.json().catch(() => ({}))

      if (!detailRes.ok) {
        results.push({
          tenant_id: row.tenant_id,
          status: 'error',
          error: detail?.message || `HTTP ${detailRes.status}`,
        })
        continue
      }

      const providerStatus = String(detail?.status || 'pending').toLowerCase()
      let newStatus: 'pending' | 'verified' | 'failed' = 'pending'
      let errorMsg: string | null = null
      if (providerStatus === 'verified') newStatus = 'verified'
      else if (providerStatus === 'failed' || providerStatus === 'temporary_failure') {
        newStatus = 'failed'
        errorMsg = 'DNS verification failed. Confirm records are still published at your DNS provider.'
      }

      const changed = newStatus !== row.domain_status

      await admin
        .from('tenant_email_settings')
        .update({
          domain_status: newStatus,
          dns_records: detail?.records || [],
          verified_at: newStatus === 'verified' ? new Date().toISOString() : null,
          last_verification_error: errorMsg,
        })
        .eq('tenant_id', row.tenant_id)

      results.push({
        tenant_id: row.tenant_id,
        domain: row.sending_domain,
        was: row.domain_status,
        now: newStatus,
        changed,
      })
    } catch (e) {
      console.error('Recheck failed for tenant', row.tenant_id, e)
      results.push({ tenant_id: row.tenant_id, status: 'exception', error: String(e) })
    }
  }

  console.log('Tenant domain recheck complete', {
    total: results.length,
    changed: results.filter((r) => r.changed).length,
  })

  return json({ success: true, checked: results.length, results })
})

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
