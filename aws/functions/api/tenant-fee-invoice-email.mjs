/**
 * Tenant fee invoice email (owner decision 2026-10-17: "invoice email after a pull: yes").
 *
 * Sent once per charged period, only after a pull whose ACH debit was
 * submitted (never on a preview, a refusal, a duplicate pull or a $1
 * verification). Reuses the AWS email path: sendViaSesOrSink (SES, or the
 * staging sink / allowlist policy in email-policy.mjs), the shared ChecksOps
 * layout, the ChecksOps sending address (platformBranding) with the tenant's
 * name and logo (resolveEmailBranding), and an email_send_log row with the
 * usual sent / sunk / failed statuses.
 *
 * Once only: keyed on the charge (tenant_maintenance_payments.id,
 * fee-invoice:<id>). A sent or sunk outcome is recorded in
 * platform_billing_audit (event invoice_email), which SQL 98 makes unique per
 * charge; a later pull or resend of the same charge sends nothing.
 *
 * Failure isolation: everything runs inside a savepoint and every error is
 * caught, so a failed email never fails or rolls back the pull. The failure is
 * recorded (audit outcome failed / no_recipient) and the platform owner can
 * resend (tenant-billing-admin invoice-resend).
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
  const text = [
    `ChecksOps invoice ${period}`,
    ...paragraphs,
  ].join('\n');
  return {
    subject: `ChecksOps invoice ${period}: ${usd(amountCents)}`,
    html: layout.html,
    text,
    summary: { period, date, amount_cents: amountCents, lines, last4: last4 || null },
  };
}

const ALREADY_SENT_SQL = `SELECT 1 FROM public.platform_billing_audit
WHERE event = 'invoice_email' AND occurrence_id = $1::uuid AND outcome = ANY($2::text[])
LIMIT 1`;

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

/**
 * Sends the invoice for one booked charge at most once. Never throws; the
 * caller's transaction is never aborted (savepoint). recordAudit is the
 * engine's recordBillingAudit (its own savepoint).
 */
export async function sendFeeInvoiceEmail(client, {
  occurrence, tenantId, period, authorization, recordAudit, resend = false, deps = {},
}) {
  if (!(deps.invoiceEmailEnabled ?? feeInvoiceEmailEnabled())) {
    return { status: 'disabled', sent: false };
  }
  const key = feeInvoiceIdempotencyKey(occurrence.id);
  let result;
  await client.query('SAVEPOINT fee_invoice_email');
  try {
    const already = (await client.query(ALREADY_SENT_SQL, [occurrence.id, FEE_INVOICE_SENT_OUTCOMES])).rows[0];
    if (already) {
      await client.query('RELEASE SAVEPOINT fee_invoice_email');
      return { status: 'already_sent', sent: false, idempotency_key: key };
    }
    const recipient = await resolveRecipient(client, { tenantId, authorization });
    if (!recipient) {
      result = { status: 'no_recipient', sent: false };
    } else {
      const tenant = (await client.query('SELECT name FROM public.tenants WHERE id = $1::uuid', [tenantId])).rows[0];
      const branding = await resolveEmailBranding(client, { tenantId });
      const platform = platformBranding();
      const email = buildFeeInvoiceEmail({
        tenantName: tenant?.name,
        period,
        chargedAt: occurrence.submitted_at || occurrence.updated_at || null,
        amountCents: int(occurrence.amount_cents),
        lines: occurrenceInvoiceLines(occurrence),
        last4: last4Only(authorization?.account_number_last4),
        branding,
      });
      const mailer = deps.sendViaSesOrSink || sendViaSesOrSink;
      const sent = await mailer({
        to: recipient.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        from: platform.from,
        replyTo: platform.replyTo,
        tenantId,
        messageCategory: FEE_INVOICE_TEMPLATE,
      });
      const primary = sent?.results?.[0] || {};
      const status = primary.status === 'failed' || !sent?.results?.length
        ? 'failed'
        : (primary.delivery === 'ses' && primary.status === 'sent' ? 'sent' : 'sunk');
      // The send log is best effort (schema variants exist): its failure must not
      // turn a delivered email into "failed", which would allow a second send.
      await client.query('SAVEPOINT fee_invoice_email_log');
      try {
        await client.query(
          `INSERT INTO public.email_send_log (
             id, template_name, recipient_email, tenant_id, status, provider, provider_message_id,
             idempotency_key, error_message, metadata, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3::uuid, $4, 'aws_ses', $5, $6, $7, $8::jsonb, now())`,
          [
            FEE_INVOICE_TEMPLATE, recipient.email, tenantId, status, primary.messageId || null, key,
            primary.error || null,
            JSON.stringify({ occurrence_id: occurrence.id, billing_period: period, mode: sent?.mode || null, resend }),
          ],
        );
        await client.query('RELEASE SAVEPOINT fee_invoice_email_log');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT fee_invoice_email_log').catch(() => {});
      }
      result = {
        status,
        sent: status === 'sent' || status === 'sunk',
        recipient_source: recipient.source,
        message_id: primary.messageId || null,
        error: primary.error || null,
      };
    }
    await client.query('RELEASE SAVEPOINT fee_invoice_email');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT fee_invoice_email').catch(() => {});
    result = { status: 'failed', sent: false, error: String(error?.message || error).slice(0, 240) };
  }
  const audit = typeof recordAudit === 'function'
    ? await recordAudit(client, {
      event: 'invoice_email',
      tenantId,
      period,
      amountCents: int(occurrence.amount_cents),
      occurrenceId: occurrence.id,
      outcome: result.status,
      details: {
        idempotency_key: key,
        recipient_source: result.recipient_source || null,
        message_id: result.message_id || null,
        error: result.error || null,
        resend,
      },
    }).catch(() => ({ ok: false }))
    : { ok: false };
  return { ...result, idempotency_key: key, audit_recorded: audit?.ok === true };
}
