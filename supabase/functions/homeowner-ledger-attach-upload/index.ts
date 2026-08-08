// Staff-authenticated. Attaches a homeowner-submitted upload to a claim.
// - Copies the front/back images from `homeowner-uploads` to `claim-files`
// - Inserts a `check_intake_items` row on the claim (stage = 'review', source = 'insurance')
// - Marks the upload attached
// - Backfills the ledger token with claim_id so any future uploads on the same
//   link auto-link to this claim
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const token = authHeader.replace('Bearer ', '')
  const { data: claims, error: cerr } = await userClient.auth.getClaims(token)
  if (cerr || !claims?.claims?.sub) return json({ error: 'unauthorized' }, 401)
  const userId = claims.claims.sub as string

  const svc = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    const { upload_id, claim_id, amount } = await req.json()
    if (!upload_id) return json({ error: 'missing_params' }, 400)

    // Load upload
    const { data: up, error: upErr } = await svc
      .from('homeowner_ledger_check_uploads')
      .select('*')
      .eq('id', upload_id)
      .maybeSingle()
    if (upErr) throw upErr
    if (!up) return json({ error: 'upload_not_found' }, 404)
    if (up.status === 'attached') return json({ error: 'already_attached', check_id: up.attached_check_id }, 409)

    // Load claim + verify tenant match
    let claimNumber: string | null = null;
    if (claim_id) {
      const { data: claim } = await svc
        .from('claims')
        .select('id, tenant_id, claim_number')
        .eq('id', claim_id)
        .maybeSingle()
      if (!claim) return json({ error: 'claim_not_found' }, 404)
      if (claim.tenant_id !== up.tenant_id) return json({ error: 'tenant_mismatch' }, 403)
      claimNumber = claim.claim_number;
    }

    // Verify staff belongs to tenant
    const { data: membership } = await svc.from('tenant_users')
      .select('user_id').eq('user_id', userId).eq('tenant_id', up.tenant_id).maybeSingle()
    if (!membership) return json({ error: 'forbidden' }, 403)

    // Copy files from homeowner-uploads -> claim-files
    const copied = await copyToClaimFiles(svc, up.tenant_id, claim_id ?? 'unlinked', up.front_path)
    const backCopied = up.back_path ? await copyToClaimFiles(svc, up.tenant_id, claim_id ?? 'unlinked', up.back_path) : null

    // Insert check_intake_items row
    const { data: check, error: chErr } = await svc
      .from('check_intake_items')
      .insert({
        claim_id: claim_id ?? null,
        tenant_id: up.tenant_id,
        uploaded_by: userId,
        front_image_path: copied,
        back_image_path: backCopied,
        amount: amount ?? up.amount_estimate ?? null,
        status: 'pending',
        check_stage: 'review',
        check_source: 'insurance',
      })
      .select('id')
      .single()
    if (chErr) throw chErr

    // Mark upload attached
    await svc.from('homeowner_ledger_check_uploads').update({
      status: 'attached',
      attached_check_id: check.id,
      claim_id: claim_id ?? null,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
    }).eq('id', upload_id)

    // Backfill token with claim_id so future uploads auto-link
    if (up.token_id) {
      const { data: tok } = await svc.from('homeowner_ledger_tokens')
        .select('id, claim_id').eq('id', up.token_id).maybeSingle()
      if (tok && !tok.claim_id) {
        await svc.from('homeowner_ledger_tokens')
          .update({ claim_id: claim.id })
          .eq('id', tok.id)
      }
    }

    // Log ledger event
    await svc.from('homeowner_ledger_events').insert({
      tenant_id: up.tenant_id,
      claim_id: claim_id ?? null,
      event_type: 'homeowner_upload_attached',
      amount: amount ?? up.amount_estimate ?? null,
      actor_label: 'Staff',
      payload_json: { upload_id, check_id: check.id, claim_number: claimNumber },
    })

    return json({ ok: true, check_id: check.id, claim_id: claim_id ?? null })
  } catch (e) {
    console.error('homeowner-ledger-attach-upload error', e)
    return json({ error: 'server_error', message: String((e as Error).message) }, 500)
  }
})

async function copyToClaimFiles(svc: any, tenantId: string, claimId: string, srcPath: string): Promise<string> {
  const { data: dl, error: dlErr } = await svc.storage.from('homeowner-uploads').download(srcPath)
  if (dlErr) throw dlErr
  const bytes = new Uint8Array(await dl.arrayBuffer())
  const filename = srcPath.split('/').pop() || 'check'
  const destPath = `${tenantId}/${claimId}/homeowner-checks/${Date.now()}-${filename}`
  const { error: upErr } = await svc.storage.from('claim-files')
    .upload(destPath, bytes, { contentType: (dl as Blob).type || 'application/octet-stream', upsert: false })
  if (upErr) throw upErr
  return destPath
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
