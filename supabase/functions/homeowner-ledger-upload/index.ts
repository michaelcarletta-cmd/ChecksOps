// Public endpoint. Homeowner uploads a check image (front + optional back) or production doc.
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const MAX_BYTES = 15 * 1024 * 1024
const ALLOWED = /^(image\/(png|jpe?g|heic|heif|webp)|application\/pdf)$/i

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const body = await req.json()
    const {
      token,
      kind = 'check',           // 'check' | 'production_doc'
      front_base64,
      front_mime,
      front_filename,
      back_base64,
      back_mime,
      back_filename,
      amount_estimate,
      homeowner_note,
    } = body ?? {}

    if (!token) return json({ error: 'missing_token' }, 400)
    if (!front_base64 || !front_mime) return json({ error: 'missing_front' }, 400)
    if (!ALLOWED.test(front_mime)) return json({ error: 'bad_mime' }, 400)

    const { data: tok } = await supabase
      .from('homeowner_ledger_tokens')
      .select('id, tenant_id, claim_id, revoked_at, partner_code, sent_by_user_id')
      .eq('token', token)
      .maybeSingle()
    if (!tok || tok.revoked_at) return json({ error: 'invalid_token' }, 401)

    const frontBytes = decodeDataUrl(front_base64)
    if (frontBytes.byteLength > MAX_BYTES) return json({ error: 'front_too_large' }, 413)

    const ts = Date.now()
    const safeFront = (front_filename || 'front.jpg').replace(/[^\w.\-]/g, '_')
    const frontPath = `${tok.tenant_id}/${tok.id}/${ts}-front-${safeFront}`
    const frontUp = await supabase.storage.from('homeowner-uploads')
      .upload(frontPath, frontBytes, { contentType: front_mime, upsert: false })
    if (frontUp.error) throw frontUp.error

    let backPath: string | null = null
    if (back_base64 && back_mime) {
      if (!ALLOWED.test(back_mime)) return json({ error: 'bad_back_mime' }, 400)
      const backBytes = decodeDataUrl(back_base64)
      if (backBytes.byteLength > MAX_BYTES) return json({ error: 'back_too_large' }, 413)
      const safeBack = (back_filename || 'back.jpg').replace(/[^\w.\-]/g, '_')
      backPath = `${tok.tenant_id}/${tok.id}/${ts}-back-${safeBack}`
      const backUp = await supabase.storage.from('homeowner-uploads')
        .upload(backPath, backBytes, { contentType: back_mime, upsert: false })
      if (backUp.error) throw backUp.error
    }

    if (kind === 'check') {
      const { data: upRow, error: upErr } = await supabase
        .from('homeowner_ledger_check_uploads')
        .insert({
          tenant_id: tok.tenant_id,
          token_id: tok.id,
          claim_id: tok.claim_id,
          front_path: frontPath,
          back_path: backPath,
          amount_estimate: amount_estimate ?? null,
          homeowner_note: homeowner_note ?? null,
          partner_code: tok.partner_code ?? null,
          assigned_to_user_id: tok.sent_by_user_id ?? null,
        })
        .select('id')
        .single()
      if (upErr) throw upErr


      if (tok.claim_id) {
        await supabase.from('homeowner_ledger_events').insert({
          tenant_id: tok.tenant_id,
          claim_id: tok.claim_id,
          event_type: 'homeowner_check_upload',
          amount: amount_estimate ?? null,
          actor_label: 'Homeowner',
          payload_json: { upload_id: upRow.id, note: homeowner_note ?? null },
        })
      }

      return json({ ok: true, upload_id: upRow.id })
    }

    if (kind === 'production_doc') {
      if (!tok.claim_id) return json({ error: 'no_claim' }, 400)
      await supabase.from('homeowner_ledger_events').insert({
        tenant_id: tok.tenant_id,
        claim_id: tok.claim_id,
        event_type: 'production_doc_uploaded',
        actor_label: 'Homeowner',
        payload_json: { front_path: frontPath, note: homeowner_note ?? null },
      })
      return json({ ok: true })
    }

    return json({ error: 'unknown_kind' }, 400)
  } catch (e) {
    console.error('homeowner-ledger-upload error', e)
    return json({ error: 'server_error', message: String((e as Error).message) }, 500)
  }
})

function decodeDataUrl(input: string): Uint8Array {
  const b64 = input.includes(',') ? input.split(',', 2)[1] : input
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
