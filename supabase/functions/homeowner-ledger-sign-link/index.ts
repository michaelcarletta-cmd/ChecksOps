// Public endpoint. Mints a fresh sign link for a signer belonging to the
// claim referenced by a valid homeowner ledger token, when that signer's
// email matches the homeowner on the ledger token.
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function generateRawToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const body = await req.json().catch(() => ({}))
    const token = body?.token as string | undefined
    const signer_id = body?.signer_id as string | undefined
    if (!token || !signer_id) return json({ error: 'missing_params' }, 400)

    const { data: tok } = await supabase
      .from('homeowner_ledger_tokens')
      .select('id, claim_id, homeowner_email, revoked_at, expires_at')
      .eq('token', token)
      .maybeSingle()
    if (!tok) return json({ error: 'not_found' }, 404)
    if (tok.revoked_at) return json({ error: 'revoked' }, 410)
    if (tok.expires_at && new Date(tok.expires_at) < new Date()) return json({ error: 'expired' }, 410)
    if (!tok.claim_id) return json({ error: 'no_claim' }, 400)

    const { data: signer } = await supabase
      .from('signature_signers')
      .select('id, signer_email, status, signature_request_id, signature_requests!inner(claim_id)')
      .eq('id', signer_id)
      .maybeSingle()
    if (!signer) return json({ error: 'signer_not_found' }, 404)
    const reqClaim = (signer as any).signature_requests?.claim_id
    if (reqClaim !== tok.claim_id) return json({ error: 'mismatch' }, 403)
    if (signer.status === 'signed') return json({ error: 'already_signed' }, 409)

    const homeownerEmail = (tok.homeowner_email || '').toLowerCase()
    if ((signer.signer_email || '').toLowerCase() !== homeownerEmail) {
      return json({ error: 'not_your_signature' }, 403)
    }

    const rawToken = generateRawToken()
    const tokenHash = await hashToken(rawToken)
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

    await supabase.from('signature_signers').update({
      token_hash: tokenHash,
      expires_at: expiresAt,
    }).eq('id', signer.id)

    const appUrl = (Deno.env.get('SIGN_BASE_URL') || 'https://checksops.com').replace(/\/$/, '')
    return json({ ok: true, sign_url: `${appUrl}/sign?token=${rawToken}` })
  } catch (e) {
    console.error('homeowner-ledger-sign-link error', e)
    return json({ error: 'server_error', message: String((e as Error).message) }, 500)
  }
})
