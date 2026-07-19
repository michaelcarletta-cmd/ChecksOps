// Shares a check_file with the homeowner: creates a signed URL, posts to the
// homeowner_ledger_events timeline, and emails the homeowner from ChecksOps.
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const BUCKET = 'claim-files'
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 14 // 14 days

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

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
    const { check_file_id, note } = await req.json()
    if (!check_file_id) return json({ error: 'missing_check_file_id' }, 400)

    const { data: file, error: fErr } = await svc
      .from('check_files')
      .select('id, file_name, file_path, file_type, check_intake_item_id, description')
      .eq('id', check_file_id)
      .maybeSingle()
    if (fErr || !file) return json({ error: 'file_not_found' }, 404)

    const { data: check } = await svc
      .from('check_intake_items')
      .select('id, claim_id, tenant_id')
      .eq('id', file.check_intake_item_id)
      .maybeSingle()
    if (!check?.claim_id || !check?.tenant_id) return json({ error: 'check_not_linked_to_claim' }, 400)

    // Authorization: tenant member OR mortgage_agent/admin tied to this claim
    const { data: membership } = await svc.from('tenant_users')
      .select('user_id').eq('user_id', userId).eq('tenant_id', check.tenant_id).maybeSingle()
    if (!membership) {
      const { data: roles } = await svc.from('user_roles').select('role').eq('user_id', userId)
      const isOps = (roles ?? []).some((r: any) => r.role === 'mortgage_agent' || r.role === 'admin')
      let opsAllowed = false
      if (isOps) {
        const { data: mreq } = await svc.from('mortgage_handling_requests')
          .select('id').eq('claim_id', check.claim_id).eq('tenant_id', check.tenant_id).limit(1).maybeSingle()
        opsAllowed = !!mreq
      }
      if (!opsAllowed) return json({ error: 'forbidden' }, 403)
    }

    // Find the active homeowner ledger token for this claim
    const { data: tok } = await svc
      .from('homeowner_ledger_tokens')
      .select('token, homeowner_email, homeowner_name')
      .eq('tenant_id', check.tenant_id)
      .eq('claim_id', check.claim_id)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!tok?.homeowner_email) {
      return json({ error: 'no_homeowner_link', message: 'Send the homeowner their portal link first.' }, 400)
    }

    // Signed URL for the file
    const { data: signed } = await svc.storage.from(BUCKET).createSignedUrl(file.file_path, SIGNED_URL_TTL_SECONDS)
    const fileUrl = signed?.signedUrl ?? null

    const portalUrl = `https://checksops.com/ledger/${tok.token}`

    // Timeline event
    await svc.from('homeowner_ledger_events').insert({
      tenant_id: check.tenant_id,
      claim_id: check.claim_id,
      check_id: file.check_intake_item_id,
      event_type: 'document_shared',
      actor_label: 'Claim team',
      payload_json: {
        title: `Document shared: ${file.file_name}`,
        description: note || null,
        file_name: file.file_name,
        file_url: fileUrl,
        check_file_id: file.id,
      },
      created_by: userId,
    } as any)

    // Email
    await svc.functions.invoke('send-transactional-email', {
      body: {
        templateName: 'homeowner-document-shared',
        recipientEmail: tok.homeowner_email,
        senderOverride: 'checksops',
        idempotencyKey: `doc-shared-${file.id}-${Date.now()}`,
        templateData: {
          homeowner_name: tok.homeowner_name || null,
          portal_url: portalUrl,
          document_name: file.file_name,
          document_url: fileUrl,
          note: note || null,
        },
      },
    }).catch((e) => console.error('email invoke failed', e))

    return json({ ok: true, portal_url: portalUrl })
  } catch (e) {
    console.error('send-file-to-homeowner error', e)
    return json({ error: 'server_error', message: String((e as Error).message) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
