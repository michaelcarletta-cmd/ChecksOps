/**
 * Tenant fee invoice email (owner decision 2026-10-17: "invoice email after a pull: yes").
 *
 * Ordering (outbox, review fix): nothing is sent inside the pull's transaction.
 *   1. The pull's transaction books the charge and queues one
 *      tenant_fee_invoice_outbox row (status pending, keyed on the charge),
 *      committed together. A pull whose commit fails leaves no row, so no
 *      email can ever go out for a rolled-back charge.
 *   2. After the commit, a short transaction claims the row (pending/failed
 *      -> sending) and renders the email.
 *   3. The email is sent outside any transaction.
 *   4. A second short transaction records the outcome (sent / sunk / failed /
 *      no_recipient), an email_send_log row and an invoice_email audit row.
 * A crash between 1 and 2 leaves the row pending: the platform owner's resend
 * (tenant-billing-admin invoice-resend) sends it once. A crash between 2 and
 * 4 leaves it sending (delivery unconfirmed): it is never sent again
 * automatically; the platform owner may release it with confirm_unsent after
 * checking the send log. A sent or sunk row is final, so the email goes out at
 * most once per charge (also enforced by SQL 98's unique index on sent / sunk
 * invoice_email audit rows).
 *
 * Reuses the AWS email path: sendViaSesOrSink (SES, or the staging sink /
 * allowlist policy in email-policy.mjs), the shared ChecksOps layout, the
 * ChecksOps sending address (platformBranding) with the tenant's name and
 * logo (resolveEmailBranding), and an email_send_log row with the usual
 * statuses. A failed email never fails or rolls back the pull.
 *
 * Contents: tenant name, period, date, the booked lines and total, and the
 * last four digits of the debited account. No full account or routing
 * numbers, no other personal data.
 *
 * Recipient: the member who authorized the ACH debit
 * (tenant_billing_accounts.ach_authorized_by -> identity_accounts.email): the
 * billing contact who consented to this charge. Fallback: the tenant's
 * business address (tenants.company_email, SQL 93). Users-only roles (SQL 90)
 * mean there is no "owner" role to pick instead.
 *
 * Flag AWS_TENANT_FEE_INVOICE_EMAIL_ENABLED: 'true' / 'false' wins; unset is
 * on everywhere except the production runtime, where it stays off until the
 * owner sets it to true.
 */
import { sendViaSesOrSink } from './email.mjs';
import { renderChecksOpsEmail } from './email-layout.mjs';
import { platformBranding, resolveEmailBranding } from './email-branding.mjs';
import { normalizeEmail } from './email-policy.mjs';
import { isProductionChecksOpsRuntime } from './tenant-billing-destination.mjs';

export const FEE_INVOICE_EMAIL_FLAG = 'AWS_TENANT_FEE_INVOICE_EMAIL_ENABLED';
export const FEE_INVOICE_TEMPLATE = 'tenant-fee-invoice';
export const FEE_INVOICE_SENT_OUTCOMES = Object.freeze(['sent', 'sunk']);

export const feeInvoiceEmailEnabled = (env = process.env) => {
  const value = String(env[FEE_INVOICE_EMAIL_FLAG] || '').trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return !isProductionChecksOpsRuntime(env.CHECKSOPS_ENV);
};

export const feeInvoiceIdempotencyKey = (occurrenceId) => `fee-invoice:${occurrenceId}`;

/** Last four digits only; anything else becomes null. */
export const last4Only = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

const usd = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const int = (value) => Number(value || 0);

/** Invoice lines from the booked charge row (the amount actually pulled). */
export function occurrenceInvoiceLines(row) {
  const rate = int(row.monthly_rate_cents);
  const discount = Math.min(int(row.discount_cents), rate);
  return [
    { label: 'Monthly maintenance', count: 1, amount_cents: rate },
    { label: 'Referral discount', count: discount > 0 ? 1 : 0, amount_cents: -discount },
    { label: 'Check processing', count: int(row.check_count), amount_cents: int(row.check_usage_cents) },
    { label: 'Next-day deposits', count: int(row.next_day_count), amount_cents: int(row.next_day_usage_cents) },
    { label: 'Same-day deposits', count: int(row.same_day_count), amount_cents: int(row.same_day_usage_cents) },
    { label: 'MortgageOps initial requests', count: int(row.mortgage_ops_initial_count), amount_cents: int(row.mortgage_ops_initial_amount_cents) },
    { label: 'MortgageOps additional requests', count: int(row.mortgage_ops_additional_count), amount_cents: int(row.mortgage_ops_additional_amount_cents) },
  ].filter((line) => line.count > 0 || line.amount_cents !== 0);
}

export function buildFeeInvoiceEmail({
  tenantName, period, chargedAt, amountCents, lines, last4, branding = {},
}) {
  const name = String(tenantName || 'your company').slice(0, 120);
  const date = (chargedAt ? new Date(chargedAt) : new Date()).toISOString().slice(0, 10);
  const account = last4 ? `the bank account ending in ${last4}` : 'your authorized bank account';
  const lineText = (lines || []).map((line) => `${line.label}${line.count > 1 ? ` (${line.count})` : ''}: ${usd(line.amount_cents)}`);
  const paragraphs = [
    `ChecksOps fees for ${name}, billing period ${period}.`,
    ...lineText,
    `Total: ${usd(amountCents)}`,
    `Collected by ACH on ${date} from ${account}.`,
    'Questions about this invoice? Reply to this email or contact support@checksops.com.',
  ];
  const layout = renderChecksOpsEmail({
    title: `ChecksOps invoice ${period}`,
    preview: `${usd(amountCents)} collected for ${period}`,
    paragraphs,
    companySubtitle: branding.companySubtitle || name,
    logoUrl: branding.logoUrl || null,
  });
  return {
    subject: `ChecksOps invoice ${period}: ${usd(amountCents)}`,
    html: layout.html,
    text: [`ChecksOps invoice ${period}`, ...paragraphs].join('\n'),
    summary: { period, date, amount_cents: amountCents, lines, last4: last4 || null },
  };
}

export const OUTBOX_QUEUE_SQL = `INSERT INTO public.tenant_fee_invoice_outbox (occurrence_id, tenant_id, billing_period, status)
VALUES ($1::uuid, $2::uuid, $3, 'pending')
ON CONFLICT (occurrence_id) DO NOTHING`;

export const OUTBOX_LOCK_SQL = `SELECT occurrence_id, tenant_id, billing_period, status, attempts
FROM public.tenant_fee_invoice_outbox WHERE occurrence_id = $1::uuid FOR UPDATE`;

/**
 * Step 1, inside the pull's (or resend's) transaction: queue the invoice for
 * this charge. Never throws and never aborts the caller's transaction
 * (savepoint): a queue failure leaves the charge intact and is reported.
 */
export async function queueFeeInvoiceEmail(client, { occurrenceId, tenantId, period, deps = {} }) {
  if (!(deps.invoiceEmailEnabled ?? feeInvoiceEmailEnabled())) return { status: 'disabled', sent: false };
  await client.query('SAVEPOINT fee_invoice_queue');
  try {
    await client.query(OUTBOX_QUEUE_SQL, [occurrenceId, tenantId, period]);
    await client.query('RELEASE SAVEPOINT fee_invoice_queue');
    return { status: 'pending', sent: false, occurrence_id: occurrenceId };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT fee_invoice_queue').catch(() => {});
    return { status: 'queue_failed', sent: false, error: String(error?.message || error).slice(0, 240) };
  }
}

async function resolveRecipient(client, { tenantId, authorization }) {
  if (authorization?.ach_authorized_by) {
    const row = (await client.query(
      'SELECT email FROM public.identity_accounts WHERE application_user_id = $1::uuid LIMIT 1',
      [authorization.ach_authorized_by],
    )).rows[0];
    const email = normalizeEmail(row?.email);
    if (email && email.includes('@')) return { email, source: 'ach_authorizer' };
  }
  const tenant = (await client.query(
    'SELECT company_email FROM public.tenants WHERE id = $1::uuid',
    [tenantId],
  )).rows[0];
  const email = normalizeEmail(tenant?.company_email);
  if (email && email.includes('@')) return { email, source: 'company_email' };
  return null;
}

const CLAIMABLE = new Set(['pending', 'failed', 'no_recipient']);

/**
 * Steps 2 to 4, after the charge committed. runTxn(fn) runs fn({ client }) in
 * its own committed transaction with the caller's identity (fn returns
 * { ok: true, ... }). Never throws.
 */
export async function deliverFeeInvoiceEmail({
  runTxn, occurrenceId, recordAudit, confirmUnsent = false, resend = false, deps = {},
}) {
  if (!(deps.invoiceEmailEnabled ?? feeInvoiceEmailEnabled())) return { status: 'disabled', sent: false };
  const key = feeInvoiceIdempotencyKey(occurrenceId);
  // 2) claim and render
  let claim;
  try {
    claim = await runTxn(async ({ client }) => {
      const row = (await client.query(OUTBOX_LOCK_SQL, [occurrenceId])).rows[0];
      if (!row) return { ok: true, claimed: false, status: 'no_pending_invoice' };
      if (FEE_INVOICE_SENT_OUTCOMES.includes(row.status)) return { ok: true, claimed: false, status: 'already_sent' };
      if (row.status === 'sending' && !confirmUnsent) return { ok: true, claimed: false, status: 'delivery_unconfirmed' };
      if (!CLAIMABLE.has(row.status) && row.status !== 'sending') return { ok: true, claimed: false, status: row.status };
      const occurrence = (await client.query(
        'SELECT * FROM public.tenant_maintenance_payments WHERE id = $1::uuid',
        [occurrenceId],
      )).rows[0];
      if (!occurrence || !['submitted', 'settled'].includes(occurrence.status)) {
        return { ok: true, claimed: false, status: 'not_charged' };
      }
      const authorization = (await client.query(
        `SELECT ach_authorized_by, account_number_last4 FROM public.tenant_billing_accounts WHERE tenant_id = $1::uuid`,
        [row.tenant_id],
      )).rows[0] || null;
      await client.query(
        `UPDATE public.tenant_fee_invoice_outbox SET status = 'sending', attempts = attempts + 1, updated_at = now()
         WHERE occurrence_id = $1::uuid`,
        [occurrenceId],
      );
      const recipient = await resolveRecipient(client, { tenantId: row.tenant_id, authorization });
      if (!recipient) return { ok: true, claimed: true, row, occurrence, recipient: null };
      const tenant = (await client.query('SELECT name FROM public.tenants WHERE id = $1::uuid', [row.tenant_id])).rows[0];
      await client.query('SAVEPOINT fee_invoice_branding');
      let branding = {};
      try {
        branding = await resolveEmailBranding(client, { tenantId: row.tenant_id });
        await client.query('RELEASE SAVEPOINT fee_invoice_branding');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT fee_invoice_branding').catch(() => {});
      }
      const email = buildFeeInvoiceEmail({
        tenantName: tenant?.name,
        period: row.billing_period,
        chargedAt: occurrence.submitted_at || occurrence.updated_at || null,
        amountCents: int(occurrence.amount_cents),
        lines: occurrenceInvoiceLines(occurrence),
        last4: last4Only(authorization?.account_number_last4),
        branding,
      });
      return { ok: true, claimed: true, row, occurrence, recipient, email };
    });
  } catch (error) {
    return { status: 'failed', sent: false, idempotency_key: key, error: String(error?.message || error).slice(0, 240) };
  }
  if (!claim || claim.ok !== true) {
    // The claim did not commit: nothing was sent and the row is unchanged.
    return { status: 'failed', sent: false, idempotency_key: key, error: claim?.error || 'claim_not_committed' };
  }
  if (!claim.claimed) return { status: claim.status, sent: false, idempotency_key: key };

  // 3) send, outside any transaction
  let result;
  if (!claim.recipient) {
    result = { status: 'no_recipient', sent: false };
  } else {
    try {
      const mailer = deps.sendViaSesOrSink || sendViaSesOrSink;
      const platform = platformBranding();
      const sent = await mailer({
        to: claim.recipient.email,
        subject: claim.email.subject,
        html: claim.email.html,
        text: claim.email.text,
        from: platform.from,
        replyTo: platform.replyTo,
        tenantId: claim.row.tenant_id,
        messageCategory: FEE_INVOICE_TEMPLATE,
      });
      const primary = sent?.results?.[0] || {};
      const status = primary.status === 'failed' || !sent?.results?.length
        ? 'failed'
        : (primary.delivery === 'ses' && primary.status === 'sent' ? 'sent' : 'sunk');
      result = {
        status,
        sent: status === 'sent' || status === 'sunk',
        recipient_source: claim.recipient.source,
        message_id: primary.messageId || null,
        error: primary.error || null,
        mode: sent?.mode || null,
      };
    } catch (error) {
      result = { status: 'failed', sent: false, recipient_source: claim.recipient.source, error: String(error?.message || error).slice(0, 240) };
    }
  }

  // 4) record the outcome (a failure here leaves the row 'sending': never resent automatically)
  try {
    const recorded = await runTxn(async ({ client }) => {
      await client.query(
        `UPDATE public.tenant_fee_invoice_outbox
         SET status = $2, last_error = $3, message_id = COALESCE($4, message_id), updated_at = now()
         WHERE occurrence_id = $1::uuid`,
        [occurrenceId, result.status, result.error || null, result.message_id || null],
      );
      if (claim.recipient) {
        await client.query('SAVEPOINT fee_invoice_email_log');
        try {
          await client.query(
            `INSERT INTO public.email_send_log (
               id, template_name, recipient_email, tenant_id, status, provider, provider_message_id,
               idempotency_key, error_message, metadata, created_at
             ) VALUES (gen_random_uuid(), $1, $2, $3::uuid, $4, 'aws_ses', $5, $6, $7, $8::jsonb, now())`,
            [
              FEE_INVOICE_TEMPLATE, claim.recipient.email, claim.row.tenant_id, result.status,
              result.message_id || null, key, result.error || null,
              JSON.stringify({ occurrence_id: occurrenceId, billing_period: claim.row.billing_period, mode: result.mode || null, resend }),
            ],
          );
          await client.query('RELEASE SAVEPOINT fee_invoice_email_log');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT fee_invoice_email_log').catch(() => {});
        }
      }
      const audit = typeof recordAudit === 'function'
        ? await recordAudit(client, {
          event: 'invoice_email',
          tenantId: claim.row.tenant_id,
          period: claim.row.billing_period,
          amountCents: int(claim.occurrence.amount_cents),
          occurrenceId,
          outcome: result.status,
          details: {
            idempotency_key: key,
            recipient_source: result.recipient_source || null,
            message_id: result.message_id || null,
            error: result.error || null,
            attempt: int(claim.row.attempts) + 1,
            resend,
          },
        }).catch(() => ({ ok: false }))
        : { ok: false };
      return { ok: true, audit_recorded: audit?.ok === true };
    });
    return {
      ...result,
      idempotency_key: key,
      outcome_recorded: recorded?.ok === true,
      audit_recorded: recorded?.audit_recorded === true,
    };
  } catch (error) {
    return { ...result, idempotency_key: key, outcome_recorded: false, error: result.error || String(error?.message || error).slice(0, 240) };
  }
}
