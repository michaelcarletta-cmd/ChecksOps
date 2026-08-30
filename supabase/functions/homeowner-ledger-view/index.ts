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
    let pending_endorsements: any[] = []
    let shared_documents: any[] = []
    let project_plan: any = null
    let money: any = null
    let deductible_payments: any[] = []


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
      // Collapse batched per-payee sends into a single homeowner-facing entry.
      // Multiple concurrent endorsement inserts can race past the DB-side
      // 5-minute dedupe; group here as a safety net so the timeline shows one
      // "signature request sent" per check per 15-minute window.
      const COLLAPSE_TYPES = new Set(['endorsement_requested', 'endorsements_sent'])
      const WINDOW_MS = 15 * 60 * 1000
      const seenBuckets = new Map<string, { rep: any; count: number; names: Set<string> }>()
      const collapsed: any[] = []
      for (const row of (ev ?? []) as any[]) {
        if (!COLLAPSE_TYPES.has(row.event_type) || !row.check_id) {
          collapsed.push(row)
          continue
        }
        const bucketMs = Math.floor(new Date(row.occurred_at).getTime() / WINDOW_MS)
        const key = `${row.check_id}|${row.event_type}|${bucketMs}`
        const existing = seenBuckets.get(key)
        const payeeName = row.payload_json?.payee_name as string | undefined
        if (!existing) {
          const bucket = { rep: row, count: 1, names: new Set<string>() }
          if (payeeName) bucket.names.add(payeeName)
          seenBuckets.set(key, bucket)
          collapsed.push(row)
        } else {
          existing.count += 1
          if (payeeName) existing.names.add(payeeName)
          existing.rep.payload_json = {
            ...(existing.rep.payload_json || {}),
            batched: true,
            batched_count: existing.count,
            batched_payees: Array.from(existing.names),
          }
        }
      }
      events = collapsed

      // Authoritative totals: derive from check_intake_items + disbursements
      // (events can be stale/backfilled inconsistently).
      const { data: allChecks } = await supabase
        .from('check_intake_items')
        .select('id, amount, check_stage, check_number')
        .eq('claim_id', tok.claim_id)
      const checks = (allChecks ?? []) as Array<{ id: string; amount: number | null; check_stage: string | null; check_number: string | null }>
      // Any stage at or past deposit counts as deposited (funds_released is
      // downstream of deposited — it must not reset the deposited total).
      const DEPOSITED_STAGES = ['deposited', 'cleared', 'funds_released', 'disbursed']
      for (const c of checks) {
        const amt = Number(c.amount ?? 0)
        totals.received += amt
        if (DEPOSITED_STAGES.includes((c.check_stage || '').toLowerCase())) {
          totals.deposited += amt
        }
      }

      // Released = money actually sent out for this claim's checks.
      const DEAD_STATUSES = ['cancelled', 'canceled', 'failed', 'returned', 'voided']
      const claimCheckIds = checks.map((c) => c.id)
      if (claimCheckIds.length > 0) {
        const { data: batches } = await supabase
          .from('disbursement_batches')
          .select('id')
          .in('check_intake_item_id', claimCheckIds)
        const batchIds = (batches ?? []).map((b: any) => b.id)
        if (batchIds.length > 0) {
          const { data: splits } = await supabase
            .from('disbursement_splits')
            .select('amount, status')
            .in('batch_id', batchIds)
          for (const s of (splits ?? []) as any[]) {
            if (!DEAD_STATUSES.includes(String(s.status || '').toLowerCase())) {
              totals.released += Number(s.amount ?? 0)
            }
          }
        }
      }
      // Legacy fallback (older claims recorded payouts here).
      const { data: disb } = await supabase
        .from('claim_disbursements')
        .select('amount, status')
        .eq('claim_id', tok.claim_id)
      for (const d of (disb ?? [])) {
        const s = ((d as any).status || '').toLowerCase()
        if (!DEAD_STATUSES.includes(s)) {
          totals.released += Number((d as any).amount ?? 0)
        }
      }
      totals.remaining = Math.max(0, totals.received - totals.released)


      // Project schedule + money summary (contractor-maintained)
      const { data: plan } = await supabase
        .from('claim_project_plans')
        .select('start_window_start, start_window_end, schedule_status, schedule_note, contract_total, deductible_amount, other_out_of_pocket, share_with_homeowner, allow_deductible_payment, updated_at')
        .eq('claim_id', tok.claim_id)
        .maybeSingle()

      const { data: dpays } = await supabase
        .from('homeowner_deductible_payments')
        .select('id, amount, status, bank_name, bank_last_four, created_at, completed_at')
        .eq('claim_id', tok.claim_id)
        .order('created_at', { ascending: false })
      deductible_payments = (dpays ?? []) as any[]

      if (plan && plan.share_with_homeowner) {
        project_plan = {
          start_window_start: plan.start_window_start,
          start_window_end: plan.start_window_end,
          schedule_status: plan.schedule_status,
          schedule_note: plan.schedule_note,
          updated_at: plan.updated_at,
        }
        const deductible = Number(plan.deductible_amount ?? 0)
        const other = Number(plan.other_out_of_pocket ?? 0)
        const contract = Number(plan.contract_total ?? 0)
        const deductiblePaid = deductible_payments
          .filter((p) => !['failed', 'returned', 'canceled'].includes(String(p.status)))
          .reduce((s, p) => s + Number(p.amount ?? 0), 0)
        const insuranceOutstanding = contract > 0
          ? Math.max(0, contract - deductible - other - totals.received)
          : 0
        money = {
          contract_total: contract,
          insurance_received: totals.received,
          insurance_outstanding: insuranceOutstanding,
          deductible_amount: deductible,
          deductible_paid: deductiblePaid,
          deductible_due: Math.max(0, deductible - deductiblePaid),
          other_out_of_pocket: other,
          out_of_pocket_total: Math.max(0, deductible + other - deductiblePaid),
          allow_deductible_payment: !!plan.allow_deductible_payment,
        }
      }


      const checkIds = checks.map((c) => c.id)
      const checkMeta = new Map(checks.map((c) => [c.id, c]))

      // Pending document e-signature requests for this claim
      const signatureFilter = checkIds.length > 0
        ? `claim_id.eq.${tok.claim_id},check_intake_item_id.in.(${checkIds.join(',')})`
        : `claim_id.eq.${tok.claim_id}`
      const { data: sreqs } = await supabase
        .from('signature_requests')
        .select('id, document_name, status, sent_at, signature_signers(id, signer_name, signer_email, status, signed_at)')
        .or(signatureFilter)
        .in('status', ['pending', 'sent', 'partial', 'in_progress'])
        .order('sent_at', { ascending: false })
        .limit(50)
      const homeownerEmail = (tok.homeowner_email || '').toLowerCase()
      const homeownerName = (tok.homeowner_name || '').toLowerCase().trim()
      const nameParts = homeownerName.split(/\s+/).filter((p) => p.length >= 3)
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

      // Per-check pending endorsements — only Insured + Mortgage parties are
      // shown to the homeowner (PA/contractor signatures are internal).
      // Grouped per check so the homeowner sees who still owes a signature.
      if (checkIds.length > 0) {
        const { data: endorsements } = await supabase
          .from('check_endorsements')
          .select('id, check_id, payee_name, payee_type, status, token, contact_email, signed_at, request_sent_at')
          .in('check_id', checkIds)
          .in('payee_type', ['insured', 'mortgage_company'])
          .order('created_at', { ascending: true })
        const appUrl = (Deno.env.get('SIGN_BASE_URL') || 'https://checksops.com').replace(/\/$/, '')
        const isDone = (e: any) => e.signed_at || ['signed', 'waived', 'endorsed', 'completed', 'complete'].includes((e.status || '').toLowerCase())
        // Only show endorsements that the tenant has actually sent — not
        // every insured/mortgage payee row that exists in the database.
        const isSent = (e: any) => {
          if (e.request_sent_at) return true
          const s = (e.status || '').toLowerCase()
          return ['sent', 'requested', 'in_progress', 'pending_signature', 'awaiting_signature'].includes(s)
        }
        const isHomeownerParty = (e: any) => {
          if (e.payee_type !== 'insured') return false
          const emailHit = homeownerEmail && (e.contact_email || '').toLowerCase() === homeownerEmail
          const nameLc = (e.payee_name || '').toLowerCase()
          const nameHit = nameParts.length > 0 && nameParts.some((p) => nameLc.includes(p))
          return emailHit || nameHit || !homeownerEmail // default assume yes if no email on token
        }
        const byCheck = new Map<string, any>()
        for (const e of (endorsements ?? []) as any[]) {
          if (isDone(e)) continue
          if (!isSent(e)) continue
          const meta = checkMeta.get(e.check_id)
          if (!byCheck.has(e.check_id)) {
            byCheck.set(e.check_id, {
              check_id: e.check_id,
              check_number: meta?.check_number ?? null,
              check_amount: meta?.amount ?? null,
              parties: [] as any[],
            })
          }
          byCheck.get(e.check_id).parties.push({
            endorsement_id: e.id,
            payee_name: e.payee_name,
            payee_type: e.payee_type, // 'insured' | 'mortgage_company'
            status: e.status,
            sent_at: e.request_sent_at,
            is_homeowner: isHomeownerParty(e),
            sign_url: (e.payee_type === 'insured' && isHomeownerParty(e) && e.token)
              ? `${appUrl}/endorse?token=${e.token}`
              : null,
          })
        }
        pending_endorsements = Array.from(byCheck.values())
      }

      // Shared Documents (Catalogs, etc)
      const { data: sharedDocs } = await supabase
        .from('tenant_documents')
        .select('id, file_name, file_path, doc_type, mime_type, file_size')
        .eq('tenant_id', tok.tenant_id)
        .eq('shared_with_homeowners', true)
        .order('created_at', { ascending: false })

      if (sharedDocs) {
        // Generate signed URLs for each
        const docPromises = sharedDocs.map(async (doc: any) => {
          const { data } = await supabase.storage
            .from('tenant-documents')
            .createSignedUrl(doc.file_path, 60 * 60 * 24) // 24 hours
          return {
            ...doc,
            url: data?.signedUrl
          }
        })
        shared_documents = await Promise.all(docPromises)
      }
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
      pending_endorsements,
      shared_documents,
      project_plan,
      money,
      deductible_payments,
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
