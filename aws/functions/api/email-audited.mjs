/**
 * Durable audited send helper for the stacked staging Lambda.
 * Imports sendViaSesOrSink from the live email.mjs at call time so this file
 * can be overlaid without replacing Class A email handlers.
 */
import { randomUUID } from 'node:crypto';
import {
  defaultReplyTo,
  normalizeEmail,
  sesOutboundSendEnabled,
} from './email-policy.mjs';
import { normalizeReplyTo } from './tenant-email-domain.mjs';

export const EMAIL_SEND_LOG_STATUSES = Object.freeze([
  'pending',
  'sent',
  'sunk',
  'suppressed',
  'failed',
  'bounced',
  'complained',
  'dlq',
]);

export const emailSendLogStatusFromMailer = (primary = {}) => {
  if (primary.status === 'failed' || primary.delivery === 'sink_fallback') return 'failed';
  if (primary.delivery === 'ses' && primary.status === 'sent') return 'sent';
  return 'sunk';
};

const EMAIL_LOG_SAVEPOINT = 'email_send_log_write';

export const withEmailLogSavepoint = async (client, fn) => {
  await client.query(`SAVEPOINT ${EMAIL_LOG_SAVEPOINT}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${EMAIL_LOG_SAVEPOINT}`);
    return result;
  } catch (error) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${EMAIL_LOG_SAVEPOINT}`); } catch { /* ignore */ }
    throw error;
  }
};

export const logEmail = async (client, row) => {
  try {
    await withEmailLogSavepoint(client, () => client.query(
      `INSERT INTO public.email_send_log (
         id, template_name, recipient_email, tenant_id, status, provider, provider_message_id,
         idempotency_key, error_message, metadata, created_at
       ) VALUES (
         $1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb, now()
       )`,
      [
        row.id || randomUUID(),
        row.template_name || null,
        row.recipient_email,
        row.tenant_id || null,
        row.status || 'sent',
        row.provider || 'aws_staging',
        row.provider_message_id || null,
        row.idempotency_key || null,
        row.error_message || null,
        JSON.stringify(row.metadata || {}),
      ],
    ));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: 'audit_unavailable',
      message: String(error?.message || error).slice(0, 200),
    };
  }
};

export const findIdempotencyRow = async (client, key) => {
  if (!key) return { ok: true, row: null };
  try {
    const { rows } = await client.query(
      `SELECT id::text AS id, status, provider_message_id, recipient_email, tenant_id::text AS tenant_id,
              metadata, error_message
       FROM public.email_send_log
       WHERE idempotency_key = $1
       LIMIT 1`,
      [key],
    );
    return { ok: true, row: rows[0] || null };
  } catch {
    return { ok: false, error: 'idempotency_unavailable' };
  }
};

const isUniqueViolation = (error) => String(error?.code || '') === '23505';

export const claimIdempotencyKey = async (client, row) => {
  if (!row?.idempotency_key) return { ok: true, claimed: false };
  try {
    await withEmailLogSavepoint(client, () => client.query(
      `INSERT INTO public.email_send_log (
         id, template_name, recipient_email, tenant_id, status, provider, provider_message_id,
         idempotency_key, error_message, metadata, created_at
       ) VALUES (
         $1::uuid, $2, $3, $4::uuid, 'pending', $5, NULL, $6, NULL, $7::jsonb, now()
       )`,
      [
        row.id,
        row.template_name || null,
        row.recipient_email,
        row.tenant_id || null,
        row.provider || 'aws_staging',
        row.idempotency_key,
        JSON.stringify({ ...(row.metadata || {}), claimed: true }),
      ],
    ));
    return { ok: true, claimed: true, id: row.id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const prior = await findIdempotencyRow(client, row.idempotency_key);
      if (prior.ok && prior.row) return { ok: true, duplicate: true, row: prior.row };
      return { ok: false, error: 'idempotency_conflict' };
    }
    return { ok: false, error: 'idempotency_unavailable' };
  }
};

export const finalizeClaimedLog = async (client, row) => {
  if (!row?.id) return { ok: false, error: 'audit_unavailable' };
  try {
    await withEmailLogSavepoint(client, () => client.query(
      `UPDATE public.email_send_log
       SET status = $2,
           provider_message_id = $3,
           error_message = $4,
           metadata = $5::jsonb
       WHERE id = $1::uuid`,
      [
        row.id,
        row.status || 'failed',
        row.provider_message_id || null,
        row.error_message || null,
        JSON.stringify(row.metadata || {}),
      ],
    ));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: 'audit_unavailable',
      message: String(error?.message || error).slice(0, 200),
    };
  }
};

const withSpoof = (result, spoof) => ({ ...result, spoofFieldsIgnored: spoof });

export const replayIdempotentSend = (row, spoof) => {
  const sent = row.status === 'sent';
  return withSpoof({
    ok: true,
    statusCode: 200,
    success: true,
    sent,
    queued: false,
    sunk: !sent,
    duplicate: true,
    provider: 'aws_staging',
    id: row.provider_message_id || row.id,
    providerMessageId: row.provider_message_id || null,
    stagingPolicy: row.metadata?.policy || null,
    stagingMode: row.metadata?.mode || null,
    reason: 'idempotent_replay',
  }, spoof);
};

export const stableEmailIdempotencyKey = (...parts) => parts
  .map((part) => String(part ?? '').trim().toLowerCase())
  .filter(Boolean)
  .join(':');

export const validatedMailReplyTo = (value, fallback = defaultReplyTo()) => {
  if (value == null || String(value).trim() === '') {
    const parsedFallback = normalizeReplyTo(fallback);
    if (parsedFallback.ok && parsedFallback.replyTo) return parsedFallback;
    return { ok: true, replyTo: defaultReplyTo() };
  }
  return normalizeReplyTo(value);
};

const auditUnavailable = (error = 'idempotency_unavailable') => ({
  ok: false,
  statusCode: 503,
  success: false,
  error,
});

export const peekAuditedEmail = async (client, idempotencyKey) => {
  const key = String(idempotencyKey || '').trim();
  if (!key) return { ok: true, duplicate: false, row: null };
  const prior = await findIdempotencyRow(client, key);
  if (!prior.ok) {
    if (sesOutboundSendEnabled()) return auditUnavailable();
    return { ok: true, duplicate: false, row: null, lookupFailed: true };
  }
  if (prior.row) return { ok: true, duplicate: true, row: prior.row };
  return { ok: true, duplicate: false, row: null };
};

const defaultMailer = async (args) => {
  const { sendViaSesOrSink } = await import('./email.mjs');
  return sendViaSesOrSink(args);
};

/**
 * Shared pre-send reservation + SES fail-closed audit for one recipient.
 * Callers must authorize the tenant and validate Reply-To before invoking.
 */
export const deliverAuditedEmail = async (client, {
  templateName,
  recipientEmail,
  tenantId = null,
  idempotencyKey,
  metadata = {},
  applicationUserId = null,
  provider = 'aws_staging',
  spoof = null,
  send,
  mailerArgs = {},
  messageId = null,
} = {}) => {
  const email = normalizeEmail(recipientEmail);
  const key = String(idempotencyKey || '').trim();
  const mailer = send || defaultMailer;
  const logId = messageId || randomUUID();
  if (!email) return { ok: false, statusCode: 400, success: false, error: 'missing_recipient' };
  if (!key) return { ok: false, statusCode: 500, success: false, error: 'missing_idempotency_key' };

  const prior = await findIdempotencyRow(client, key);
  if (!prior.ok && sesOutboundSendEnabled()) return auditUnavailable();
  if (prior.ok && prior.row) {
    return {
      ok: true,
      duplicate: true,
      row: prior.row,
      replay: replayIdempotentSend(prior.row, spoof),
      sendResult: null,
      primary: null,
      providerMessageId: prior.row.provider_message_id || null,
    };
  }

  let claimed = false;
  if (prior.ok && !prior.row) {
    const claim = await claimIdempotencyKey(client, {
      id: logId,
      template_name: templateName,
      recipient_email: email,
      tenant_id: tenantId,
      provider,
      idempotency_key: key,
      metadata: {
        ...metadata,
        application_user_id: applicationUserId,
        originalTo: email,
        original_recipient: email,
      },
    });
    if (!claim.ok) {
      if (sesOutboundSendEnabled() || claim.error === 'idempotency_conflict') {
        return auditUnavailable(claim.error || 'idempotency_unavailable');
      }
    } else if (claim.duplicate) {
      return {
        ok: true,
        duplicate: true,
        row: claim.row,
        replay: replayIdempotentSend(claim.row, spoof),
        sendResult: null,
        primary: null,
        providerMessageId: claim.row?.provider_message_id || null,
      };
    } else {
      claimed = claim.claimed === true;
    }
  }

  if (sesOutboundSendEnabled() && !claimed) return auditUnavailable();

  const sendResult = await mailer({
    ...mailerArgs,
    to: mailerArgs.to || email,
    tenantId: mailerArgs.tenantId ?? tenantId,
    messageCategory: mailerArgs.messageCategory || templateName,
  });
  const primary = sendResult?.results?.[0];
  if (!primary) {
    const failedRow = {
      id: logId,
      template_name: templateName,
      recipient_email: email,
      tenant_id: tenantId,
      status: 'failed',
      provider,
      provider_message_id: null,
      idempotency_key: key,
      error_message: 'empty_mailer_result',
      metadata: {
        ...metadata,
        application_user_id: applicationUserId,
        originalTo: email,
        original_recipient: email,
        finalized_at: new Date().toISOString(),
      },
    };
    if (claimed) await finalizeClaimedLog(client, failedRow);
    else await logEmail(client, failedRow);
    return {
      ok: false,
      statusCode: 502,
      success: false,
      error: 'send_failed',
      sendResult,
    };
  }
  const logRow = {
    id: logId,
    template_name: templateName,
    recipient_email: email,
    tenant_id: tenantId,
    status: emailSendLogStatusFromMailer(primary),
    provider,
    provider_message_id: primary.messageId || null,
    idempotency_key: key,
    error_message: primary.error || null,
    metadata: {
      ...metadata,
      application_user_id: applicationUserId,
      policy: primary.policy || null,
      originalTo: primary.originalTo || email,
      original_recipient: primary.originalTo || email,
      mode: sendResult?.mode || null,
      finalized_at: new Date().toISOString(),
    },
  };
  let persist = { ok: true };
  if (claimed) persist = await finalizeClaimedLog(client, logRow);
  else persist = await logEmail(client, logRow);

  if (!persist.ok && sesOutboundSendEnabled() && !claimed) {
    return {
      ...auditUnavailable('audit_unavailable'),
      persist,
      sendResult,
      primary,
    };
  }

  const sent = primary.delivery === 'ses' && primary.status === 'sent';
  return {
    ok: true,
    duplicate: false,
    claimed,
    persist,
    persistError: persist.ok ? null : persist.error || null,
    sendResult,
    primary,
    providerMessageId: primary.messageId || null,
    sent,
    sunk: primary.delivery !== 'ses' || primary.status === 'sunk',
    stagingPolicy: primary.policy || null,
    stagingMode: sendResult?.mode || null,
    id: logId,
  };
};
