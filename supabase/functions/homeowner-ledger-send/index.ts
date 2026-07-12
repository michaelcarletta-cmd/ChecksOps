// Staff-authenticated. Creates/rotates a ledger token and emails the homeowner a magic link.
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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
    const {
      claim_id,
      homeowner_email,
      homeowner_phone,
      homeowner_name,
      rotate = false,
      tenant_id: tenantIdOverride,
      origin,
      partner_code: partnerCodeIn,
    } = await req.json()

    if (!homeowner_email && !homeowner_phone) {
      return json({ error: 'missing_contact' }, 400)
    }

    // Resolve tenant
    let tenantId = tenantIdOverride as string | undefined
    if (claim_id && !tenantId) {
      const { data: c } = await svc.from('claims').select('tenant_id').eq('id', claim_id).maybeSingle()
      tenantId = c?.tenant_id
    }
    if (!tenantId) {
      const { data: tu } = await svc.from('tenant_users').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle()
      tenantId = tu?.tenant_id
    }
    if (!tenantId) return json({ error: 'no_tenant' }, 400)

    // Confirm staff belongs to this tenant
    const { data: membership } = await svc.from('tenant_users')
      .select('user_id').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle()
    if (!membership) return json({ error: 'forbidden' }, 403)

    // Resolve partner code: use provided one (if valid for tenant) else first alias for this tenant
    let partnerCode: string | null = null
    if (partnerCodeIn) {
      const normalized = String(partnerCodeIn).trim().toUpperCase()
      const { data: alias } = await svc.from('tenant_partner_code_aliases')
        .select('code').eq('tenant_id', tenantId).ilike('code', normalized).maybeSingle()
      if (alias) partnerCode = alias.code
      else return json({ error: 'invalid_partner_code' }, 400)
    } else {
      const { data: firstAlias } = await svc.from('tenant_partner_code_aliases')
        .select('code').eq('tenant_id', tenantId).order('created_at').limit(1).maybeSingle()
      partnerCode = firstAlias?.code ?? null
    }

    // Reuse an existing active token for the same claim + email unless rotate requested
    let tokRow: any = null
    if (!rotate && claim_id && homeowner_email) {
      const { data: existing } = await svc.from('homeowner_ledger_tokens')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('claim_id', claim_id)
        .eq('homeowner_email', homeowner_email)
        .is('revoked_at', null)
        .maybeSingle()
      tokRow = existing
      if (tokRow && (tokRow.partner_code !== partnerCode || tokRow.sent_by_user_id !== userId)) {
        await svc.from('homeowner_ledger_tokens')
          .update({ partner_code: partnerCode, sent_by_user_id: userId })
          .eq('id', tokRow.id)
        tokRow.partner_code = partnerCode
        tokRow.sent_by_user_id = userId
      }
    }

    if (!tokRow) {
      const { data: created, error: cErr } = await svc.from('homeowner_ledger_tokens')
        .insert({
          tenant_id: tenantId,
          claim_id: claim_id ?? null,
          homeowner_email: homeowner_email ?? null,
          homeowner_phone: homeowner_phone ?? null,
          homeowner_name: homeowner_name ?? null,
          created_by: userId,
          sent_by_user_id: userId,
          partner_code: partnerCode,
        })
        .select('*')
        .single()
      if (cErr) throw cErr
      tokRow = created
    }


    const base = origin || 'https://checksops.com'
    const url = claim_id
      ? `${base}/ledger/${tokRow.token}`
      : `${base}/start-claim/${tokRow.token}`

    if (homeowner_email) {
      await svc.functions.invoke('send-transactional-email', {
        body: {
          templateName: 'homeowner-ledger-invite',
          recipientEmail: homeowner_email,
          idempotencyKey: `ledger-invite-${tokRow.id}-${Date.now()}`,
          templateData: {
            homeowner_name: homeowner_name || null,
            portal_url: url,
            is_pre_claim: !claim_id,
          },
        },
      }).catch((e) => console.error('email invoke failed', e))
    }

    return json({ ok: true, token: tokRow.token, url, partner_code: partnerCode })
  } catch (e) {
    console.error('homeowner-ledger-send error', e)
    return json({ error: 'server_error', message: String((e as Error).message) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
