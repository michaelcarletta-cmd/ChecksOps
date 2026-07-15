// deno-lint-ignore-file no-explicit-any
// Public, token-gated homeowner portal. No login required.
// Actions: get | upload_check | sign_dtp | list_actions | complete_action
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3.23.8'
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1'

const BUCKET = 'claim-files'
const LOSS_DRAFT_BUCKET = 'loss-draft-documents'
const MAX_BYTES = 15 * 1024 * 1024
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
])
const ACTION_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const TOKEN_RE = /^[a-f0-9]{32,80}$/i

const Body = z.object({
  token: z.string().regex(TOKEN_RE),
  action: z.enum(['get', 'upload_check', 'sign_dtp', 'list_actions', 'complete_action', 'sign_document', 'submit_mortgage_intake']),
  file_base64: z.string().min(100).optional(),
  file_mime: z.string().max(120).optional(),
  filename: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
  signature_name: z.string().trim().min(2).max(120).optional(),
  insurance_carrier: z.string().trim().max(120).optional(),
  claim_number: z.string().trim().max(80).optional(),
  policy_number: z.string().trim().max(80).optional(),
  property_address: z.string().trim().max(240).optional(),
  doc_id: z.string().uuid().optional(),
  agree: z.boolean().optional(),
  intake: z.object({
    mortgage_servicer: z.string().trim().min(2).max(160),
    loan_number: z.string().trim().max(80).optional(),
    servicer_phone: z.string().trim().max(40).optional(),
    borrower_names: z.string().trim().min(2).max(240),
    mailing_address: z.string().trim().max(300).optional(),
    ssn_last4: z.string().trim().regex(/^\d{4}$/).optional(),
    notes: z.string().trim().max(1000).optional(),
  }).optional(),
})

async function resolveLossDraftIds(admin: any, leadId: string, dtpClaimNumber: string | null, contractorUserId: string | null): Promise<string[]> {
  const checkIds = new Set<string>()
  const { data: linked } = await admin
    .from('check_intake_items')
    .select('id')
    .eq('lead_id', leadId)
  for (const r of linked ?? []) checkIds.add(r.id)

  if (dtpClaimNumber && contractorUserId) {
    const { data: tenants } = await admin
      .from('tenant_users').select('tenant_id').eq('user_id', contractorUserId)
    const tenantIds = (tenants ?? []).map((t: any) => t.tenant_id).filter(Boolean)
    if (tenantIds.length) {
      const { data: rows } = await admin
        .from('check_intake_items').select('id').in('tenant_id', tenantIds)
        .or(`detected_claim_number.eq.${dtpClaimNumber},freedom_claim_number.eq.${dtpClaimNumber}`)
      for (const r of rows ?? []) checkIds.add(r.id)
    }
  }
  if (!checkIds.size) return []
  const { data: lds } = await admin
    .from('loss_draft_tracking').select('id')
    .in('check_intake_item_id', Array.from(checkIds))
  return (lds ?? []).map((r: any) => r.id)
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.split(',').pop()! : b64
  const bin = atob(clean)
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return json({ error: 'invalid body' }, 400)
    const p = parsed.data

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Resolve the claim by token
    const { data: lead, error: leadErr } = await admin
      .from('homeowner_intro_requests')
      .select(
        'id, contractor_profile_id, contractor_user_id, homeowner_name, homeowner_email, homeowner_phone, property_zip, loss_type, message, status, accepted_at, created_at, dtp_signed_at, dtp_signature_name, dtp_insurance_carrier, dtp_claim_number, dtp_policy_number, dtp_property_address',
      )
      .eq('access_token', p.token)
      .maybeSingle()
    if (leadErr || !lead) return json({ error: 'invalid or expired link' }, 404)

    const { data: profile } = await admin
      .from('contractor_profiles')
      .select('id, display_name, bio, tier, is_directory_listed, directory_opt_in, user_id')
      .eq('id', lead.contractor_profile_id)
      .maybeSingle()

    // The portal is inert until the contractor accepts the lead.
    const isAccepted = lead.status === 'accepted' && !!lead.accepted_at
    if (!isAccepted) {
      if (p.action === 'get') {
        return json({
          ok: true,
          pending: true,
          lead: {
            id: lead.id,
            homeowner_name: lead.homeowner_name,
            status: lead.status,
            accepted_at: lead.accepted_at,
            created_at: lead.created_at,
          },
          contractor: profile
            ? { id: profile.id, display_name: profile.display_name, tier: profile.tier }
            : null,
        })
      }
      return json({ error: 'contractor has not accepted this request yet' }, 403)
    }

    if (p.action === 'get') {
      const { data: uploads } = await admin
        .from('homeowner_check_uploads')
        .select('id, file_path, status, note, created_at')
        .eq('lead_id', lead.id)
        .order('created_at', { ascending: false })

      // Live check pipeline: prefer explicit lead_id link (contractor
      // manually tied a check to this lead), then fall back to matching by
      // the homeowner's DTP claim number within the contractor's tenants.
      const checkMap = new Map<string, any>()
      const selectCols =
        'id, amount, check_number, carrier_name, payee_line, check_stage, status, deposited_at, created_at, updated_at, lead_id'

      const { data: linkedRows } = await admin
        .from('check_intake_items')
        .select(selectCols)
        .eq('lead_id', lead.id)
        .order('created_at', { ascending: false })
        .limit(20)
      for (const r of linkedRows ?? []) checkMap.set(r.id, r)

      if (lead.dtp_claim_number && profile?.user_id) {
        const { data: tenants } = await admin
          .from('tenant_users')
          .select('tenant_id')
          .eq('user_id', profile.user_id)
        const tenantIds = (tenants ?? []).map((t: any) => t.tenant_id).filter(Boolean)
        if (tenantIds.length) {
          const { data: rows } = await admin
            .from('check_intake_items')
            .select(selectCols)
            .in('tenant_id', tenantIds)
            .or(
              `detected_claim_number.eq.${lead.dtp_claim_number},freedom_claim_number.eq.${lead.dtp_claim_number}`,
            )
            .order('created_at', { ascending: false })
            .limit(20)
          for (const r of rows ?? []) if (!checkMap.has(r.id)) checkMap.set(r.id, r)
        }
      }
      const checks = Array.from(checkMap.values())

      // Homeowner "Action needed" — pending loss draft docs assigned to the homeowner.
      let actions: any[] = []
      const lossDraftIds = await resolveLossDraftIds(
        admin, lead.id, lead.dtp_claim_number ?? null, profile?.user_id ?? null,
      )
      if (lossDraftIds.length) {
        const { data: docs } = await admin
          .from('loss_draft_documents')
          .select('id, document_type, document_label, requires_signature, signature_status, is_submitted')
          .in('loss_draft_id', lossDraftIds)
          .eq('signer_role', 'homeowner')
          .eq('is_submitted', false)
          .order('created_at', { ascending: true })
        actions = (docs ?? []).map((d: any) => ({
          id: d.id,
          label: d.document_label,
          document_type: d.document_type,
          requires_signature: !!d.requires_signature,
          signature_status: d.signature_status,
          kind: d.document_type === 'mortgage_intake'
            ? 'intake_form'
            : d.requires_signature ? 'signature' : 'upload',
        }))
      }

      return json({
        ok: true,
        lead: {
          id: lead.id,
          homeowner_name: lead.homeowner_name,
          homeowner_email: lead.homeowner_email,
          property_zip: lead.property_zip,
          loss_type: lead.loss_type,
          status: lead.status,
          created_at: lead.created_at,
          dtp_signed_at: lead.dtp_signed_at,
          dtp_signature_name: lead.dtp_signature_name,
          dtp_insurance_carrier: lead.dtp_insurance_carrier,
          dtp_claim_number: lead.dtp_claim_number,
          dtp_policy_number: lead.dtp_policy_number,
          dtp_property_address: lead.dtp_property_address,
        },
        contractor: profile
          ? {
              id: profile.id,
              display_name: profile.display_name,
              bio: profile.bio,
              tier: profile.tier,
            }
          : null,
        uploads: uploads ?? [],
        checks,
        actions,
      })
    }

    if (p.action === 'list_actions') {
      const lossDraftIds = await resolveLossDraftIds(
        admin, lead.id, lead.dtp_claim_number ?? null, profile?.user_id ?? null,
      )
      if (!lossDraftIds.length) return json({ ok: true, actions: [] })
      const { data: docs } = await admin
        .from('loss_draft_documents')
        .select('id, document_type, document_label, requires_signature, signature_status, is_submitted')
        .in('loss_draft_id', lossDraftIds)
        .eq('signer_role', 'homeowner')
        .eq('is_submitted', false)
        .order('created_at', { ascending: true })
      return json({
        ok: true,
        actions: (docs ?? []).map((d: any) => ({
          id: d.id,
          label: d.document_label,
          document_type: d.document_type,
          requires_signature: !!d.requires_signature,
          signature_status: d.signature_status,
          kind: d.document_type === 'mortgage_intake'
            ? 'intake_form'
            : d.requires_signature ? 'signature' : 'upload',
        })),
      })
    }


    if (!profile || !profile.is_directory_listed || !profile.directory_opt_in) {
      return json({ error: 'contractor not accepting activity' }, 403)
    }

    if (p.action === 'upload_check') {
      if (!p.file_base64 || !p.file_mime) return json({ error: 'file required' }, 400)
      if (!ALLOWED_MIME.has(p.file_mime)) return json({ error: 'unsupported file type' }, 400)
      const bytes = b64ToBytes(p.file_base64)
      if (bytes.byteLength > MAX_BYTES) return json({ error: 'file too large (15 MB max)' }, 400)

      const ext =
        (p.filename?.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
      const objectName = `homeowner-uploads/${profile.user_id}/${lead.id}/${crypto.randomUUID()}.${ext}`

      const { error: upErr } = await admin.storage
        .from(BUCKET)
        .upload(objectName, bytes, { contentType: p.file_mime, upsert: false })
      if (upErr) return json({ error: 'upload failed', detail: upErr.message }, 500)

      const { data: row, error: insErr } = await admin
        .from('homeowner_check_uploads')
        .insert({
          lead_id: lead.id,
          contractor_profile_id: profile.id,
          contractor_user_id: profile.user_id,
          homeowner_email: lead.homeowner_email.toLowerCase(),
          file_path: objectName,
          file_mime: p.file_mime,
          note: p.note ?? null,
        })
        .select('id')
        .single()
      if (insErr) return json({ error: 'db insert failed', detail: insErr.message }, 500)

      return json({ ok: true, id: row.id })
    }

    if (p.action === 'sign_dtp') {
      if (!p.signature_name) return json({ error: 'signature name required' }, 400)
      const ip =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('cf-connecting-ip') ??
        null
      const ua = req.headers.get('user-agent') ?? null

      const { error: updErr } = await admin
        .from('homeowner_intro_requests')
        .update({
          dtp_signed_at: new Date().toISOString(),
          dtp_signature_name: p.signature_name,
          dtp_signature_ip: ip,
          dtp_signature_user_agent: ua,
          dtp_insurance_carrier: p.insurance_carrier ?? null,
          dtp_claim_number: p.claim_number ?? null,
          dtp_policy_number: p.policy_number ?? null,
          dtp_property_address: p.property_address ?? null,
        })
        .eq('id', lead.id)
      if (updErr) return json({ error: 'could not save signature', detail: updErr.message }, 500)

      return json({ ok: true })
    }

    if (p.action === 'complete_action') {
      if (!p.doc_id) return json({ error: 'doc_id required' }, 400)
      const lossDraftIds = await resolveLossDraftIds(
        admin, lead.id, lead.dtp_claim_number ?? null, profile?.user_id ?? null,
      )
      if (!lossDraftIds.length) return json({ error: 'no matching loss draft' }, 404)

      const { data: doc, error: docErr } = await admin
        .from('loss_draft_documents')
        .select('id, loss_draft_id, signer_role, requires_signature, document_label')
        .eq('id', p.doc_id)
        .maybeSingle()
      if (docErr || !doc) return json({ error: 'document not found' }, 404)
      if (!lossDraftIds.includes(doc.loss_draft_id) || doc.signer_role !== 'homeowner') {
        return json({ error: 'not authorized for this document' }, 403)
      }

      let filePath: string | null = null
      let fileName: string | null = null
      if (p.file_base64) {
        if (!p.file_mime || !ACTION_MIME.has(p.file_mime)) {
          return json({ error: 'unsupported file type' }, 400)
        }
        const bytes = b64ToBytes(p.file_base64)
        if (bytes.byteLength > MAX_BYTES) return json({ error: 'file too large (15 MB max)' }, 400)
        const ext = (p.filename?.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
        filePath = `${doc.loss_draft_id}/${doc.id}/${crypto.randomUUID()}.${ext}`
        fileName = p.filename ?? `${doc.document_label}.${ext}`
        const { error: upErr } = await admin.storage
          .from(LOSS_DRAFT_BUCKET)
          .upload(filePath, bytes, { contentType: p.file_mime, upsert: true })
        if (upErr) return json({ error: 'upload failed', detail: upErr.message }, 500)
      } else if (!doc.requires_signature) {
        return json({ error: 'file required' }, 400)
      }

      const patch: Record<string, unknown> = {
        is_submitted: true,
        submitted_at: new Date().toISOString(),
      }
      if (filePath) {
        patch.file_path = filePath
        patch.file_name = fileName
      }

      const { error: updErr } = await admin
        .from('loss_draft_documents')
        .update(patch)
        .eq('id', doc.id)
      if (updErr) return json({ error: 'could not save', detail: updErr.message }, 500)

      return json({ ok: true })
    }

    if (p.action === 'sign_document') {
      if (!p.doc_id) return json({ error: 'doc_id required' }, 400)
      if (!p.signature_name) return json({ error: 'signature name required' }, 400)
      if (!p.agree) return json({ error: 'agreement required' }, 400)

      const lossDraftIds = await resolveLossDraftIds(
        admin, lead.id, lead.dtp_claim_number ?? null, profile?.user_id ?? null,
      )
      if (!lossDraftIds.length) return json({ error: 'no matching loss draft' }, 404)

      const { data: doc, error: docErr } = await admin
        .from('loss_draft_documents')
        .select('id, loss_draft_id, signer_role, requires_signature, document_type, document_label')
        .eq('id', p.doc_id)
        .maybeSingle()
      if (docErr || !doc) return json({ error: 'document not found' }, 404)
      if (!lossDraftIds.includes(doc.loss_draft_id) || doc.signer_role !== 'homeowner' || !doc.requires_signature) {
        return json({ error: 'not authorized for this document' }, 403)
      }

      const { data: ldRow } = await admin
        .from('loss_draft_tracking')
        .select('mortgage_servicer, loan_number')
        .eq('id', doc.loss_draft_id)
        .maybeSingle()

      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? req.headers.get('cf-connecting-ip') ?? null
      const ua = req.headers.get('user-agent') ?? null
      const signedAt = new Date()

      // Build a signed PDF for the document (LPOA / authorization letter / etc.)
      const pdf = await PDFDocument.create()
      const page = pdf.addPage([612, 792])
      const font = await pdf.embedFont(StandardFonts.Helvetica)
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
      const script = await pdf.embedFont(StandardFonts.TimesRomanItalic)
      const black = rgb(0, 0, 0)
      const gray = rgb(0.35, 0.35, 0.35)

      const draw = (text: string, x: number, y: number, size = 11, f = font, color = black) =>
        page.drawText(text, { x, y, size, font: f, color })

      draw(doc.document_label, 54, 740, 18, bold)
      draw('Homeowner authorization — executed via ChecksOps homeowner portal', 54, 720, 10, font, gray)

      let y = 690
      const bodyLines = [
        `I, ${p.signature_name}, the homeowner and named insured, authorize`,
        `${profile?.display_name ?? 'my contractor'} and ChecksOps to act on my behalf with`,
        `my mortgage servicer${ldRow?.mortgage_servicer ? ` (${ldRow.mortgage_servicer})` : ''} regarding the`,
        `insurance loss draft check for my property${lead.dtp_property_address ? ` at ${lead.dtp_property_address}` : ''}.`,
        ``,
        `This authorization covers requesting endorsement, providing required loss`,
        `draft documentation, requesting draw releases, and exchanging status`,
        `information related to loan${ldRow?.loan_number ? ` #${ldRow.loan_number}` : ''}${lead.dtp_claim_number ? ` and claim #${lead.dtp_claim_number}` : ''}.`,
        ``,
        `This authorization is limited to the above loss and remains in effect`,
        `until I revoke it in writing.`,
      ]
      for (const line of bodyLines) { draw(line, 54, y, 11); y -= 16 }

      y -= 24
      draw('Signature', 54, y, 10, bold, gray); y -= 22
      draw(p.signature_name, 54, y, 22, script); y -= 6
      page.drawLine({ start: { x: 54, y: y }, end: { x: 300, y }, thickness: 0.5, color: gray })
      y -= 14
      draw(`Typed name: ${p.signature_name}`, 54, y, 10); y -= 14
      draw(`Signed: ${signedAt.toISOString()}`, 54, y, 10); y -= 14
      if (ip) { draw(`IP: ${ip}`, 54, y, 10); y -= 14 }
      draw(`Document: ${doc.document_type ?? 'signed_document'} · ${doc.id}`, 54, y, 8, font, gray)

      const pdfBytes = await pdf.save()
      const filePath = `${doc.loss_draft_id}/${doc.id}/signed-${crypto.randomUUID()}.pdf`
      const fileName = `${doc.document_label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-signed.pdf`

      const { error: upErr } = await admin.storage
        .from(LOSS_DRAFT_BUCKET)
        .upload(filePath, pdfBytes, { contentType: 'application/pdf', upsert: true })
      if (upErr) return json({ error: 'upload failed', detail: upErr.message }, 500)

      const { error: updErr } = await admin
        .from('loss_draft_documents')
        .update({
          is_submitted: true,
          submitted_at: signedAt.toISOString(),
          signed_at: signedAt.toISOString(),
          signature_status: 'signed',
          file_path: filePath,
          file_name: fileName,
          notes: `E-signed by ${p.signature_name}${ip ? ` from ${ip}` : ''}${ua ? ` · ${ua.slice(0, 120)}` : ''}`,
        })
        .eq('id', doc.id)
      if (updErr) return json({ error: 'could not save', detail: updErr.message }, 500)

      return json({ ok: true })
    }

    if (p.action === 'submit_mortgage_intake') {
      if (!p.doc_id) return json({ error: 'doc_id required' }, 400)
      if (!p.intake) return json({ error: 'intake fields required' }, 400)
      if (!p.signature_name) return json({ error: 'signature name required' }, 400)

      const lossDraftIds = await resolveLossDraftIds(
        admin, lead.id, lead.dtp_claim_number ?? null, profile?.user_id ?? null,
      )
      if (!lossDraftIds.length) return json({ error: 'no matching loss draft' }, 404)

      const { data: doc, error: docErr } = await admin
        .from('loss_draft_documents')
        .select('id, loss_draft_id, signer_role, document_type, document_label')
        .eq('id', p.doc_id)
        .maybeSingle()
      if (docErr || !doc) return json({ error: 'document not found' }, 404)
      if (!lossDraftIds.includes(doc.loss_draft_id) || doc.signer_role !== 'homeowner' || doc.document_type !== 'mortgage_intake') {
        return json({ error: 'not authorized for this document' }, 403)
      }

      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? req.headers.get('cf-connecting-ip') ?? null
      const ua = req.headers.get('user-agent') ?? null
      const now = new Date().toISOString()

      const { error: upsertErr } = await admin
        .from('loss_draft_mortgage_intake')
        .upsert({
          loss_draft_id: doc.loss_draft_id,
          lead_id: lead.id,
          loss_draft_document_id: doc.id,
          mortgage_servicer: p.intake.mortgage_servicer,
          loan_number: p.intake.loan_number ?? null,
          servicer_phone: p.intake.servicer_phone ?? null,
          borrower_names: p.intake.borrower_names,
          mailing_address: p.intake.mailing_address ?? null,
          ssn_last4: p.intake.ssn_last4 ?? null,
          notes: p.intake.notes ?? null,
          signer_name: p.signature_name,
          signer_ip: ip,
          signer_user_agent: ua,
        }, { onConflict: 'loss_draft_id' })
      if (upsertErr) return json({ error: 'could not save intake', detail: upsertErr.message }, 500)

      // Also seed the loss_draft_tracking servicer/loan fields if empty
      await admin
        .from('loss_draft_tracking')
        .update({
          mortgage_servicer: p.intake.mortgage_servicer,
          loan_number: p.intake.loan_number ?? null,
        })
        .eq('id', doc.loss_draft_id)
        .or('mortgage_servicer.is.null,mortgage_servicer.ilike.%unknown%')

      const { error: updErr } = await admin
        .from('loss_draft_documents')
        .update({
          is_submitted: true,
          submitted_at: now,
          notes: `Mortgage intake submitted by ${p.signature_name}${ip ? ` from ${ip}` : ''}`,
        })
        .eq('id', doc.id)
      if (updErr) return json({ error: 'could not mark complete', detail: updErr.message }, 500)

      return json({ ok: true })
    }

    return json({ error: 'unknown action' }, 400)
  } catch (e: any) {
    return json({ error: e.message ?? 'server error' }, 500)
  }
})
