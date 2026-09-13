/**
 * Staging email queue worker + suppression/webhook stubs (Class A).
 * Drains pending rows using SES/sink policy — never production Resend.
 */
import { withIdentity, parseBody, ignoredSpoof } from './data.mjs';
import { deliverAuditedEmail, stableEmailIdempotencyKey, validatedMailReplyTo } from './email.mjs';
import { emailMode, normalizeEmail } from './email-policy.mjs';
import { resolveEmailBranding } from './email-branding.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import pg from 'pg';

const { Client } = pg;

export const handleProcessEmailQueue = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const batchSize = Math.min(Number(body.batchSize || body.batch_size || 10), 25);

  // Prefer Cognito-authenticated staff invoke; also allow scheduled secret.
  const scheduledSecret = process.env.AWS_SCHEDULED_JOB_SECRET || '';
  const headerSecret = event.headers?.['x-scheduled-job-secret'] || event.headers?.['X-Scheduled-Job-Secret'];
  const isScheduled = scheduledSecret && headerSecret && headerSecret === scheduledSecret;

  if (!isScheduled) {
    return withIdentity(event, async ({ client, spoof: s }) => (
      processBatch(client, batchSize, s, deps.sendViaSesOrSink)
    ), {
      write: true,
      commit: true,
    });
  }

  let client;
  try {
    const credentials = await loadDatabaseCredentials();
    client = new Client(buildWriteClientConfig(credentials, { queryTimeoutMillis: 20000 }));
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const result = await processBatch(client, batchSize, spoof, deps.sendViaSesOrSink);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'queue_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

const processBatch = async (client, batchSize, spoof, send) => {
  // Prefer email_outbox / email_queue if present; otherwise no-op success.
  let rows = [];
  let table = 'email_outbox';
  try {
    rows = (await client.query(
      `SELECT id, recipient_email, subject, html_body, text_body, template_name, tenant_id, attempts
       FROM public.email_outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1`,
      [batchSize],
    )).rows;
  } catch {
    try {
      table = 'email_queue';
      rows = (await client.query(
        `SELECT id, to_email AS recipient_email, subject, body_html AS html_body, body_text AS text_body,
                template_name, tenant_id, retry_count AS attempts
         FROM public.email_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT $1`,
        [batchSize],
      )).rows;
    } catch {
      return {
        ok: true,
        statusCode: 200,
        processed: 0,
        sunk: 0,
        mode: emailMode(),
        note: 'no_email_queue_table',
        spoofFieldsIgnored: spoof,
      };
    }
  }

  let sunk = 0;
  let sent = 0;
  let skipped = 0;
  for (const row of rows) {
    const branding = row.tenant_id
      ? await resolveEmailBranding(client, { tenantId: row.tenant_id })
      : await resolveEmailBranding(client, { senderOverride: 'checksops' });
    const reply = validatedMailReplyTo(branding?.replyTo);
    if (!reply.ok) {
      skipped += 1;
      continue;
    }
    const delivery = await deliverAuditedEmail(client, {
      templateName: row.template_name || 'queue',
      recipientEmail: row.recipient_email,
      tenantId: row.tenant_id || null,
      idempotencyKey: stableEmailIdempotencyKey('email-queue', row.id),
      provider: 'aws_staging_queue',
      metadata: { queueId: row.id, table },
      spoof,
      send,
      mailerArgs: {
        subject: row.subject || 'ChecksOps notification',
        html: row.html_body || `<pre>${row.text_body || ''}</pre>`,
        text: row.text_body || '',
        from: branding?.from,
        replyTo: reply.replyTo,
      },
    });
    if (!delivery.ok) {
      skipped += 1;
      continue;
    }
    const primary = delivery.primary || {};
    const status = delivery.duplicate
      ? (delivery.row?.status || 'sunk')
      : (primary.delivery === 'ses' && primary.status === 'sent' ? 'sent' : (primary.status === 'failed' ? 'failed' : 'sunk'));
    if (status === 'sunk' || status === 'failed') sunk += 1;
    else sent += 1;
    const updateSql = table === 'email_outbox'
      ? `UPDATE public.email_outbox SET status = $2, updated_at = now() WHERE id = $1`
      : `UPDATE public.email_queue SET status = $2, updated_at = now() WHERE id = $1`;
    try {
      await client.query(updateSql, [row.id, status]);
    } catch {
      /* queue table variants */
    }
  }

  return {
    ok: true,
    statusCode: 200,
    processed: rows.length,
    sunk,
    sent,
    skipped,
    mode: emailMode(),
    spoofFieldsIgnored: spoof,
  };
};

export const processEmailQueueBatch = processBatch;

export const handleEmailSuppression = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const email = normalizeEmail(body.email);
  if (!email) return { ok: false, statusCode: 400, error: 'missing_email', spoofFieldsIgnored: spoof };

  let client;
  try {
    const credentials = await loadDatabaseCredentials();
    client = new Client(buildWriteClientConfig(credentials, { queryTimeoutMillis: 10000 }));
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    await client.query(
      `INSERT INTO public.suppressed_emails (email, reason, source, created_at)
       VALUES ($1, $2, 'aws_staging_suppression', now())
       ON CONFLICT DO NOTHING`,
      [email, body.reason || 'manual'],
    );
    await client.query('COMMIT');
    return { ok: true, statusCode: 200, suppressed: true, spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'suppression_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleResendWebhook = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  // Staging: never apply production Resend bounce automation against live customers.
  return {
    ok: true,
    statusCode: 200,
    received: true,
    stagingDryRun: true,
    type: body?.type || null,
    spoofFieldsIgnored: spoof,
  };
};
