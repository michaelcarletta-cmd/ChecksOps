// deno-lint-ignore-file no-explicit-any
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3.23.8'

const BodySchema = z.object({ lead_id: z.string().uuid() })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

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
        'id, contractor_profile_id, contractor_user_id, homeowner_name, homeowner_email, homeowner_phone, property_zip, loss_type, message, created_at, access_token',
      )
      .eq('id', parsed.data.lead_id)
      .maybeSingle()



    if (error || !lead) {
      return new Response(JSON.stringify({ error: 'lead not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Anti-abuse: only fire for leads created in the last 5 minutes
    const ageMs = Date.now() - new Date(lead.created_at).getTime()
    if (ageMs > 5 * 60 * 1000) {
      return new Response(JSON.stringify({ ok: true, skipped: 'stale' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Look up contractor's email + display name
    const { data: profile } = await admin
      .from('contractor_profiles')
      .select('display_name')
      .eq('id', lead.contractor_profile_id)
      .maybeSingle()

    const { data: userLookup } = await admin.auth.admin.getUserById(lead.contractor_user_id)
    const contractorEmail = userLookup?.user?.email
    if (!contractorEmail) {
      return new Response(JSON.stringify({ error: 'contractor email missing' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const siteUrl = Deno.env.get('SITE_URL') || 'https://checksops.com'
    const invokeRes = await admin.functions.invoke('send-transactional-email', {
      body: {
        templateName: 'new-homeowner-lead',
        recipientEmail: contractorEmail,
        idempotencyKey: `homeowner-lead-${lead.id}`,
        templateData: {
          contractor_name: profile?.display_name ?? 'there',
          homeowner_name: lead.homeowner_name,
          homeowner_email: lead.homeowner_email,
          homeowner_phone: lead.homeowner_phone ?? '',
          property_zip: lead.property_zip ?? '',
          loss_type: lead.loss_type ?? '',
          message: lead.message ?? '',
          leads_url: `${siteUrl}/settings`,
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
