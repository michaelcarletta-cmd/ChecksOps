// deno-lint-ignore-file no-explicit-any
// Sends the homeowner their private claim-portal link ONLY after the
// contractor/PA has accepted the lead (status = 'accepted', accepted_at set).
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3.23.8'

const BodySchema = z.object({ lead_id: z.string().uuid() })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const parsed = BodySchema.safeParse(await req.json())
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'invalid body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data: lead, error } = await admin
      .from('homeowner_intro_requests')
      .select(
        'id, contractor_profile_id, contractor_user_id, homeowner_name, homeowner_email, status, accepted_at, access_token',
      )
      .eq('id', parsed.data.lead_id)
      .maybeSingle()

    if (error || !lead) {
      return new Response(JSON.stringify({ error: 'lead not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Require the contractor to have accepted before we share the portal link.
    if (lead.status !== 'accepted' || !lead.accepted_at) {
      return new Response(
        JSON.stringify({ error: 'lead not yet accepted' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Verify the caller is the contractor who owns this lead
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    const { data: userLookup } = await admin.auth.getUser(jwt)
    if (!userLookup?.user || userLookup.user.id !== lead.contractor_user_id) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: profile } = await admin
      .from('contractor_profiles')
      .select('display_name')
      .eq('id', lead.contractor_profile_id)
      .maybeSingle()

    const siteUrl = Deno.env.get('SITE_URL') || 'https://checksops.com'
    const portalUrl = `${siteUrl}/h/claim/${lead.access_token}`

    const invokeRes = await admin.functions.invoke('send-transactional-email', {
      body: {
        templateName: 'homeowner-claim-portal-link',
        recipientEmail: lead.homeowner_email,
        idempotencyKey: `homeowner-portal-${lead.id}`,
        templateData: {
          homeowner_name: lead.homeowner_name?.split(' ')[0] ?? '',
          contractor_name: profile?.display_name ?? 'your contractor',
          portal_url: portalUrl,
        },
      },
    })

    if (invokeRes.error) {
      return new Response(
        JSON.stringify({ error: 'send failed', detail: invokeRes.error.message }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message ?? 'server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
