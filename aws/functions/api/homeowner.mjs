/**
 * HomeownerOps Class A services (non-financial).
 * Public token routes + staff send/upload helpers.
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { withIdentity, parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { normalizeEmail } from './email-policy.mjs';

const { Client } = pg;
const s3 = () => new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const filesBucket = () => process.env.FILES_BUCKET || '';

const publicDb = async (write = false) => {
  const credentials = await loadDatabaseCredentials();
  const config = write
    ? buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 })
    : buildClientConfig(credentials, { queryTimeoutMillis: 12000 });
  const client = new Client(config);
  await client.connect();
  return client;
};

export const handleHomeownerLedgerView = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const qs = event.queryStringParameters || {};
  const token = String(body.token || qs.token || '').trim();
  if (!token || token.length < 8) {
    return { ok: false, statusCode: 400, error: 'invalid_token', spoofFieldsIgnored: spoof };
  }
  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const doc = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_by_token($1) AS doc',
      [token],
    )).rows[0]?.doc;
    if (!doc) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
    }
    if (doc.error) {
      await client.query('ROLLBACK');
      const status = doc.error === 'revoked' || doc.error === 'expired' ? 410 : 400;
      return { ok: false, statusCode: status, error: doc.error, spoofFieldsIgnored: spoof };
    }
    await client.query('COMMIT');
    return {
      ok: true,
      statusCode: 200,
      ...doc,
      // Keep money movement CTAs off
      allow_deductible_payment: false,
      money: null,
      deductible_payments: [],
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'ledger_view_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerClaimPortal = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  const action = body.action || 'get';
  if (!/^[a-f0-9]{32,80}$/i.test(token)) {
    return { ok: false, statusCode: 400, error: 'invalid body', spoofFieldsIgnored: spoof };
  }

  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const doc = (await client.query(
      'SELECT public.aws_public_homeowner_claim_by_token($1) AS doc',
      [token],
    )).rows[0]?.doc;
    if (!doc) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'invalid or expired link', spoofFieldsIgnored: spoof };
    }

    if (doc.pending) {
      if (action === 'get') {
        await client.query('COMMIT');
        return {
          ok: true,
          statusCode: 200,
          pending: true,
          lead: {
            id: doc.lead?.id,
            homeowner_name: doc.lead?.homeowner_name,
            status: doc.lead?.status,
            accepted_at: doc.lead?.accepted_at,
            created_at: doc.lead?.created_at,
          },
          contractor: doc.contractor
            ? { id: doc.contractor.id, display_name: doc.contractor.display_name, tier: doc.contractor.tier }
            : null,
          spoofFieldsIgnored: spoof,
        };
      }
      await client.query('ROLLBACK');
      return {
        ok: false,
        statusCode: 403,
        error: 'contractor has not accepted this request yet',
        spoofFieldsIgnored: spoof,
      };
    }

    if (action === 'get' || action === 'list_actions') {
      await client.query('COMMIT');
      return {
        ok: true,
        statusCode: 200,
        pending: false,
        lead: doc.lead,
        contractor: doc.contractor,
        uploads: doc.uploads || [],
        actions: action === 'list_actions' ? [] : undefined,
        allow_deductible_payment: false,
        spoofFieldsIgnored: spoof,
      };
    }

    if (action === 'upload_check') {
      const b64 = String(body.file_base64 || '');
      if (b64.length < 100) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 400, error: 'missing_file', spoofFieldsIgnored: spoof };
      }
      const mime = String(body.file_mime || 'image/jpeg').slice(0, 120);
      const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
      if (!allowed.has(mime)) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 400, error: 'unsupported_mime', spoofFieldsIgnored: spoof };
      }
      const clean = b64.includes(',') ? b64.split(',').pop() : b64;
      const bytes = Buffer.from(clean, 'base64');
      if (bytes.length > 15 * 1024 * 1024) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 400, error: 'file_too_large', spoofFieldsIgnored: spoof };
      }
      const filename = String(body.filename || `homeowner-upload-${Date.now()}.jpg`).slice(0, 200);
      const rel = `homeowner/${doc.lead.id}/${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const key = s3KeyFor('homeowner-uploads', rel);
      if (!filesBucket() || !key) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 503, error: 's3_not_configured', spoofFieldsIgnored: spoof };
      }
      await s3().send(new PutObjectCommand({
        Bucket: filesBucket(),
        Key: key,
        Body: bytes,
        ContentType: mime,
      }));
      const inserted = (await client.query(
        `INSERT INTO public.homeowner_check_uploads (lead_id, file_path, status, note, created_at)
         VALUES ($1::uuid, $2, 'uploaded', $3, now())
         RETURNING id, file_path, status, created_at`,
        [doc.lead.id, rel, body.note || null],
      )).rows[0];
      await client.query('COMMIT');
      return {
        ok: true,
        statusCode: 200,
        upload: inserted,
        spoofFieldsIgnored: spoof,
      };
    }

    if (action === 'submit_mortgage_intake' || action === 'sign_dtp' || action === 'complete_action' || action === 'sign_document') {
      // Non-financial form/sign metadata only — keep narrow.
      if (action === 'sign_dtp') {
        const name = String(body.signature_name || '').trim();
        if (name.length < 2) {
          await client.query('ROLLBACK');
          return { ok: false, statusCode: 400, error: 'missing_signature_name', spoofFieldsIgnored: spoof };
        }
        await client.query(
          `UPDATE public.homeowner_intro_requests SET
             dtp_signed_at = now(),
             dtp_signature_name = $2,
             dtp_insurance_carrier = COALESCE($3, dtp_insurance_carrier),
             dtp_claim_number = COALESCE($4, dtp_claim_number),
             dtp_policy_number = COALESCE($5, dtp_policy_number),
             dtp_property_address = COALESCE($6, dtp_property_address)
           WHERE id = $1::uuid`,
          [
            doc.lead.id,
            name,
            body.insurance_carrier || null,
            body.claim_number || null,
            body.policy_number || null,
            body.property_address || null,
          ],
        );
        await client.query('COMMIT');
        return { ok: true, statusCode: 200, signed: true, spoofFieldsIgnored: spoof };
      }
      await client.query('ROLLBACK');
      return {
        ok: false,
        statusCode: 501,
        error: 'action_not_ported',
        message: `Action ${action} is not fully ported on AWS staging yet`,
        spoofFieldsIgnored: spoof,
      };
    }

    await client.query('ROLLBACK');
    return { ok: false, statusCode: 400, error: 'unsupported_action', spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'claim_portal_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerLedgerUpload = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  if (!token) return { ok: false, statusCode: 400, error: 'invalid_token', spoofFieldsIgnored: spoof };

  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const doc = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_by_token($1) AS doc',
      [token],
    )).rows[0]?.doc;
    if (!doc?.ok || !doc.token) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: doc?.error || 'not_found', spoofFieldsIgnored: spoof };
    }

    const frontB64 = String(body.front_base64 || body.file_base64 || '');
    if (frontB64.length < 100) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, error: 'missing_file', spoofFieldsIgnored: spoof };
    }
    const clean = frontB64.includes(',') ? frontB64.split(',').pop() : frontB64;
    const bytes = Buffer.from(clean, 'base64');
    const rel = `ledger/${doc.token.claim_id || doc.token.id}/${Date.now()}_front.jpg`;
    const key = s3KeyFor('homeowner-uploads', rel);
    await s3().send(new PutObjectCommand({
      Bucket: filesBucket(),
      Key: key,
      Body: bytes,
      ContentType: 'image/jpeg',
    }));
    const row = (await client.query(
      `INSERT INTO public.homeowner_ledger_check_uploads (
         tenant_id, claim_id, front_path, status, created_at
       ) VALUES ($1::uuid, $2::uuid, $3, 'uploaded', now())
       RETURNING id, front_path, status, created_at`,
      [doc.token.tenant_id, doc.token.claim_id, rel],
    )).rows[0];
    await client.query('COMMIT');
    return { ok: true, statusCode: 200, upload: row, spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'ledger_upload_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerLedgerSignLink = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  const signerId = body.signer_id || body.signature_signer_id;
  if (!token || !signerId) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const doc = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_by_token($1) AS doc',
      [token],
    )).rows[0]?.doc;
    if (!doc?.ok) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: doc?.error || 'not_found', spoofFieldsIgnored: spoof };
    }
    const raw = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(raw).digest('hex');
    const updated = (await client.query(
      `UPDATE public.signature_signers
       SET token_hash = $2, updated_at = now()
       WHERE id = $1::uuid
       RETURNING id`,
      [signerId, hash],
    )).rows[0];
    if (!updated) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'signer_not_found', spoofFieldsIgnored: spoof };
    }
    await client.query('COMMIT');
    const origin = String(body.origin || process.env.VITE_APP_URL || 'https://staging.checksops.com').replace(/\/$/, '');
    return {
      ok: true,
      statusCode: 200,
      url: `${origin}/sign/${raw}`,
      token: raw,
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'sign_link_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerLedgerSend = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const homeownerEmail = normalizeEmail(body.homeowner_email);
  const homeownerPhone = body.homeowner_phone || null;
  if (!homeownerEmail && !homeownerPhone) {
    return { ok: false, statusCode: 400, error: 'missing_contact', spoofFieldsIgnored: spoof };
  }
  let tenantId = body.tenant_id || null;
  const claimId = body.claim_id || null;
  if (claimId && !tenantId) {
    const row = (await client.query(
      `SELECT tenant_id FROM public.check_intake_items
       WHERE claim_id = $1::uuid AND tenant_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [claimId],
    )).rows[0];
    tenantId = row?.tenant_id || null;
  }
  if (!tenantId) {
    const row = (await client.query(
      `SELECT tenant_id FROM public.tenant_users WHERE user_id = $1::uuid LIMIT 1`,
      [mapping.application_user_id],
    )).rows[0];
    tenantId = row?.tenant_id || null;
  }
  if (!tenantId) return { ok: false, statusCode: 400, error: 'no_tenant', spoofFieldsIgnored: spoof };

  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [mapping.application_user_id, tenantId],
  )).rows[0];
  if (!member) return { ok: false, statusCode: 403, error: 'cross_tenant_denied', spoofFieldsIgnored: spoof };

  let tokenRow = null;
  if (!body.rotate) {
    tokenRow = (await client.query(
      `SELECT id, token FROM public.homeowner_ledger_tokens
       WHERE tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR claim_id = $2::uuid)
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, claimId],
    )).rows[0];
  }
  if (!tokenRow) {
    const token = randomBytes(24).toString('hex');
    tokenRow = (await client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, token, homeowner_email, homeowner_name, created_by, created_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, now())
       RETURNING id, token`,
      [
        tenantId,
        claimId,
        token,
        homeownerEmail || null,
        body.homeowner_name || null,
        mapping.application_user_id,
      ],
    )).rows[0];
  }

  const origin = String(body.origin || process.env.VITE_APP_URL || 'https://staging.checksops.com').replace(/\/$/, '');
  const url = `${origin}/h/ledger/${tokenRow.token}`;
  if (homeownerEmail) {
    const rendered = renderTransactionalTemplate('homeowner-ledger-invite', {
      homeownerName: body.homeowner_name,
      ledgerUrl: url,
    });
    await sendViaSesOrSink({
      to: homeownerEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  return {
    ok: true,
    statusCode: 200,
    token: tokenRow.token,
    url,
    partner_code: body.partner_code || null,
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleSendFileToHomeowner = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const checkFileId = body.check_file_id;
  if (!checkFileId) return { ok: false, statusCode: 400, error: 'missing_check_file_id', spoofFieldsIgnored: spoof };
  const file = (await client.query(
    `SELECT id, check_id, tenant_id, file_path, file_name
     FROM public.check_files WHERE id = $1::uuid LIMIT 1`,
    [checkFileId],
  )).rows[0];
  if (!file) return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [mapping.application_user_id, file.tenant_id],
  )).rows[0];
  if (!member) return { ok: false, statusCode: 403, error: 'cross_tenant_denied', spoofFieldsIgnored: spoof };

  // Timeline note only (amount null)
  const claim = (await client.query(
    `SELECT claim_id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [file.check_id],
  )).rows[0];
  if (claim?.claim_id) {
    await client.query(
      `INSERT INTO public.homeowner_ledger_events (
         tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json, created_by, amount
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'document_shared', now(), 'Document shared', $4::jsonb, $5::uuid, NULL)`,
      [
        file.tenant_id,
        claim.claim_id,
        file.check_id,
        JSON.stringify({ file_name: file.file_name, note: body.note || null }),
        mapping.application_user_id,
      ],
    );
  }

  return { ok: true, statusCode: 200, shared: true, spoofFieldsIgnored: spoof };
}, { write: true, commit: true });

export const handleSendPortalInvite = async (event) => withIdentity(event, async ({
  mapping, body, spoof, client,
}) => {
  const email = normalizeEmail(body.email);
  if (!email) return { ok: false, statusCode: 400, error: 'missing_email', spoofFieldsIgnored: spoof };
  const rendered = renderTransactionalTemplate('stakeholder-verify-account', {
    verifyUrl: body.appUrl || 'https://staging.checksops.com/login',
  });
  const send = await sendViaSesOrSink({
    to: email,
    subject: `Your ${body.tenantName || 'ChecksOps'} portal invite`,
    html: `${rendered.html}<p>User: ${body.userName || ''} (${body.userType || ''})</p>`,
    text: `Portal invite for ${email}`,
  });
  await client.query(
    `INSERT INTO public.email_send_log (
       id, template_name, recipient_email, status, provider, provider_message_id, metadata, created_at
     ) VALUES ($1::uuid, 'send-portal-invite', $2, $3, 'aws_staging', $4, $5::jsonb, now())`,
    [
      randomUUID(),
      email,
      send.results[0]?.delivery === 'ses' ? 'sent' : 'sunk',
      send.results[0]?.messageId || null,
      JSON.stringify({ application_user_id: mapping.application_user_id, userType: body.userType || null }),
    ],
  ).catch(() => {});
  return { ok: true, statusCode: 200, success: true, stagingMode: send.mode, spoofFieldsIgnored: spoof };
}, { write: true, commit: true });

export const handleGetCheckImageUrls = async (event) => withIdentity(event, async ({
  client, body, spoof,
}) => {
  const checkId = body.checkId || body.check_id;
  if (!checkId) return { ok: false, statusCode: 400, error: 'missing_check_id', spoofFieldsIgnored: spoof };
  const row = (await client.query(
    `SELECT id, front_image_path, back_image_path
     FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!row) return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };

  const sign = async (path) => {
    if (!path) return null;
    const rel = normalizePath(path, 'claim-files');
    const key = s3KeyFor('claim-files', rel);
    if (!key || !filesBucket()) return null;
    try {
      return await getSignedUrl(
        s3(),
        new GetObjectCommand({ Bucket: filesBucket(), Key: key }),
        { expiresIn: 900 },
      );
    } catch {
      return null;
    }
  };

  return {
    ok: true,
    statusCode: 200,
    frontUrl: await sign(row.front_image_path),
    backUrl: await sign(row.back_image_path),
    spoofFieldsIgnored: spoof,
  };
});

export const handlePublicContractorDirectory = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const action = body.action || 'search';
  let client;
  try {
    client = await publicDb(false);
    if (action === 'get' && body.id) {
      const row = (await client.query(
        `SELECT id, display_name, bio, tier, is_directory_listed, directory_opt_in
         FROM public.contractor_profiles
         WHERE id = $1::uuid AND COALESCE(is_directory_listed, false) = true
         LIMIT 1`,
        [body.id],
      )).rows[0];
      return { ok: true, statusCode: 200, contractor: row || null, spoofFieldsIgnored: spoof };
    }
    const q = String(body.q || body.query || '').trim();
    const rows = (await client.query(
      `SELECT id, display_name, bio, tier
       FROM public.contractor_profiles
       WHERE COALESCE(is_directory_listed, false) = true
         AND COALESCE(directory_opt_in, false) = true
         AND ($1 = '' OR display_name ILIKE '%' || $1 || '%')
       ORDER BY display_name ASC
       LIMIT 50`,
      [q],
    )).rows;
    return { ok: true, statusCode: 200, contractors: rows, spoofFieldsIgnored: spoof };
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      error: 'directory_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleLookupPartnerCodePublic = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const code = String(body.code || body.partner_code || '').trim();
  if (!code) return { ok: false, statusCode: 400, error: 'missing_code', spoofFieldsIgnored: spoof };
  let client;
  try {
    client = await publicDb(false);
    const row = (await client.query(
      `SELECT public.lookup_tenant_by_partner_code($1) AS tenant`,
      [code],
    )).rows[0];
    return { ok: true, statusCode: 200, tenant: row?.tenant || null, spoofFieldsIgnored: spoof };
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      error: 'lookup_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
