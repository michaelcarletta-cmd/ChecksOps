// deno-lint-ignore-file no-explicit-any
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3.23.8'
import { normalizeUploadedCheckImage, originalSiblingPath } from '../_shared/normalizeUploadedCheckImage.ts'

const BUCKET = 'claim-files'
const MAX_BYTES = 15 * 1024 * 1024 // 15 MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])

const BodySchema = z.object({
  lead_id: z.string().uuid().nullable().optional(),
  contractor_profile_id: z.string().uuid(),
  file_base64: z.string().min(100),
  file_mime: z.string().max(60),
  filename: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
})

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.split(',').pop()! : b64
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'unauthenticated' }, 401)
    }
    const jwt = authHeader.slice('Bearer '.length)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { data: userRes, error: userErr } = await admin.auth.getUser(jwt)
    if (userErr || !userRes.user?.email) return json({ error: 'invalid session' }, 401)
    const homeownerEmail = userRes.user.email.toLowerCase()
    const homeownerUserId = userRes.user.id

    const parsed = BodySchema.safeParse(await req.json())
    if (!parsed.success) return json({ error: 'invalid body' }, 400)

    if (!ALLOWED_MIME.has(parsed.data.file_mime)) {
      return json({ error: 'unsupported file type' }, 400)
    }

    const bytes = base64ToBytes(parsed.data.file_base64)
    if (bytes.byteLength > MAX_BYTES) return json({ error: 'file too large (15 MB max)' }, 400)

    // Verify the contractor is a live directory listing
    const { data: profile } = await admin
      .from('contractor_profiles')
      .select('id, user_id, is_directory_listed, directory_opt_in, display_name')
      .eq('id', parsed.data.contractor_profile_id)
      .maybeSingle()
    if (!profile || !profile.is_directory_listed || !profile.directory_opt_in) {
      return json({ error: 'contractor not accepting uploads' }, 403)
    }

    // If lead is provided, confirm it belongs to this homeowner + this contractor
    if (parsed.data.lead_id) {
      const { data: lead } = await admin
        .from('homeowner_intro_requests')
        .select('id, homeowner_email, contractor_profile_id')
        .eq('id', parsed.data.lead_id)
        .maybeSingle()
      if (
        !lead ||
        lead.contractor_profile_id !== profile.id ||
        lead.homeowner_email.toLowerCase() !== homeownerEmail
      ) {
        return json({ error: 'lead does not match this session' }, 403)
      }
    }

    const ext = (parsed.data.filename?.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
    const objectName = `homeowner-uploads/${profile.user_id}/${parsed.data.lead_id ?? 'nolead'}/${crypto.randomUUID()}.${ext}`

    // Mandatory upload-time normalization so no oversized image ever lands in
    // storage. PDFs / HEIC pass through unchanged. If we compressed, the raw
    // upload is preserved at the `.original.<ext>` sibling for auditability.
    const normalized = await normalizeUploadedCheckImage(bytes, parsed.data.file_mime)
    if (normalized.compressed) {
      const origPath = originalSiblingPath(objectName)
      await admin.storage
        .from(BUCKET)
        .upload(origPath, bytes, { contentType: parsed.data.file_mime, upsert: false })
        .catch(() => { /* non-fatal */ })
      console.log(`[homeowner-upload-check] compressed ${normalized.originalBytes}B → ${normalized.finalBytes}B`)
    }

    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(objectName, normalized.bytes, { contentType: normalized.mime, upsert: false })
    if (upErr) return json({ error: 'upload failed', detail: upErr.message }, 500)

    const { data: row, error: insErr } = await admin
      .from('homeowner_check_uploads')
      .insert({
        lead_id: parsed.data.lead_id ?? null,
        contractor_profile_id: profile.id,
        contractor_user_id: profile.user_id,
        homeowner_email: homeownerEmail,
        homeowner_user_id: homeownerUserId,
        file_path: objectName,
        file_mime: normalized.mime,
        note: parsed.data.note ?? null,
      })
      .select('id')
      .single()
    if (insErr) return json({ error: 'db insert failed', detail: insErr.message }, 500)

    return json({ ok: true, id: row.id }, 200)
  } catch (e: any) {
    return json({ error: e.message ?? 'server error' }, 500)
  }
})

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
