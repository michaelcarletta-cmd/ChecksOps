// Public endpoint. verify_jwt = false (default for Lovable-managed functions).
// GET/POST { token } → returns claim summary + timeline events + upload perms.
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const url = new URL(req.url)
    let token = url.searchParams.get('token')
    if (!token && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      token = body?.token ?? null
    }
    if (!token || token.length < 8) {
      return json({ error: 'invalid_token' }, 400)
    }

    const { data: tok, error: terr } = await supabase
      .from('homeowner_ledger_tokens')
      .select('id, tenant_id, claim_id, homeowner_email, homeowner_name, revoked_at, expires_at')
      .eq('token', token)
      .maybeSingle()

    if (terr || !tok) return json({ error: 'not_found' }, 404)
    if (tok.revoked_at) return json({ error: 'revoked' }, 410)
    if (tok.expires_at && new Date(tok.expires_at) < new Date()) return json({ error: 'expired' }, 410)

    // Record view (best-effort)
    await supabase
      .from('homeowner_ledger_tokens')
      .update({ last_viewed_at: new Date().toISOString() })
      .eq('id', tok.id)
      .then(() => {}, () => {})

    let claim: any = null
    let events: any[] = []
    let totals = { received: 0, deposited: 0, released: 0, remaining: 0 }
    let pending_upload_count = 0
    let pending_signatures: any[] = []

    if (tok.claim_id) {
      const { data: c, error: claimErr } = await supabase
        .from('claims')
        .select('id, claim_number, property_address:policyholder_address, loss_type, status, created_at')
        .eq('id', tok.claim_id)
        .maybeSingle()
      if (claimErr) {
        console.error('homeowner-ledger-view claim lookup failed', claimErr)
        return json({ error: 'claim_lookup_failed', message: claimErr.message }, 500)
      }
      claim = c

      const { data: ev } = await supabase
        .from('homeowner_ledger_events')
        .select('id, check_id, event_type, occurred_at, amount, actor_label, payload_json')
        .eq('claim_id', tok.claim_id)
        .order('occurred_at', { ascending: false })
        .limit(500)
      events = ev ?? []

      for (const e of events) {
        const amt = Number(e.amount ?? 0)
        if (e.event_type === 'check_received' || e.event_type === 'supplement_check'
          || e.event_type === 'depreciation_check' || e.event_type === 'deductible_check') {
          totals.received += amt
        } else if (e.event_type === 'deposited') {
          totals.deposited += amt
        } else if (e.event_type === 'funds_released') {
          totals.released += amt
        }
      }
      totals.remaining = totals.received - totals.released

      // Pending signature requests for this claim (any signer not yet signed)
      const { data: sreqs } = await supabase
        .from('signature_requests')
        .select('id, document_name, status, sent_at, signature_signers(id, signer_name, signer_email, status, signed_at)')
        .eq('claim_id', tok.claim_id)
        .in('status', ['pending', 'sent', 'partial'])
        .order('sent_at', { ascending: false })
        .limit(50)
      const homeownerEmail = (tok.homeowner_email || '').toLowerCase()
      pending_signatures = (sreqs ?? []).map((r: any) => ({
        request_id: r.id,
        document_name: r.document_name,
        sent_at: r.sent_at,
        signers: (r.signature_signers || []).map((s: any) => ({
          signer_id: s.id,
          name: s.signer_name,
          email: s.signer_email,
          status: s.status,
          signed_at: s.signed_at,
          is_homeowner: (s.signer_email || '').toLowerCase() === homeownerEmail,
        })),
      })).filter((r: any) => r.signers.some((s: any) => s.status !== 'signed'))
    } else {
      // Pre-claim: show pending uploads for this token
      const { count } = await supabase
        .from('homeowner_ledger_check_uploads')
        .select('id', { count: 'exact', head: true })
        .eq('token_id', tok.id)
      pending_upload_count = count ?? 0
    }

    return json({
      ok: true,
      mode: tok.claim_id ? 'claim' : 'pre_claim',
      homeowner: { name: tok.homeowner_name, email: tok.homeowner_email },
      claim,
      events,
      totals,
      pending_upload_count,
      pending_signatures,
      can_upload: true,
    })
  } catch (e) {
    console.error('homeowner-ledger-view error', e)
    return json({ error: 'server_error', message: String((e as Error).message) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
