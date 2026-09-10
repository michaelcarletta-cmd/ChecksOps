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
  sinkAddress,
} from './email-policy.mjs';
import { parseFromHeader, resolveEmailBranding } from './email-branding.mjs';
import { renderTransactionalTemplate, TEMPLATE_NAMES } from './email-templates.mjs';

const { Client } = pg;

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
}) => {
  const policyRecipients = applyRecipientPolicy(Array.isArray(to) ? to : [to]);
  const mode = emailMode();
  const parsedFrom = parseFromHeader(from);
  const delivered = [];
  const results = [];
  const replyList = replyTo ? [replyTo] : undefined;

  for (const recipient of policyRecipients) {
    const entry = {
      to: recipient.email,
      originalTo: recipient.originalEmail,
      delivery: recipient.delivery,
      policy: recipient.policy,
      blocked: recipient.blocked,
      subject,
    };
    if (recipient.delivery === 'ses' && mode === 'ses') {
      try {
        const cmd = new SendEmailCommand({
          Source: parsedFrom.name ? `${parsedFrom.name} <${parsedFrom.address}>` : parsedFrom.address,
          Destination: { ToAddresses: [recipient.email] },
          ReplyToAddresses: replyList,
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: html || `<pre>${text || ''}</pre>`, Charset: 'UTF-8' },
              Text: text ? { Data: text, Charset: 'UTF-8' } : undefined,
            },
          },
          Tags: Object.entries(headers || {}).slice(0, 5).map(([Name, Value]) => ({
            Name: String(Name).slice(0, 50),
            Value: String(Value).slice(0, 256),
          })),
        });
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

const logEmail = async (client, row) => {
  try {
    await client.query(
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
    );
  } catch {
    // Logging must not break send path; schema variants exist across dumps.
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

export const handleSendTransactionalEmail = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const templateName = body.templateName || body.template_name;
  const recipientEmail = normalizeEmail(body.recipientEmail || body.recipient_email);
  const tenantId = body.tenantId || body.tenant_id || null;
  const templateData = body.templateData || body.template_data || {};
  const idempotencyKey = body.idempotencyKey || body.idempotency_key || randomUUID();
  const messageId = randomUUID();

  if (!templateName || !TEMPLATE_NAMES.has(templateName)) {
    return {
      ok: false,
      statusCode: 400,
      success: false,
      error: 'unknown_template',
      templateName: templateName || null,
      spoofFieldsIgnored: spoof,
    };
  }
  if (!recipientEmail) {
    return { ok: false, statusCode: 400, success: false, error: 'missing_recipient', spoofFieldsIgnored: spoof };
  }

  if (await isSuppressed(client, recipientEmail, tenantId)) {
    await logEmail(client, {
      id: messageId,
      template_name: templateName,
      recipient_email: recipientEmail,
      tenant_id: tenantId,
      status: 'suppressed',
      provider: 'aws_staging',
      idempotency_key: idempotencyKey,
      metadata: { application_user_id: mapping.application_user_id },
    });
    return {
      ok: true,
      statusCode: 200,
      success: false,
      reason: 'email_suppressed',
      spoofFieldsIgnored: spoof,
    };
  }

  const branding = await resolveEmailBranding(client, {
    tenantId,
    senderOverride: body.senderOverride || body.sender_override || null,
  });
  const rendered = renderTransactionalTemplate(templateName, { ...templateData, branding });
  const send = await sendViaSesOrSink({
    to: recipientEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });

  const primary = send.results[0] || {};
  await logEmail(client, {
    id: messageId,
    template_name: templateName,
    recipient_email: recipientEmail,
    tenant_id: tenantId,
    status: primary.status === 'failed' ? 'failed' : (primary.delivery === 'ses' ? 'sent' : 'sunk'),
    provider: 'aws_staging',
    provider_message_id: primary.messageId || null,
    idempotency_key: idempotencyKey,
    error_message: primary.error || null,
    metadata: {
      application_user_id: mapping.application_user_id,
      policy: primary.policy,
      originalTo: primary.originalTo,
      mode: send.mode,
    },
  });

  return {
    ok: true,
    statusCode: 200,
    success: true,
    sent: primary.delivery === 'ses' && primary.status === 'sent',
    queued: false,
    sunk: primary.delivery !== 'ses' || primary.status === 'sunk',
    provider: 'aws_staging',
    id: primary.messageId || messageId,
    stagingPolicy: primary.policy,
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleSendEmail = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const recipients = [];
  if (Array.isArray(body.recipients)) {
    for (const r of body.recipients) recipients.push(r.email || r);
  }
  if (body.to) recipients.push(...(Array.isArray(body.to) ? body.to : [body.to]));
  if (body.email) recipients.push(body.email);
  const htmlBody = body.body || body.html || body.htmlBody || body.message || '';
  const textBody = body.text || String(htmlBody).replace(/<[^>]+>/g, ' ');
  if (!recipients.length || !body.subject || !htmlBody) {
    return {
      ok: false,
      statusCode: 400,
      success: false,
      error: 'missing_fields',
      spoofFieldsIgnored: spoof,
    };
  }

  const branding = await resolveEmailBranding(client, {
    tenantId: body.tenantId || body.tenant_id || null,
    senderOverride: body.senderOverride || body.sender_override || null,
  });
  const send = await sendViaSesOrSink({
    to: recipients,
    subject: String(body.subject),
    html: String(htmlBody),
    text: String(textBody),
    from: branding.from,
    replyTo: body.claimEmailCc || body.replyTo || branding.replyTo,
    headers: body.headers || {},
  });

  for (const result of send.results) {
    await logEmail(client, {
      template_name: 'freeform-send-email',
      recipient_email: result.originalTo || result.to,
      tenant_id: body.tenantId || null,
      status: result.status === 'failed' ? 'failed' : (result.delivery === 'ses' ? 'sent' : 'sunk'),
      provider: 'aws_staging',
      provider_message_id: result.messageId || null,
      metadata: {
        checkId: body.checkId || null,
        claimId: body.claimId || null,
        application_user_id: mapping.application_user_id,
        policy: result.policy,
      },
    });
  }

  return {
    ok: true,
    statusCode: 200,
    success: true,
    recipientCount: send.results.length,
    attachmentCount: Array.isArray(body.attachments) ? body.attachments.length : 0,
    messageId: send.results[0]?.messageId || null,
    stagingMode: send.mode,
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

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
  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [mapping.application_user_id, row.tenant_id],
  )).rows[0];
  if (!member) {
    return { ok: false, statusCode: 403, error: 'cross_tenant_denied', spoofFieldsIgnored: spoof };
  }

  const opsTo = normalizeEmail(mortgageOpsEmail());
  if (!opsTo) {
    return { ok: false, statusCode: 400, error: 'missing_ops_recipient', spoofFieldsIgnored: spoof };
  }
  const branding = await resolveEmailBranding(client, {
    tenantId: row.tenant_id,
    senderOverride: 'checksops',
  });
  const rendered = renderTransactionalTemplate('mortgage-handling-request', {
    mortgageCompany: row.mortgage_company,
    status: row.status,
    requestId: row.id,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  const sendResult = await mailer({
    to: opsTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });

  await logEmail(client, {
    template_name: 'notify-mortgage-handling-request',
    recipient_email: opsTo,
    tenant_id: row.tenant_id,
    status: sendResult.results[0]?.delivery === 'ses' ? 'sent' : 'sunk',
    provider: 'aws_staging',
    provider_message_id: sendResult.results[0]?.messageId || null,
    metadata: { request_id: requestId, application_user_id: mapping.application_user_id },
  });

  return {
    ok: true,
    statusCode: 200,
    emailed: true,
    stagingMode: sendResult.mode,
    spoofFieldsIgnored: spoof,
  };
};

export const handleNotifyMortgageHandlingRequest = (event, deps = {}) => withIdentity(event, (ctx) => (
  runNotifyMortgageHandlingRequest({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

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

  const contractor = (await client.query(
    `SELECT email FROM public.profiles WHERE id = $1::uuid LIMIT 1`,
    [lead.contractor_user_id],
  )).rows[0];
  const to = normalizeEmail(contractor?.email);
  if (!to) {
    return { ok: false, statusCode: 400, error: 'missing_recipient', reason: 'no_contractor_email', spoofFieldsIgnored: spoof };
  }

  const branding = await resolveEmailBranding(client, { senderOverride: 'checksops' });
  const rendered = renderTransactionalTemplate('new-homeowner-lead', {
    homeownerName: lead.homeowner_name,
    leadId: lead.id,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  const sendResult = await mailer({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });
  await logEmail(client, {
    template_name: 'new-homeowner-lead',
    recipient_email: to,
    status: sendResult.results[0]?.delivery === 'ses' ? 'sent' : 'sunk',
    provider: 'aws_staging',
    provider_message_id: sendResult.results[0]?.messageId || null,
    metadata: { lead_id: leadId, application_user_id: mapping.application_user_id },
  });
  return { ok: true, statusCode: 200, success: true, spoofFieldsIgnored: spoof };
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

  const origin = String(body.origin || process.env.VITE_APP_URL || process.env.SIGN_BASE_URL || 'https://staging.checksops.com').replace(/\/$/, '');
  const link = `${origin}/h/claim/${lead.access_token}`;
  const branding = await resolveEmailBranding(client, { senderOverride: 'checksops' });
  const rendered = renderTransactionalTemplate('homeowner-claim-portal-link', {
    homeownerName: lead.homeowner_name,
    portalUrl: link,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  const sendResult = await mailer({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });
  await logEmail(client, {
    template_name: 'homeowner-claim-portal-link',
    recipient_email: to,
    status: sendResult.results[0]?.delivery === 'ses' ? 'sent' : 'sunk',
    provider: 'aws_staging',
    provider_message_id: sendResult.results[0]?.messageId || null,
    metadata: { lead_id: leadId },
  });
  return { ok: true, statusCode: 200, success: true, spoofFieldsIgnored: spoof };
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
