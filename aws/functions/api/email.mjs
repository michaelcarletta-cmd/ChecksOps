/**
 * AWS staging email service (Class A).
 * Preserves invoke shapes for send-transactional-email / send-email / unsubscribe / notifies.
 * Staging-safe by default (sink / allowlist). Never touches production Resend.
 */
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { withIdentity, parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import pg from 'pg';
import {
  applyRecipientPolicy,
  defaultFromAddress,
  defaultReplyTo,
  emailMode,
  mortgageOpsEmail,
  normalizeEmail,
  sesOutboundSendEnabled,
  sinkAddress,
  stagingSesLockApplies,
  stagingSesLockRecipient,
} from './email-policy.mjs';
import { parseFromHeader, resolveEmailBranding } from './email-branding.mjs';
import { renderTransactionalTemplate, TEMPLATE_NAMES } from './email-templates.mjs';
import { sesConfigurationSetName, sesMessageTags } from './email-ses.mjs';
import { normalizeReplyTo, requireAuthorizedTenant } from './tenant-email-domain.mjs';

const { Client } = pg;

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

const sesClient = () => new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });

export const sendViaSesOrSink = async ({
  to,
  subject,
  html,
  text,
  from = defaultFromAddress(),
  replyTo = defaultReplyTo(),
  headers = {},
  sesSend = null,
  tenantId = null,
  messageCategory = null,
  configurationSet = null,
}) => {
  const policyRecipients = applyRecipientPolicy(Array.isArray(to) ? to : [to]);
  const mode = emailMode();
  const parsedFrom = parseFromHeader(from);
  const delivered = [];
  const results = [];
  const replyList = replyTo ? [replyTo] : undefined;
  const configSet = configurationSet || sesConfigurationSetName();
  const tags = sesMessageTags({ tenantId, category: messageCategory });

  for (const recipient of policyRecipients) {
    const entry = {
      to: recipient.email,
      originalTo: recipient.originalEmail,
      delivery: recipient.delivery,
      policy: recipient.policy,
      blocked: recipient.blocked,
      subject,
    };
    if (recipient.delivery === 'ses' && sesOutboundSendEnabled()) {
      const lock = stagingSesLockRecipient();
      if (stagingSesLockApplies() && lock !== recipient.originalEmail) {
        entry.status = 'sunk';
        entry.delivery = 'sink';
        entry.blocked = true;
        entry.policy = lock ? 'staging_ses_lock_mismatch' : 'staging_ses_lock_required';
        entry.messageId = `sink-${randomUUID()}`;
        entry.sink = sinkAddress();
        results.push(entry);
        continue;
      }
      try {
        const cmd = new SendEmailCommand({
          Source: parsedFrom.name ? `${parsedFrom.name} <${parsedFrom.address}>` : parsedFrom.address,
          Destination: { ToAddresses: [recipient.email] },
          ReplyToAddresses: replyList,
          ConfigurationSetName: configSet || undefined,
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: html || `<pre>${text || ''}</pre>`, Charset: 'UTF-8' },
              Text: text ? { Data: text, Charset: 'UTF-8' } : undefined,
            },
          },
          Tags: tags.length ? tags : undefined,
        });
        void headers;
        const out = typeof sesSend === 'function'
          ? await sesSend(cmd)
          : await sesClient().send(cmd);
        entry.messageId = out.MessageId || null;
        entry.status = 'sent';
        delivered.push(recipient.email);
      } catch (error) {
        entry.status = 'failed';
        entry.error = String(error?.message || error).slice(0, 240);
        // Fall back to sink record — never throw production mailer secrets
        entry.delivery = 'sink_fallback';
      }
    } else {
      entry.status = 'sunk';
      entry.messageId = `sink-${randomUUID()}`;
      entry.sink = sinkAddress();
    }
    results.push(entry);
  }

  return {
    mode,
    results,
    deliveredCount: delivered.length,
    sunkCount: results.filter((r) => r.delivery !== 'ses' || r.status === 'sunk').length,
  };
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

const isSuppressed = async (client, email, tenantId) => {
  const addr = normalizeEmail(email);
  const { rows } = await client.query(
    `SELECT id FROM public.suppressed_emails
     WHERE email = $1
       AND ($2::uuid IS NULL OR tenant_id IS NULL OR tenant_id = $2::uuid)
     LIMIT 1`,
    [addr, tenantId || null],
  );
  return rows.length > 0;
};

const withSpoof = (result, spoof) => ({ ...result, spoofFieldsIgnored: spoof });

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

export const hashEmailPayload = (value) => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value ?? ''))
  .digest('hex')
  .slice(0, 16);

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
  const mailer = send || sendViaSesOrSink;
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

const resolveCallerReplyTo = (body, brandingReplyTo) => {
  const override = body.claimEmailCc || body.claim_email_cc || body.replyTo || body.reply_to;
  if (override == null || String(override).trim() === '') {
    return { ok: true, replyTo: brandingReplyTo || defaultReplyTo() };
  }
  const parsed = normalizeReplyTo(override);
  if (!parsed.ok) return parsed;
  return { ok: true, replyTo: parsed.replyTo || brandingReplyTo || defaultReplyTo() };
};

export const runSendTransactionalEmail = async ({
  client, mapping, body, spoof, send,
}) => {
  const templateName = body.templateName || body.template_name;
  const recipientEmail = normalizeEmail(body.recipientEmail || body.recipient_email);
  const tenantId = body.tenantId || body.tenant_id || null;
  const templateData = body.templateData || body.template_data || {};
  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();

  if (!templateName || !TEMPLATE_NAMES.has(templateName)) {
    return withSpoof({
      ok: false,
      statusCode: 400,
      success: false,
      error: 'unknown_template',
      templateName: templateName || null,
    }, spoof);
  }
  if (!recipientEmail) {
    return withSpoof({ ok: false, statusCode: 400, success: false, error: 'missing_recipient' }, spoof);
  }

  const authorized = await requireAuthorizedTenant(client, mapping, tenantId, { configure: false });
  if (!authorized.ok) return withSpoof(authorized, spoof);

  const idempotencyKey = suppliedKey || stableEmailIdempotencyKey(
    'transactional',
    authorized.tenantId,
    templateName,
    recipientEmail,
    hashEmailPayload(templateData),
  );

  if (await isSuppressed(client, recipientEmail, authorized.tenantId)) {
    const suppressed = await logEmail(client, {
      template_name: templateName,
      recipient_email: recipientEmail,
      tenant_id: authorized.tenantId,
      status: 'suppressed',
      provider: 'aws_staging',
      idempotency_key: idempotencyKey,
      metadata: { application_user_id: mapping.application_user_id },
    });
    if (!suppressed.ok && sesOutboundSendEnabled()) {
      return withSpoof(auditUnavailable('audit_unavailable'), spoof);
    }
    return withSpoof({
      ok: true,
      statusCode: 200,
      success: false,
      reason: 'email_suppressed',
    }, spoof);
  }

  const branding = await resolveEmailBranding(client, {
    tenantId: authorized.tenantId,
    senderOverride: body.senderOverride || body.sender_override || null,
  });
  const reply = resolveCallerReplyTo(body, branding.replyTo);
  if (!reply.ok) {
    return withSpoof({
      ok: false,
      statusCode: 400,
      success: false,
      error: reply.error,
      reason: reply.reason || null,
    }, spoof);
  }

  const rendered = renderTransactionalTemplate(templateName, { ...templateData, branding });
  const delivery = await deliverAuditedEmail(client, {
    templateName,
    recipientEmail,
    tenantId: authorized.tenantId,
    idempotencyKey,
    applicationUserId: mapping.application_user_id,
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
  if (!delivery.ok) return withSpoof(delivery, spoof);
  if (delivery.duplicate) return delivery.replay;
  return withSpoof({
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
  }, spoof);
};

export const handleSendTransactionalEmail = async (event, deps = {}) => withIdentity(event, (ctx) => (
  runSendTransactionalEmail({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const runSendEmail = async ({
  client, mapping, body, spoof, send,
}) => {
  const recipients = [];
  if (Array.isArray(body.recipients)) {
    for (const r of body.recipients) recipients.push(r.email || r);
  }
  if (body.to) recipients.push(...(Array.isArray(body.to) ? body.to : [body.to]));
  if (body.email) recipients.push(body.email);
  const uniqueRecipients = [...new Set(recipients.map((email) => normalizeEmail(email)).filter(Boolean))];
  const htmlBody = body.body || body.html || body.htmlBody || body.message || '';
  const textBody = body.text || String(htmlBody).replace(/<[^>]+>/g, ' ');
  if (!uniqueRecipients.length || !body.subject || !htmlBody) {
    return withSpoof({
      ok: false,
      statusCode: 400,
      success: false,
      error: 'missing_fields',
    }, spoof);
  }

  const tenantId = body.tenantId || body.tenant_id || null;
  const authorized = await requireAuthorizedTenant(client, mapping, tenantId, { configure: false });
  if (!authorized.ok) return withSpoof(authorized, spoof);

  const branding = await resolveEmailBranding(client, {
    tenantId: authorized.tenantId,
    senderOverride: body.senderOverride || body.sender_override || null,
  });
  const reply = resolveCallerReplyTo(body, branding.replyTo);
  if (!reply.ok) {
    return withSpoof({
      ok: false,
      statusCode: 400,
      success: false,
      error: reply.error,
      reason: reply.reason || null,
    }, spoof);
  }

  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  const contentHash = hashEmailPayload(`${body.subject}\n${htmlBody}`);
  const deliveries = [];
  for (const email of uniqueRecipients) {
    const idempotencyKey = suppliedKey
      ? stableEmailIdempotencyKey(suppliedKey, email)
      : stableEmailIdempotencyKey('freeform', authorized.tenantId, email, contentHash);
    const delivery = await deliverAuditedEmail(client, {
      templateName: 'freeform-send-email',
      recipientEmail: email,
      tenantId: authorized.tenantId,
      idempotencyKey,
      applicationUserId: mapping.application_user_id,
      metadata: {
        checkId: body.checkId || null,
        claimId: body.claimId || null,
      },
      spoof,
      send,
      mailerArgs: {
        subject: String(body.subject),
        html: String(htmlBody),
        text: String(textBody),
        from: branding.from,
        replyTo: reply.replyTo,
        headers: body.headers || {},
      },
    });
    if (!delivery.ok) return withSpoof(delivery, spoof);
    deliveries.push(delivery);
  }

  const firstSent = deliveries.find((row) => !row.duplicate) || deliveries[0];
  const allDuplicate = deliveries.every((row) => row.duplicate);
  if (allDuplicate && firstSent?.replay) {
    return withSpoof({
      ...firstSent.replay,
      recipientCount: uniqueRecipients.length,
      attachmentCount: Array.isArray(body.attachments) ? body.attachments.length : 0,
    }, spoof);
  }
  return withSpoof({
    ok: true,
    statusCode: 200,
    success: true,
    recipientCount: uniqueRecipients.length,
    attachmentCount: Array.isArray(body.attachments) ? body.attachments.length : 0,
    messageId: firstSent?.providerMessageId || null,
    providerMessageId: firstSent?.providerMessageId || null,
    stagingMode: firstSent?.stagingMode || firstSent?.replay?.stagingMode || null,
    stagingPolicy: firstSent?.stagingPolicy || firstSent?.replay?.stagingPolicy || null,
    duplicate: false,
  }, spoof);
};

export const handleSendEmail = async (event, deps = {}) => withIdentity(event, (ctx) => (
  runSendEmail({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const handleEmailUnsubscribe = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const method = (event.requestContext?.http?.method || event.httpMethod || 'POST').toUpperCase();
  const qs = event.queryStringParameters || {};
  const token = String(body.token || qs.token || '').trim();
  if (!token) {
    return { ok: false, statusCode: 400, success: false, error: 'missing_token', spoofFieldsIgnored: spoof };
  }

  let client;
  try {
    const credentials = await loadDatabaseCredentials();
    client = new Client(buildWriteClientConfig(credentials, { queryTimeoutMillis: 10000 }));
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');

    const tok = (await client.query(
      `SELECT id, email, used_at FROM public.email_unsubscribe_tokens WHERE token = $1 LIMIT 1`,
      [token],
    )).rows[0];

    if (!tok) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, success: false, error: 'invalid_token', spoofFieldsIgnored: spoof };
    }

    if (method === 'GET') {
      await client.query('ROLLBACK');
      return { ok: true, statusCode: 200, valid: true, spoofFieldsIgnored: spoof };
    }

    if (tok.used_at) {
      await client.query('ROLLBACK');
      return { ok: true, statusCode: 200, success: false, reason: 'already_unsubscribed', spoofFieldsIgnored: spoof };
    }

    await client.query(
      `INSERT INTO public.suppressed_emails (email, reason, source, created_at)
       VALUES ($1, 'unsubscribe', 'aws_staging_unsubscribe', now())
       ON CONFLICT DO NOTHING`,
      [normalizeEmail(tok.email)],
    );
    await client.query(
      `UPDATE public.email_unsubscribe_tokens SET used_at = now() WHERE id = $1::uuid`,
      [tok.id],
    );
    await client.query('COMMIT');
    return { ok: true, statusCode: 200, success: true, spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      success: false,
      error: 'unsubscribe_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handlePreviewTransactionalEmail = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const previews = {};
  for (const name of TEMPLATE_NAMES) {
    previews[name] = renderTransactionalTemplate(name, body.templateData || {});
  }
  return {
    ok: true,
    statusCode: 200,
    success: true,
    templates: previews,
    stagingMode: emailMode(),
    spoofFieldsIgnored: spoof,
  };
};

/** Staff notify wrappers that compose transactional mailer. */
export const runNotifyMortgageHandlingRequest = async ({
  client, mapping, body, spoof, send,
}) => {
  const requestId = body.request_id;
  if (!requestId) {
    return { ok: false, statusCode: 400, error: 'missing_request_id', spoofFieldsIgnored: spoof };
  }
  const row = (await client.query(
    `SELECT id, tenant_id, mortgage_company, status, claim_id
     FROM public.mortgage_handling_requests WHERE id = $1::uuid LIMIT 1`,
    [requestId],
  )).rows[0];
  if (!row) {
    return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  }
  const authorized = await requireAuthorizedTenant(client, mapping, row.tenant_id, { configure: false });
  if (!authorized.ok) return { ...authorized, spoofFieldsIgnored: spoof };

  const opsTo = normalizeEmail(mortgageOpsEmail());
  if (!opsTo) {
    return { ok: false, statusCode: 400, error: 'missing_ops_recipient', spoofFieldsIgnored: spoof };
  }
  const branding = await resolveEmailBranding(client, {
    tenantId: authorized.tenantId,
    senderOverride: 'checksops',
  });
  const reply = validatedMailReplyTo(branding.replyTo);
  if (!reply.ok) {
    return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
  }
  const rendered = renderTransactionalTemplate('mortgage-handling-request', {
    mortgageCompany: row.mortgage_company,
    status: row.status,
    requestId: row.id,
    branding,
  });
  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  const delivery = await deliverAuditedEmail(client, {
    templateName: 'notify-mortgage-handling-request',
    recipientEmail: opsTo,
    tenantId: authorized.tenantId,
    idempotencyKey: suppliedKey || stableEmailIdempotencyKey('mortgage-desk', authorized.tenantId, requestId),
    applicationUserId: mapping.application_user_id,
    metadata: { request_id: requestId },
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
    return { ...delivery.replay, emailed: true, spoofFieldsIgnored: spoof };
  }
  return {
    ok: true,
    statusCode: 200,
    emailed: true,
    stagingMode: delivery.stagingMode,
    providerMessageId: delivery.providerMessageId,
    spoofFieldsIgnored: spoof,
  };
};

export const handleNotifyMortgageHandlingRequest = (event, deps = {}) => withIdentity(event, (ctx) => (
  runNotifyMortgageHandlingRequest({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

const authorizeLeadCaller = async (client, mapping, lead) => {
  if (lead.contractor_user_id === mapping.application_user_id) {
    const tenant = (await client.query(
      `SELECT tenant_id::text AS tenant_id FROM public.tenant_users WHERE user_id = $1::uuid LIMIT 1`,
      [lead.contractor_user_id],
    )).rows[0];
    return { ok: true, tenantId: tenant?.tenant_id || null };
  }
  const shared = (await client.query(
    `SELECT tu.tenant_id::text AS tenant_id
     FROM public.tenant_users tu
     WHERE tu.user_id = $1::uuid
       AND tu.tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = $2::uuid)
     LIMIT 1`,
    [mapping.application_user_id, lead.contractor_user_id],
  )).rows[0];
  if (!shared) return { ok: false, statusCode: 403, error: 'not_authorized' };
  return { ok: true, tenantId: shared.tenant_id };
};

export const runNotifyHomeownerLead = async ({
  client, mapping, body, spoof, send,
}) => {
  const leadId = body.lead_id;
  if (!leadId) return { ok: false, statusCode: 400, error: 'missing_lead_id', spoofFieldsIgnored: spoof };
  const lead = (await client.query(
    `SELECT id, homeowner_name, homeowner_email, contractor_user_id, access_token, status
     FROM public.homeowner_intro_requests WHERE id = $1::uuid LIMIT 1`,
    [leadId],
  )).rows[0];
  if (!lead) return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };

  const access = await authorizeLeadCaller(client, mapping, lead);
  if (!access.ok) return { ...access, spoofFieldsIgnored: spoof };

  const contractor = (await client.query(
    `SELECT email FROM public.profiles WHERE id = $1::uuid LIMIT 1`,
    [lead.contractor_user_id],
  )).rows[0];
  const to = normalizeEmail(contractor?.email);
  if (!to) {
    return { ok: false, statusCode: 400, error: 'missing_recipient', reason: 'no_contractor_email', spoofFieldsIgnored: spoof };
  }

  const branding = await resolveEmailBranding(client, { senderOverride: 'checksops' });
  const reply = validatedMailReplyTo(branding.replyTo);
  if (!reply.ok) {
    return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
  }
  const rendered = renderTransactionalTemplate('new-homeowner-lead', {
    homeownerName: lead.homeowner_name,
    leadId: lead.id,
    branding,
  });
  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  const delivery = await deliverAuditedEmail(client, {
    templateName: 'new-homeowner-lead',
    recipientEmail: to,
    tenantId: access.tenantId,
    idempotencyKey: suppliedKey || stableEmailIdempotencyKey('homeowner-lead', leadId),
    applicationUserId: mapping.application_user_id,
    metadata: { lead_id: leadId },
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
    providerMessageId: delivery.providerMessageId,
    spoofFieldsIgnored: spoof,
  };
};

export const handleNotifyHomeownerLead = (event, deps = {}) => withIdentity(event, (ctx) => (
  runNotifyHomeownerLead({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const runNotifyHomeownerLeadAccepted = async ({
  client, mapping, body, spoof, send,
}) => {
  const leadId = body.lead_id;
  if (!leadId) return { ok: false, statusCode: 400, error: 'missing_lead_id', spoofFieldsIgnored: spoof };
  const lead = (await client.query(
    `SELECT id, homeowner_name, homeowner_email, access_token, contractor_user_id, status
     FROM public.homeowner_intro_requests WHERE id = $1::uuid LIMIT 1`,
    [leadId],
  )).rows[0];
  if (!lead) return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  if (lead.contractor_user_id !== mapping.application_user_id) {
    return { ok: false, statusCode: 403, error: 'not_authorized', spoofFieldsIgnored: spoof };
  }
  const to = normalizeEmail(lead.homeowner_email);
  if (!to) {
    return { ok: false, statusCode: 400, error: 'missing_recipient', reason: 'no_homeowner_email', spoofFieldsIgnored: spoof };
  }

  const access = await authorizeLeadCaller(client, mapping, lead);
  const origin = String(body.origin || process.env.VITE_APP_URL || process.env.SIGN_BASE_URL || 'https://staging.checksops.com').replace(/\/$/, '');
  const link = `${origin}/h/claim/${lead.access_token}`;
  const branding = await resolveEmailBranding(client, { senderOverride: 'checksops' });
  const reply = validatedMailReplyTo(branding.replyTo);
  if (!reply.ok) {
    return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
  }
  const rendered = renderTransactionalTemplate('homeowner-claim-portal-link', {
    homeownerName: lead.homeowner_name,
    portalUrl: link,
    branding,
  });
  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  const delivery = await deliverAuditedEmail(client, {
    templateName: 'homeowner-claim-portal-link',
    recipientEmail: to,
    tenantId: access.tenantId || null,
    idempotencyKey: suppliedKey || stableEmailIdempotencyKey('homeowner-lead-accepted', leadId),
    applicationUserId: mapping.application_user_id,
    metadata: { lead_id: leadId },
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
    providerMessageId: delivery.providerMessageId,
    spoofFieldsIgnored: spoof,
  };
};

export const handleNotifyHomeownerLeadAccepted = (event, deps = {}) => withIdentity(event, (ctx) => (
  runNotifyHomeownerLeadAccepted({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const createUnsubscribeToken = async (client, email) => {
  const token = randomBytes(24).toString('hex');
  await client.query(
    `INSERT INTO public.email_unsubscribe_tokens (token, email, created_at)
     VALUES ($1, $2, now())`,
    [token, normalizeEmail(email)],
  );
  return token;
};

export { randomBytes, createHash, randomUUID };
