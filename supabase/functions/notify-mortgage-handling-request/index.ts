// deno-lint-ignore-file no-explicit-any
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3.23.8'

const BodySchema = z.object({ request_id: z.string().uuid() })

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

    const { data: request, error } = await admin
      .from('mortgage_handling_requests')
      .select('id, tenant_id, check_intake_item_id, mortgage_company, loan_number, note, status, created_at')
      .eq('id', parsed.data.request_id)
      .maybeSingle()

    if (error || !request) {
      return new Response(JSON.stringify({ error: 'request not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const [{ data: tenant }, { data: check }, { data: config }] = await Promise.all([
      admin.from('tenants').select('name, slug').eq('id', request.tenant_id).maybeSingle(),
      admin.from('check_intake_items').select('check_number, claim_id').eq('id', request.check_intake_item_id).maybeSingle(),
      admin.from('mortgage_desk_config').select('notification_email').eq('id', true).maybeSingle(),
    ])

    const to = config?.notification_email?.trim()
    const resendKey = Deno.env.get('RESEND_API_KEY')

    if (!to || !resendKey) {
      return new Response(JSON.stringify({
        ok: true,
        emailed: false,
        reason: !to ? 'no notification_email configured' : 'RESEND_API_KEY missing',
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const siteUrl = Deno.env.get('SITE_URL') || 'https://checksops.com'
    const opsUrl = `${siteUrl.replace(/\/$/, '')}/admin/mortgage-desk`
    const subject = `New mortgage handling request — ${tenant?.name ?? 'tenant'}`
    const html = `
      <h2>New mortgage handling request</h2>
      <p><strong>Tenant:</strong> ${escapeHtml(tenant?.name ?? '—')}</p>
      <p><strong>Mortgage company:</strong> ${escapeHtml(request.mortgage_company ?? '—')}</p>
      <p><strong>Loan #:</strong> ${escapeHtml(request.loan_number ?? '—')}</p>
      <p><strong>Check #:</strong> ${escapeHtml(check?.check_number ?? '—')}</p>
      ${request.note ? `<p><strong>Note:</strong> ${escapeHtml(request.note)}</p>` : ''}
      <p><a href="${opsUrl}">Open ops queue →</a></p>
    `

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `mortgage-req-${request.id}`,
      },
      body: JSON.stringify({
        from: 'ChecksOps <notifications@checksops.com>',
        to: [to],
        subject,
        html,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      return new Response(JSON.stringify({ ok: false, emailed: false, error: errText }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ ok: true, emailed: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!))
}
