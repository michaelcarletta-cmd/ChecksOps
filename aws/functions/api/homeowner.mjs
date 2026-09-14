/**
 * HomeownerOps Class A services (non-financial).
 * Public token routes + staff send/upload helpers.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { withIdentity, withIdentityWrite, parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';
import {
  deliverAuditedEmail,
  peekAuditedEmail,
  replayIdempotentSend,
  stableEmailIdempotencyKey,
  validatedMailReplyTo,
} from './email-audited.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { normalizeEmail } from './email-policy.mjs';
import { emailAssetOrigin, resolveEmailBranding } from './email-branding.mjs';
import { requireAuthorizedTenant } from './tenant-email-domain.mjs';
import {
  homeownerLedgerTrackingUrl,
  ledgerUploadInsertValues,
  ledgerUploadToken,
  loadLedgerTokenDoc,
  runHomeownerLedgerSignLink,
  runHomeownerLedgerView,
} from './homeowner-ledger-public.mjs';

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

const appOrigin = (override) => String(
  override || process.env.VITE_APP_URL || emailAssetOrigin(),
).replace(/\/$/, '');

const loadLedgerTokenStaffRow = async (client, token) => {
  try {
    return (await client.query(
      `SELECT id, tenant_id, claim_id, sent_by_user_id, created_by,
              homeowner_email, homeowner_name, partner_code
       FROM public.homeowner_ledger_tokens WHERE token = $1 LIMIT 1`,
      [token],
    )).rows[0] || null;
  } catch {
    return (await client.query(
      `SELECT id, tenant_id, claim_id, created_by,
              homeowner_email, homeowner_name, partner_code
       FROM public.homeowner_ledger_tokens WHERE token = $1 LIMIT 1`,
      [token],
    )).rows[0] || null;
  }
};

const profileEmail = async (client, userId) => {
  if (!userId) return null;
  const row = (await client.query(
    `SELECT email, full_name FROM public.profiles WHERE id = $1::uuid LIMIT 1`,
    [userId],
  )).rows[0];
  return {
    email: normalizeEmail(row?.email),
    fullName: row?.full_name || null,
  };
};

export const notifyStaffOfHomeownerLedgerUpload = async ({
  client, token, uploadId, origin, homeownerNote, amountEstimate, send,
}) => {
  const meta = await loadLedgerTokenStaffRow(client, token);
  if (!meta) return { notified: false, reason: 'token_not_found' };
  const staffUserId = meta.sent_by_user_id || meta.created_by || null;
  const staff = await profileEmail(client, staffUserId);
  const to = staff?.email;
  if (!to) return { notified: false, reason: 'missing_staff_email' };

  const branding = await resolveEmailBranding(client, { tenantId: meta.tenant_id });
  const reply = validatedMailReplyTo(branding.replyTo);
  if (!reply.ok) return { notified: false, reason: reply.error };
  const inboxUrl = `${appOrigin(origin)}/checks`;
  const rendered = renderTransactionalTemplate('homeowner-upload-alert', {
    staff_name: staff.fullName,
    homeowner_name: meta.homeowner_name,
    homeowner_email: meta.homeowner_email,
    partner_code: meta.partner_code,
    amount_estimate: amountEstimate ?? null,
    homeowner_note: homeownerNote || null,
    inbox_url: inboxUrl,
    claimId: meta.claim_id,
    branding,
  });
  const delivery = await deliverAuditedEmail(client, {
    templateName: 'homeowner-upload-alert',
    recipientEmail: to,
    tenantId: meta.tenant_id,
    idempotencyKey: stableEmailIdempotencyKey('homeowner-upload-alert', meta.tenant_id, uploadId || meta.id, to),
    metadata: { upload_id: uploadId || null, token_id: meta.id || null },
    send,
    mailerArgs: {
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: branding.from,
      replyTo: reply.replyTo,
    },
  });
  if (!delivery.ok) return { notified: false, reason: delivery.error };
  return {
    notified: true,
    recipient: to,
    uploadId: uploadId || null,
    duplicate: delivery.duplicate === true,
    providerMessageId: delivery.providerMessageId || delivery.replay?.providerMessageId || null,
  };
};

export const handleHomeownerLedgerView = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const qs = event.queryStringParameters || {};
  const token = String(body.token || qs.token || '').trim();
  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const result = await runHomeownerLedgerView({
      client,
      token,
      spoof,
      s3Client: s3(),
    });
    if (result.ok) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return result;
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

export const handleHomeownerClaimPortal = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  const action = body.action || 'get';
  if (!/^[a-f0-9]{32,80}$/i.test(token)) {
    return { ok: false, statusCode: 400, error: 'invalid body', spoofFieldsIgnored: spoof };
  }

  let client;
  try {
    const connect = deps.connect || publicDb;
    client = deps.client || await connect(true);
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
        const persisted = (await client.query(
          `SELECT public.aws_public_homeowner_claim_sign_dtp($1, $2, $3, $4, $5, $6) AS doc`,
          [
            token,
            name,
            body.insurance_carrier || null,
            body.claim_number || null,
            body.policy_number || null,
            body.property_address || null,
          ],
        )).rows[0]?.doc;
        if (!persisted?.ok || persisted.signed !== true || !persisted.dtp_signed_at) {
          await client.query('ROLLBACK');
          const err = persisted?.error || 'persist_failed';
          const status = err === 'missing_signature_name' ? 400 : err === 'invalid_token' ? 400 : 503;
          return { ok: false, statusCode: status, error: err, spoofFieldsIgnored: spoof };
        }
        await client.query('COMMIT');
        return {
          ok: true,
          statusCode: 200,
          signed: true,
          dtp_signed_at: persisted.dtp_signed_at,
          dtp_signature_name: persisted.dtp_signature_name,
          spoofFieldsIgnored: spoof,
        };
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

export const handleHomeownerLedgerUpload = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  if (!token) return { ok: false, statusCode: 400, error: 'invalid_token', spoofFieldsIgnored: spoof };

  let client;
  try {
    client = deps.client || await publicDb(true);
    if (!deps.client) {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ WRITE');
    }
    const doc = await loadLedgerTokenDoc(client, token);
    if (doc?.error || !doc?.ok) {
      if (!deps.client) await client.query('ROLLBACK');
      const error = doc?.error || 'not_found';
      const status = error === 'revoked' || error === 'expired' ? 410 : 404;
      return { ok: false, statusCode: status, error, spoofFieldsIgnored: spoof };
    }
    const tok = ledgerUploadToken(doc);
    if (!tok) {
      if (!deps.client) await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
    }

    const frontB64 = String(body.front_base64 || body.file_base64 || '');
    if (frontB64.length < 100) {
      if (!deps.client) await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, error: 'missing_file', spoofFieldsIgnored: spoof };
    }
    const clean = frontB64.includes(',') ? frontB64.split(',').pop() : frontB64;
    const bytes = Buffer.from(clean, 'base64');
    const rel = `ledger/${tok.tenant_id}/${tok.id}/${Date.now()}_front.jpg`;
    const key = s3KeyFor('homeowner-uploads', rel);
    if (typeof deps.putObject === 'function') {
      await deps.putObject({ Bucket: filesBucket(), Key: key, Body: bytes, ContentType: 'image/jpeg' });
    } else {
      await s3().send(new PutObjectCommand({
        Bucket: filesBucket(),
        Key: key,
        Body: bytes,
        ContentType: 'image/jpeg',
      }));
    }
    const inserted = (await client.query(
      `SELECT public.aws_public_homeowner_ledger_upload_insert($1, $2, $3, $4) AS doc`,
      [token, rel, body.amount_estimate ?? null, body.homeowner_note || body.note || null],
    )).rows[0]?.doc;
    if (!inserted?.ok) {
      if (!deps.client) await client.query('ROLLBACK');
      const error = inserted?.error || 'upload_insert_failed';
      const status = inserted?.statusCode || (error === 'revoked' || error === 'expired' ? 410 : 404);
      return { ok: false, statusCode: status, error, spoofFieldsIgnored: spoof };
    }
    const row = {
      id: inserted.id,
      token_id: inserted.token_id,
      claim_id: inserted.claim_id,
      tenant_id: inserted.tenant_id,
      front_path: inserted.front_path,
      status: inserted.status,
      created_at: inserted.created_at,
    };
    if (!deps.client) await client.query('COMMIT');
    let notified = false;
    try {
      const notify = await notifyStaffOfHomeownerLedgerUpload({
        client,
        token,
        uploadId: row?.id,
        origin: body.origin,
        homeownerNote: body.homeowner_note,
        amountEstimate: body.amount_estimate,
        send: deps.sendViaSesOrSink,
      });
      notified = notify.notified === true;
    } catch {
      notified = false;
    }
    return { ok: true, statusCode: 200, upload: row, notified, spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client && !deps.client) {
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
    if (client && !deps.client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerLedgerSignLink = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const result = await runHomeownerLedgerSignLink({
      client,
      body,
      spoof,
      origin: body.origin,
    });
    if (result.ok) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return result;
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

export const runHomeownerLedgerSend = async ({
  client, mapping, body, spoof, send,
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
  if (!body.rotate && claimId && homeownerEmail) {
    tokenRow = (await client.query(
      `SELECT id, token FROM public.homeowner_ledger_tokens
       WHERE tenant_id = $1::uuid
         AND claim_id = $2::uuid
         AND lower(trim(homeowner_email)) = lower(trim($3))
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, claimId, homeownerEmail],
    )).rows[0];
  }
  if (!tokenRow) {
    const token = randomBytes(24).toString('hex');
    const insertWithSentBy = async () => client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, token, homeowner_email, homeowner_name, created_by, sent_by_user_id, created_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $6::uuid, now())
       RETURNING id, token`,
      [tenantId, claimId, token, homeownerEmail || null, body.homeowner_name || null, mapping.application_user_id],
    );
    const insertWithoutSentBy = async () => client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, token, homeowner_email, homeowner_name, created_by, created_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, now())
       RETURNING id, token`,
      [tenantId, claimId, token, homeownerEmail || null, body.homeowner_name || null, mapping.application_user_id],
    );
    try {
      tokenRow = (await insertWithSentBy()).rows[0];
    } catch {
      tokenRow = (await insertWithoutSentBy()).rows[0];
    }
  } else {
    try {
      await client.query(
        `UPDATE public.homeowner_ledger_tokens
         SET sent_by_user_id = $2::uuid
         WHERE id = $1::uuid
           AND lower(trim(homeowner_email)) = lower(trim($3))`,
        [tokenRow.id, mapping.application_user_id, homeownerEmail || null],
      );
    } catch {
      try {
        await client.query(
          `UPDATE public.homeowner_ledger_tokens
           SET sent_by_user_id = $2::uuid
           WHERE id = $1::uuid`,
          [tokenRow.id, mapping.application_user_id],
        );
      } catch {
        /* sent_by_user_id may be absent on older staging dumps */
      }
    }
  }

  const origin = appOrigin(body.origin);
  const url = homeownerLedgerTrackingUrl(origin, tokenRow.token, claimId);
  if (homeownerEmail) {
    const branding = await resolveEmailBranding(client, {
      tenantId,
    });
    const reply = validatedMailReplyTo(branding.replyTo);
    if (!reply.ok) {
      return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
    }
    const rendered = renderTransactionalTemplate('homeowner-ledger-invite', {
      homeownerName: body.homeowner_name,
      ledgerUrl: url,
      is_pre_claim: !claimId,
      branding,
    });
    const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
    const delivery = await deliverAuditedEmail(client, {
      templateName: 'homeowner-ledger-invite',
      recipientEmail: homeownerEmail,
      tenantId,
      idempotencyKey: suppliedKey || stableEmailIdempotencyKey('homeowner-ledger', tokenRow.id, homeownerEmail),
      applicationUserId: mapping.application_user_id,
      metadata: { token_id: tokenRow.id, claim_id: claimId || null },
      spoof,
      send,
      mailerArgs: {
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        from: branding.from,
        replyTo: reply.replyTo,
      },
    });
    if (!delivery.ok) return { ...delivery, spoofFieldsIgnored: spoof };
    if (delivery.duplicate) {
      return {
        ...delivery.replay,
        token: tokenRow.token,
        url,
        partner_code: body.partner_code || null,
        from: branding.from,
        replyTo: reply.replyTo,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      token: tokenRow.token,
      url,
      partner_code: body.partner_code || null,
      spoofFieldsIgnored: spoof,
      from: branding.from,
      replyTo: reply.replyTo,
      duplicate: false,
      providerMessageId: delivery.providerMessageId || null,
      stagingPolicy: delivery.stagingPolicy || null,
      stagingMode: delivery.stagingMode || null,
      auditId: delivery.id || null,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    token: tokenRow.token,
    url,
    partner_code: body.partner_code || null,
    spoofFieldsIgnored: spoof,
  };
};

export const handleHomeownerLedgerSend = (event, deps = {}) => withIdentity(event, (ctx) => (
  runHomeownerLedgerSend({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const runSendFileToHomeowner = async ({
  client, mapping, body, spoof, send,
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

  const claim = (await client.query(
    `SELECT claim_id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [file.check_id],
  )).rows[0];
  const claimId = claim?.claim_id || null;
  const tok = (await client.query(
    `SELECT token, homeowner_email, homeowner_name
     FROM public.homeowner_ledger_tokens
     WHERE tenant_id = $1::uuid
       AND ($2::uuid IS NULL OR claim_id = $2::uuid)
       AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [file.tenant_id, claimId],
  )).rows[0];
  const homeownerEmail = normalizeEmail(tok?.homeowner_email);
  if (!homeownerEmail) {
    return {
      ok: false,
      statusCode: 400,
      error: 'missing_recipient',
      reason: 'no_homeowner_link',
      message: 'Send the homeowner their portal link first.',
      spoofFieldsIgnored: spoof,
    };
  }

  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  const idempotencyKey = suppliedKey || stableEmailIdempotencyKey('send-file', file.id, homeownerEmail);
  const prior = await peekAuditedEmail(client, idempotencyKey);
  if (!prior.ok) return { ...prior, spoofFieldsIgnored: spoof };
  if (prior.duplicate) {
    return {
      ...replayIdempotentSend(prior.row, spoof),
      shared: true,
      emailed: true,
    };
  }

  if (claimId) {
    await client.query(
      `INSERT INTO public.homeowner_ledger_events (
         tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json, created_by, amount
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'document_shared', now(), 'Document shared', $4::jsonb, $5::uuid, NULL)`,
      [
        file.tenant_id,
        claimId,
        file.check_id,
        JSON.stringify({ file_name: file.file_name, note: body.note || null }),
        mapping.application_user_id,
      ],
    );
  }

  const origin = appOrigin(body.origin);
  const portalUrl = homeownerLedgerTrackingUrl(origin, tok.token, claimId);
  const branding = await resolveEmailBranding(client, {
    tenantId: file.tenant_id,
    senderOverride: 'checksops',
  });
  const reply = validatedMailReplyTo(branding.replyTo);
  if (!reply.ok) {
    return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
  }
  const rendered = renderTransactionalTemplate('homeowner-document-shared', {
    homeowner_name: tok.homeowner_name,
    portal_url: portalUrl,
    url: portalUrl,
    document_name: file.file_name,
    note: body.note || null,
    branding,
  });
  const delivery = await deliverAuditedEmail(client, {
    templateName: 'homeowner-document-shared',
    recipientEmail: homeownerEmail,
    tenantId: file.tenant_id,
    idempotencyKey,
    applicationUserId: mapping.application_user_id,
    metadata: { check_file_id: file.id, claim_id: claimId || null },
    spoof,
    send,
    mailerArgs: {
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: branding.from,
      replyTo: reply.replyTo,
    },
  });
  if (!delivery.ok) return { ...delivery, spoofFieldsIgnored: spoof };
  if (delivery.duplicate) {
    return {
      ...delivery.replay,
      shared: true,
      emailed: true,
      portal_url: portalUrl,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    shared: true,
    emailed: true,
    portal_url: portalUrl,
    providerMessageId: delivery.providerMessageId,
    spoofFieldsIgnored: spoof,
  };
};

export const handleSendFileToHomeowner = (event, deps = {}) => withIdentity(event, (ctx) => (
  runSendFileToHomeowner({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const runSendPortalInvite = async ({
  mapping, body, spoof, client, send,
}) => {
  const email = normalizeEmail(body.email);
  if (!email) return { ok: false, statusCode: 400, error: 'missing_email', spoofFieldsIgnored: spoof };

  const tenantId = body.tenant_id || body.tenantId || null;
  const authorized = await requireAuthorizedTenant(client, mapping, tenantId, { configure: false });
  if (!authorized.ok) return { ...authorized, spoofFieldsIgnored: spoof };

  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  const idempotencyKey = suppliedKey || stableEmailIdempotencyKey('portal-invite', authorized.tenantId, email);

  const origin = appOrigin(body.appUrl || body.origin);
  const loginUrl = /\/(portal|login)(\/|$)/i.test(origin) ? origin : `${origin}/login`;
  const branding = await resolveEmailBranding(client, {
    tenantId: authorized.tenantId,
    senderOverride: body.senderOverride || body.sender_override || null,
  });
  const reply = validatedMailReplyTo(branding.replyTo);
  if (!reply.ok) {
    return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
  }
  const rendered = renderTransactionalTemplate('portal-invite', {
    tenantName: body.tenantName,
    userName: body.userName,
    userType: body.userType,
    loginUrl,
    branding,
  });

  const delivery = await deliverAuditedEmail(client, {
    templateName: 'portal-invite',
    recipientEmail: email,
    tenantId: authorized.tenantId,
    idempotencyKey,
    applicationUserId: mapping.application_user_id,
    metadata: { userType: body.userType || null },
    spoof,
    send,
    mailerArgs: {
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: branding.from,
      replyTo: reply.replyTo,
    },
  });
  if (!delivery.ok) return { ...delivery, spoofFieldsIgnored: spoof };
  if (delivery.duplicate) return delivery.replay;
  return {
    ok: true,
    statusCode: 200,
    success: true,
    sent: delivery.sent,
    queued: false,
    sunk: delivery.sunk,
    provider: 'aws_staging',
    id: delivery.providerMessageId || delivery.id,
    providerMessageId: delivery.providerMessageId,
    stagingPolicy: delivery.stagingPolicy,
    stagingMode: delivery.stagingMode,
    persistError: delivery.persistError || null,
    spoofFieldsIgnored: spoof,
  };
};

export const handleSendPortalInvite = (event, deps = {}) => withIdentity(event, (ctx) => (
  runSendPortalInvite({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const handleHomeownerUploadCheck = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const contractorProfileId = body.contractor_profile_id;
  const fileB64 = String(body.file_base64 || '');
  if (!contractorProfileId || fileB64.length < 100) {
    return { ok: false, statusCode: 400, error: 'invalid body', spoofFieldsIgnored: spoof };
  }
  const mime = String(body.file_mime || 'image/jpeg').slice(0, 60);
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
  if (!allowed.has(mime)) {
    return { ok: false, statusCode: 400, error: 'unsupported file type', spoofFieldsIgnored: spoof };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  const uploadToken = String(
    body.upload_token
    || body.uploadToken
    || event.headers?.['x-homeowner-upload-token']
    || event.headers?.['X-Homeowner-Upload-Token']
    || '',
  ).trim() || (/^[a-f0-9]{64}$/i.test(bearer) ? bearer : '');

  // Purpose-scoped AWS upload session (replaces Supabase Auth on /h/upload).
  if (uploadToken) {
    let client;
    try {
      const { resolveHomeownerUploadToken } = await import('./homeowner-otp.mjs');
      client = await publicDb(true);
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ WRITE');
      const session = await resolveHomeownerUploadToken(client, uploadToken);
      if (!session) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 401, error: 'invalid session', spoofFieldsIgnored: spoof };
      }
      const result = await insertHomeownerCheckUpload(client, {
        body: {
          ...body,
          lead_id: body.lead_id || session.lead_id,
          contractor_profile_id: contractorProfileId || session.contractor_profile_id,
        },
        homeownerEmail: normalizeEmail(session.email),
        homeownerUserId: null,
        spoof,
        verifiedLead: session.lead
          ? {
            id: session.lead.id,
            homeowner_email: session.lead.homeowner_email || session.email,
            contractor_profile_id: session.lead.contractor_profile_id || session.contractor_profile_id,
          }
          : (session.lead_id ? {
            id: session.lead_id,
            homeowner_email: session.email,
            contractor_profile_id: session.contractor_profile_id,
          } : null),
      });
      if (result.ok) await client.query('COMMIT');
      else await client.query('ROLLBACK');
      return result;
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      return {
        ok: false,
        statusCode: 503,
        error: 'upload failed',
        message: sanitizePublicError(error),
        spoofFieldsIgnored: spoof,
      };
    } finally {
      if (client) {
        try { await client.end(); } catch { /* ignore */ }
      }
    }
  }

  // Prefer Cognito-mapped identity email when present; otherwise require lead access token + email.
  let homeownerEmail = normalizeEmail(body.homeowner_email || body.email);
  let homeownerUserId = null;
  const hasBearer = Boolean(bearer) && bearer.includes('.');

  let client;
  try {
    if (hasBearer) {
      return withIdentity(event, async ({ client: c, mapping, body: b, spoof: s }) => {
        homeownerEmail = normalizeEmail(mapping.email || b.homeowner_email || b.email);
        homeownerUserId = mapping.application_user_id;
        if (!homeownerEmail) {
          return { ok: false, statusCode: 401, error: 'invalid session', spoofFieldsIgnored: s };
        }
        return insertHomeownerCheckUpload(c, {
          body: b,
          homeownerEmail,
          homeownerUserId,
          spoof: s,
        });
      }, { write: true, commit: true });
    }

    // Public staging path: lead access_token proves ownership of the lead email.
    const leadToken = String(body.access_token || body.lead_access_token || '').trim();
    if (!leadToken || !homeownerEmail) {
      return {
        ok: false,
        statusCode: 401,
        error: 'unauthenticated',
        message: 'Upload session token, Cognito session, or lead access_token + homeowner_email required',
        spoofFieldsIgnored: spoof,
      };
    }

    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const leadDoc = (await client.query(
      'SELECT public.aws_public_homeowner_claim_by_token($1) AS doc',
      [leadToken],
    )).rows[0]?.doc;
    if (!leadDoc?.ok || !leadDoc.lead) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'lead not found', spoofFieldsIgnored: spoof };
    }
    const leadEmail = normalizeEmail(leadDoc.lead.homeowner_email);
    if (leadEmail !== homeownerEmail) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 403, error: 'lead does not match this session', spoofFieldsIgnored: spoof };
    }
    if (body.lead_id && String(body.lead_id) !== String(leadDoc.lead.id)) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 403, error: 'lead does not match this session', spoofFieldsIgnored: spoof };
    }
    const result = await insertHomeownerCheckUpload(client, {
      body: { ...body, lead_id: body.lead_id || leadDoc.lead.id },
      homeownerEmail,
      homeownerUserId: null,
      spoof,
      verifiedLead: {
        id: leadDoc.lead.id,
        homeowner_email: leadDoc.lead.homeowner_email,
        contractor_profile_id: leadDoc.lead.contractor_profile_id || body.contractor_profile_id,
      },
    });
    if (result.ok) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return result;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'upload failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

const insertHomeownerCheckUpload = async (client, {
  body, homeownerEmail, homeownerUserId, spoof, verifiedLead = null,
}) => {
  const profile = (await client.query(
    `SELECT id, user_id, is_directory_listed, directory_opt_in, display_name
     FROM public.contractor_profiles WHERE id = $1::uuid LIMIT 1`,
    [body.contractor_profile_id],
  )).rows[0];
  if (!profile || !profile.is_directory_listed || !profile.directory_opt_in) {
    return { ok: false, statusCode: 403, error: 'contractor not accepting uploads', spoofFieldsIgnored: spoof };
  }

  if (body.lead_id) {
    const lead = verifiedLead || (await client.query(
      `SELECT id, homeowner_email, contractor_profile_id
       FROM public.homeowner_intro_requests WHERE id = $1::uuid LIMIT 1`,
      [body.lead_id],
    )).rows[0];
    if (
      !lead
      || String(lead.contractor_profile_id) !== String(profile.id)
      || normalizeEmail(lead.homeowner_email) !== homeownerEmail
    ) {
      return { ok: false, statusCode: 403, error: 'lead does not match this session', spoofFieldsIgnored: spoof };
    }
  }

  const clean = String(body.file_base64).includes(',')
    ? String(body.file_base64).split(',').pop()
    : String(body.file_base64);
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length > 15 * 1024 * 1024) {
    return { ok: false, statusCode: 400, error: 'file too large (15 MB max)', spoofFieldsIgnored: spoof };
  }
  const mime = String(body.file_mime || 'image/jpeg').slice(0, 60);
  const ext = String(body.filename || 'upload.jpg').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const rel = `homeowner-uploads/${profile.user_id}/${body.lead_id || 'nolead'}/${randomUUID()}.${ext}`;
  const key = s3KeyFor('homeowner-uploads', rel);
  if (!filesBucket() || !key) {
    return { ok: false, statusCode: 503, error: 's3_not_configured', spoofFieldsIgnored: spoof };
  }
  await s3().send(new PutObjectCommand({
    Bucket: filesBucket(),
    Key: key,
    Body: bytes,
    ContentType: mime,
  }));

  const row = (await client.query(
    `SELECT public.aws_public_homeowner_check_upload_insert(
       $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8
     ) AS doc`,
    [
      body.lead_id || null,
      profile.id,
      profile.user_id,
      homeownerEmail,
      homeownerUserId,
      rel,
      mime,
      body.note || null,
    ],
  )).rows[0]?.doc;
  if (!row?.ok || !row.id) {
    return {
      ok: false,
      statusCode: 500,
      error: 'db insert failed',
      detail: row?.error || null,
      spoofFieldsIgnored: spoof,
    };
  }

  return { ok: true, statusCode: 200, id: row.id, spoofFieldsIgnored: spoof };
};

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
        { expiresIn: 300 },
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

const copyHomeownerUploadToClaimFiles = async (tenantId, claimId, srcPath) => {
  const srcRel = normalizePath(srcPath, 'homeowner-uploads') || String(srcPath || '').replace(/^\/+/, '');
  const filename = srcRel.split('/').pop() || 'check';
  const destRel = `${tenantId}/${claimId}/homeowner-checks/${Date.now()}-${filename}`;
  const fromKey = s3KeyFor('homeowner-uploads', srcRel);
  const toKey = s3KeyFor('claim-files', destRel);
  if (!fromKey || !toKey || !filesBucket()) {
    throw new Error('s3_not_configured');
  }
  await s3().send(new CopyObjectCommand({
    Bucket: filesBucket(),
    CopySource: encodeURI(`${filesBucket()}/${fromKey}`),
    Key: toKey,
  }));
  return destRel;
};

/**
 * Staff attach of a homeowner ledger upload onto a claim/check.
 * Ignores browser-supplied amount; uses homeowner_ledger_check_uploads.amount_estimate.
 * Does not execute deposits.
 */
export const handleHomeownerLedgerAttachUpload = async (event) => withIdentityWrite(event, async ({
  client, mapping, body, spoof,
}) => {
  const uploadId = body.upload_id || body.uploadId;
  const claimId = body.claim_id || body.claimId || null;
  if (!uploadId) {
    return { ok: false, statusCode: 400, error: 'missing_params', spoofFieldsIgnored: spoof };
  }

  const up = (await client.query(
    `SELECT * FROM public.homeowner_ledger_check_uploads WHERE id = $1::uuid LIMIT 1`,
    [uploadId],
  )).rows[0];
  if (!up) return { ok: false, statusCode: 404, error: 'upload_not_found', spoofFieldsIgnored: spoof };
  if (up.status === 'attached') {
    return {
      ok: false,
      statusCode: 409,
      error: 'already_attached',
      check_id: up.attached_check_id,
      spoofFieldsIgnored: spoof,
    };
  }

  let claimNumber = null;
  if (claimId) {
    const claim = (await client.query(
      `SELECT id, org_id AS tenant_id, claim_number FROM public.claims WHERE id = $1::uuid LIMIT 1`,
      [claimId],
    )).rows[0];
    if (!claim) return { ok: false, statusCode: 404, error: 'claim_not_found', spoofFieldsIgnored: spoof };
    if (String(claim.tenant_id) !== String(up.tenant_id)) {
      return { ok: false, statusCode: 403, error: 'tenant_mismatch', spoofFieldsIgnored: spoof };
    }
    claimNumber = claim.claim_number;
  }

  const membership = (await client.query(
    `SELECT user_id FROM public.tenant_users
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [mapping.application_user_id, up.tenant_id],
  )).rows[0];
  if (!membership) return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };

  const amount = up.amount_estimate ?? null;
  const copied = await copyHomeownerUploadToClaimFiles(
    up.tenant_id,
    claimId || 'unlinked',
    up.front_path,
  );
  const backCopied = up.back_path
    ? await copyHomeownerUploadToClaimFiles(up.tenant_id, claimId || 'unlinked', up.back_path)
    : null;

  const check = (await client.query(
    `INSERT INTO public.check_intake_items (
       claim_id, tenant_id, uploaded_by, front_image_path, back_image_path,
       amount, status, check_stage, check_source
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'pending', 'review', 'insurance')
     RETURNING id`,
    [claimId, up.tenant_id, mapping.application_user_id, copied, backCopied, amount],
  )).rows[0];

  await client.query(
    `UPDATE public.homeowner_ledger_check_uploads
     SET status = 'attached',
         attached_check_id = $2::uuid,
         claim_id = $3::uuid,
         reviewed_by = $4::uuid,
         reviewed_at = now()
     WHERE id = $1::uuid`,
    [uploadId, check.id, claimId, mapping.application_user_id],
  );

  if (up.token_id && claimId) {
    await client.query(
      `UPDATE public.homeowner_ledger_tokens
       SET claim_id = $2::uuid
       WHERE id = $1::uuid AND claim_id IS NULL`,
      [up.token_id, claimId],
    );
  }

  await client.query(
    `INSERT INTO public.homeowner_ledger_events (
       tenant_id, claim_id, event_type, amount, actor_label, payload_json
     ) VALUES ($1::uuid, $2::uuid, 'homeowner_upload_attached', $3, 'Staff', $4::jsonb)`,
    [
      up.tenant_id,
      claimId,
      amount,
      JSON.stringify({ upload_id: uploadId, check_id: check.id, claim_number: claimNumber }),
    ],
  );

  return {
    ok: true,
    statusCode: 200,
    check_id: check.id,
    claim_id: claimId,
    amount_source: 'homeowner_ledger_check_uploads.amount_estimate',
    clientAmountIgnored: Object.prototype.hasOwnProperty.call(body, 'amount'),
    spoofFieldsIgnored: spoof,
  };
});
