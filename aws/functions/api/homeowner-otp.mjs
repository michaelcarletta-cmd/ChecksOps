/**
 * Homeowner /h/upload purpose-scoped OTP sessions (AWS staging).
 * Replaces Supabase Auth magic-link for document upload only.
 * Does NOT create a permanent ChecksOps Cognito user.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import { normalizeEmail } from './email-policy.mjs';
import { deliverAuditedEmail, peekAuditedEmail, replayIdempotentSend, stableEmailIdempotencyKey, validatedMailReplyTo } from './email.mjs';
import { emailMode } from './email-policy.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { resolveEmailBranding } from './email-branding.mjs';

const { Client } = pg;

const publicDb = async () => {
  const credentials = await loadDatabaseCredentials();
  const client = new Client(buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 }));
  await client.connect();
  return client;
};

const hashToken = (value) => createHash('sha256').update(String(value)).digest('hex');

const mintCode = () => String(randomInt(100000, 999999));

export const runHomeownerUploadOtpStart = async ({ client, body, spoof, send }) => {
  const email = normalizeEmail(body.email);
  const leadId = body.lead_id || body.leadId || null;
  const contractorProfileId = body.contractor_profile_id || body.contractorId || null;
  if (!email || !email.includes('@')) {
    return { ok: false, statusCode: 400, error: 'invalid_email', spoofFieldsIgnored: spoof };
  }

  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  if (suppliedKey) {
    const prior = await peekAuditedEmail(client, suppliedKey);
    if (!prior.ok) return { ...prior, spoofFieldsIgnored: spoof };
    if (prior.duplicate) {
      return {
        ...replayIdempotentSend(prior.row, spoof),
        sent: true,
        expiresAt: prior.row?.metadata?.expires_at || null,
      };
    }
  }

  // Bind to lead when provided
  if (leadId) {
    const lead = (await client.query(
      `SELECT id, homeowner_email, contractor_profile_id
       FROM public.homeowner_intro_requests WHERE id = $1::uuid LIMIT 1`,
      [leadId],
    )).rows[0];
    void lead;
  }

  const code = mintCode();
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const id = randomUUID();

  const inserted = (await client.query(
    `SELECT public.aws_public_homeowner_upload_otp_insert(
       $1::uuid, $2, $3, $4::uuid, $5::uuid, $6::timestamptz
     ) AS doc`,
    [id, email, codeHash, leadId, contractorProfileId, expiresAt],
  )).rows[0]?.doc;

  if (!inserted?.ok) {
    const err = inserted?.error || 'otp_create_failed';
    const status = err === 'email_mismatch' || err === 'lead_not_found' ? 403 : 503;
    return {
      ok: false,
      statusCode: status,
      error: err,
      spoofFieldsIgnored: spoof,
    };
  }

  const branding = await resolveEmailBranding(client, { senderOverride: 'checksops' });
  const reply = validatedMailReplyTo(branding.replyTo);
  if (!reply.ok) {
    return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
  }
  const rendered = renderTransactionalTemplate('homeowner-upload-otp', {
    code,
    branding,
  });
  const delivery = await deliverAuditedEmail(client, {
    templateName: 'homeowner-upload-otp',
    recipientEmail: email,
    tenantId: null,
    idempotencyKey: suppliedKey || stableEmailIdempotencyKey('homeowner-otp', id),
    metadata: { otp_id: id, expires_at: expiresAt, lead_id: leadId },
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

  return {
    ok: true,
    statusCode: 200,
    sent: true,
    duplicate: delivery.duplicate === true,
    expiresAt,
    providerMessageId: delivery.providerMessageId || delivery.replay?.providerMessageId || null,
    stagingDebugCode: emailMode() === 'sink' ? code : undefined,
    spoofFieldsIgnored: spoof,
  };
};

export const handleHomeownerUploadOtpStart = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  if (deps.client) {
    return runHomeownerUploadOtpStart({
      client: deps.client,
      body,
      spoof,
      send: deps.sendViaSesOrSink,
    });
  }

  let client;
  try {
    client = await publicDb();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const result = await runHomeownerUploadOtpStart({
      client,
      body,
      spoof,
      send: deps.sendViaSesOrSink,
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
      error: 'otp_start_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerUploadOtpVerify = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim().replace(/\s+/g, '');
  if (!email || !/^\d{6}$/.test(code)) {
    return { ok: false, statusCode: 400, error: 'invalid_code', spoofFieldsIgnored: spoof };
  }

  let client;
  try {
    client = await publicDb();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');

    const sessionToken = randomBytes(32).toString('hex');
    const sessionHash = hashToken(sessionToken);
    const doc = (await client.query(
      `SELECT public.aws_public_homeowner_upload_otp_verify(
         $1, $2, $3, $4::timestamptz
       ) AS doc`,
      [email, hashToken(code), sessionHash, new Date(Date.now() + 60 * 60 * 1000).toISOString()],
    )).rows[0]?.doc;

    if (!doc?.ok) {
      await client.query('ROLLBACK');
      const err = doc?.error || 'invalid_code';
      const status = err === 'expired' ? 410 : err === 'used' ? 409 : 401;
      return { ok: false, statusCode: status, error: err, spoofFieldsIgnored: spoof };
    }

    await client.query('COMMIT');
    return {
      ok: true,
      statusCode: 200,
      uploadToken: sessionToken,
      expiresAt: doc.expires_at,
      email: doc.email,
      leadId: doc.lead_id || null,
      contractorProfileId: doc.contractor_profile_id || null,
      lead: doc.lead || null,
      contractor: doc.contractor || null,
      uploads: doc.uploads || [],
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'otp_verify_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerUploadSession = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(
    body.upload_token
    || body.uploadToken
    || event.headers?.['x-homeowner-upload-token']
    || event.headers?.['X-Homeowner-Upload-Token']
    || '',
  ).trim();
  const action = body.action || 'get';
  if (!token || token.length < 32) {
    return { ok: false, statusCode: 401, error: 'missing_upload_token', spoofFieldsIgnored: spoof };
  }

  let client;
  try {
    client = await publicDb();
    if (action === 'sign_out' || action === 'revoke') {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ WRITE');
      await client.query(
        `SELECT public.aws_public_homeowner_upload_session_revoke($1)`,
        [hashToken(token)],
      );
      await client.query('COMMIT');
      return { ok: true, statusCode: 200, revoked: true, spoofFieldsIgnored: spoof };
    }

    const doc = (await client.query(
      `SELECT public.aws_public_homeowner_upload_session_get($1) AS doc`,
      [hashToken(token)],
    )).rows[0]?.doc;
    if (!doc?.ok) {
      const err = doc?.error || 'invalid_token';
      const status = err === 'expired' || err === 'revoked' ? 410 : 401;
      return { ok: false, statusCode: status, error: err, spoofFieldsIgnored: spoof };
    }
    return {
      ok: true,
      statusCode: 200,
      email: doc.email,
      leadId: doc.lead_id,
      contractorProfileId: doc.contractor_profile_id,
      lead: doc.lead,
      contractor: doc.contractor,
      uploads: doc.uploads || [],
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'session_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const resolveHomeownerUploadToken = async (client, rawToken) => {
  if (!rawToken || String(rawToken).length < 32) return null;
  const doc = (await client.query(
    `SELECT public.aws_public_homeowner_upload_session_get($1) AS doc`,
    [hashToken(rawToken)],
  )).rows[0]?.doc;
  if (!doc?.ok) return null;
  return doc;
};
