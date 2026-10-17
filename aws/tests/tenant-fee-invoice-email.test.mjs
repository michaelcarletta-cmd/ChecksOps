/**
 * Tenant fee invoice email (owner decision 2026-10-17): sent once per charge,
 * only after a submitted pull, never fails the pull, carries the last four
 * digits only, behind AWS_TENANT_FEE_INVOICE_EMAIL_ENABLED (off on production
 * until the owner turns it on). The database side (pull -> one email, resend,
 * failure recorded, preview sends nothing) is tenant-fee-collection-sql98-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FEE_INVOICE_EMAIL_FLAG,
  buildFeeInvoiceEmail,
  feeInvoiceEmailEnabled,
  feeInvoiceIdempotencyKey,
  last4Only,
  occurrenceInvoiceLines,
  sendFeeInvoiceEmail,
} from '../functions/api/tenant-fee-invoice-email.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TENANT = '11111111-1111-4111-8111-111111111111';
const AUTHORIZER = 'a1000000-0000-4000-8000-0000000000bb';
const OCC = {
  id: 'c1000000-0000-4000-8000-000000000001',
  tenant_id: TENANT,
  status: 'submitted',
  amount_cents: 9350,
  monthly_rate_cents: 10000,
  discount_cents: 1000,
  check_count: 1,
  check_usage_cents: 250,
  same_day_count: 1,
  same_day_usage_cents: 100,
  submitted_at: '2026-10-05T12:00:00.000Z',
};
const AUTH = {
  tenant_id: TENANT,
  ach_authorized_by: AUTHORIZER,
  account_number_last4: '6789',
  // Fields that must never reach an email even if present on the row.
  routing_number: '021000021',
  account_number: '000123456789',
  provider_payment_method_id: 'pm-bank-secret-id',
};

/** Answers the invoice email's queries; records every statement. */
const fakeClient = ({ alreadySent = false, authorizerEmail = 'Billing@Example.com', companyEmail = null, failOn = null } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (failOn && failOn.test(text)) throw new Error(`boom: ${failOn}`);
      if (/FROM public\.platform_billing_audit/.test(text)) return { rows: alreadySent ? [{ '?column?': 1 }] : [] };
      if (/FROM public\.identity_accounts/.test(text)) return { rows: authorizerEmail ? [{ email: authorizerEmail }] : [] };
      if (/SELECT company_email FROM public\.tenants/.test(text)) return { rows: [{ company_email: companyEmail }] };
      if (/SELECT name FROM public\.tenants/.test(text)) return { rows: [{ name: 'Acme Restoration <b>' }] };
      return { rows: [] };
    },
  };
};

const sinkMailer = () => {
  const calls = [];
  const fn = async (msg) => {
    calls.push(msg);
    return { mode: 'sink', results: [{ delivery: 'sink', status: 'sunk', messageId: `m-${calls.length}` }] };
  };
  fn.calls = calls;
  return fn;
};

const audits = () => {
  const rows = [];
  const fn = async (_client, entry) => { rows.push(entry); return { ok: true }; };
  fn.rows = rows;
  return fn;
};

const send = (client, extra = {}) => sendFeeInvoiceEmail(client, {
  occurrence: OCC, tenantId: TENANT, period: '2026-09', authorization: AUTH, ...extra,
});

test('flag: on by default off production, off on production until set, explicit values win', () => {
  assert.equal(FEE_INVOICE_EMAIL_FLAG, 'AWS_TENANT_FEE_INVOICE_EMAIL_ENABLED');
  assert.equal(feeInvoiceEmailEnabled({ CHECKSOPS_ENV: 'staging' }), true);
  assert.equal(feeInvoiceEmailEnabled({}), true);
  assert.equal(feeInvoiceEmailEnabled({ CHECKSOPS_ENV: 'production-prep' }), false);
  assert.equal(feeInvoiceEmailEnabled({ CHECKSOPS_ENV: 'production' }), false);
  assert.equal(feeInvoiceEmailEnabled({ CHECKSOPS_ENV: 'production-prep', [FEE_INVOICE_EMAIL_FLAG]: 'true' }), true);
  assert.equal(feeInvoiceEmailEnabled({ CHECKSOPS_ENV: 'staging', [FEE_INVOICE_EMAIL_FLAG]: 'false' }), false);
  for (const tpl of ['aws/template.yaml', 'aws/production/api-template.yaml', 'aws/production/api-cfn.yaml']) {
    assert.equal(read(tpl).includes(FEE_INVOICE_EMAIL_FLAG), false, `${tpl}: production stays off (unset)`);
  }
});

test('disabled: nothing is read, sent or recorded', async () => {
  const client = fakeClient();
  const mailer = sinkMailer();
  const audit = audits();
  const res = await send(client, { recordAudit: audit, deps: { invoiceEmailEnabled: false, sendViaSesOrSink: mailer } });
  assert.equal(res.status, 'disabled');
  assert.equal(client.queries.length, 0);
  assert.equal(mailer.calls.length, 0);
  assert.equal(audit.rows.length, 0);
});

test('sends once to the ACH authorizer from the ChecksOps address, recorded with the charge key', async () => {
  const client = fakeClient();
  const mailer = sinkMailer();
  const audit = audits();
  const res = await send(client, { recordAudit: audit, deps: { invoiceEmailEnabled: true, sendViaSesOrSink: mailer } });
  assert.equal(res.status, 'sunk');
  assert.equal(res.sent, true);
  assert.equal(res.idempotency_key, feeInvoiceIdempotencyKey(OCC.id));
  assert.equal(mailer.calls.length, 1);
  assert.equal(mailer.calls[0].to, 'billing@example.com');
  assert.match(mailer.calls[0].from, /checksops\.com/i);
  assert.equal(mailer.calls[0].tenantId, TENANT);
  assert.deepEqual(audit.rows.map((r) => [r.event, r.outcome, r.occurrenceId]), [['invoice_email', 'sunk', OCC.id]]);
  assert.equal(audit.rows[0].details.idempotency_key, `fee-invoice:${OCC.id}`);
  assert.equal(audit.rows[0].details.recipient_source, 'ach_authorizer');
  // The send log row uses the same key; the whole thing ran in a savepoint that was released.
  const log = client.queries.find((q) => /INSERT INTO public\.email_send_log/.test(q.sql));
  assert.equal(log.params[5], `fee-invoice:${OCC.id}`);
  assert.ok(client.queries.some((q) => q.sql === 'SAVEPOINT fee_invoice_email'));
  assert.ok(client.queries.some((q) => q.sql === 'RELEASE SAVEPOINT fee_invoice_email'));
});

test('once only: an invoice already sent or sunk for this charge is never sent again', async () => {
  const client = fakeClient({ alreadySent: true });
  const mailer = sinkMailer();
  const audit = audits();
  const res = await send(client, { recordAudit: audit, resend: true, deps: { invoiceEmailEnabled: true, sendViaSesOrSink: mailer } });
  assert.equal(res.status, 'already_sent');
  assert.equal(mailer.calls.length, 0);
  assert.equal(audit.rows.length, 0);
  const check = client.queries.find((q) => /FROM public\.platform_billing_audit/.test(q.sql));
  assert.deepEqual(check.params, [OCC.id, ['sent', 'sunk']]);
  const sql = read('aws/workflows/sql/98_tenant_fee_collection.sql');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS platform_billing_audit_invoice_email_once_uidx\s+ON public\.platform_billing_audit \(occurrence_id\)\s+WHERE event = 'invoice_email' AND outcome IN \('sent', 'sunk'\)/);
});

test('failure isolation: a throwing mailer or a failing query never throws and rolls back only its savepoint', async () => {
  for (const [label, client, mailer] of [
    ['mailer throws', fakeClient(), async () => { throw new Error('ses down'); }],
    ['recipient lookup fails', fakeClient({ failOn: /identity_accounts/ }), sinkMailer()],
    ['SES reports failed', fakeClient(), async () => ({ mode: 'ses', results: [{ delivery: 'sink_fallback', status: 'failed', error: 'throttled' }] })],
  ]) {
    const audit = audits();
    const res = await send(client, { recordAudit: audit, deps: { invoiceEmailEnabled: true, sendViaSesOrSink: mailer } });
    assert.equal(res.status, 'failed', label);
    assert.equal(res.sent, false, label);
    assert.deepEqual(audit.rows.map((r) => r.outcome), ['failed'], label);
  }
  const thrown = fakeClient();
  await send(thrown, { recordAudit: audits(), deps: { invoiceEmailEnabled: true, sendViaSesOrSink: async () => { throw new Error('x'); } } });
  assert.ok(thrown.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT fee_invoice_email'));
  // A failing send log does not turn a delivered email into failed (no second send later).
  const logFails = fakeClient({ failOn: /INSERT INTO public\.email_send_log/ });
  const delivered = await send(logFails, { recordAudit: audits(), deps: { invoiceEmailEnabled: true, sendViaSesOrSink: sinkMailer() } });
  assert.equal(delivered.status, 'sunk');
  assert.ok(logFails.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT fee_invoice_email_log'));
  // A failing audit writer is swallowed too.
  const res = await send(fakeClient(), { recordAudit: async () => { throw new Error('audit down'); }, deps: { invoiceEmailEnabled: true, sendViaSesOrSink: sinkMailer() } });
  assert.equal(res.audit_recorded, false);
});

test('no recipient: nothing sent, recorded for a resend; company email is the fallback', async () => {
  const none = audits();
  const mailer = sinkMailer();
  const res = await send(fakeClient({ authorizerEmail: null, companyEmail: null }), { recordAudit: none, deps: { invoiceEmailEnabled: true, sendViaSesOrSink: mailer } });
  assert.equal(res.status, 'no_recipient');
  assert.equal(mailer.calls.length, 0);
  assert.deepEqual(none.rows.map((r) => r.outcome), ['no_recipient']);
  const fallback = sinkMailer();
  const ok = await send(fakeClient({ authorizerEmail: null, companyEmail: 'AP@Acme.example' }), { recordAudit: audits(), deps: { invoiceEmailEnabled: true, sendViaSesOrSink: fallback } });
  assert.equal(ok.recipient_source, 'company_email');
  assert.equal(fallback.calls[0].to, 'ap@acme.example');
});

test('contents: amount, lines, period, date and last four only; no account, routing or provider ids, no recipient address', async () => {
  const mailer = sinkMailer();
  await send(fakeClient(), { recordAudit: audits(), deps: { invoiceEmailEnabled: true, sendViaSesOrSink: mailer } });
  const { subject, html, text } = mailer.calls[0];
  for (const body of [html, text]) {
    assert.match(body, /2026-09/);
    assert.match(body, /\$93\.50/);
    assert.match(body, /\$100\.00/);
    assert.match(body, /-\$10\.00|\$-10\.00/);
    assert.match(body, /\$2\.50/);
    assert.match(body, /2026-10-05/);
    assert.match(body, /ending in 6789/);
    for (const secret of ['021000021', '000123456789', '0001234', 'pm-bank-secret-id', 'billing@example.com', AUTHORIZER, TENANT]) {
      assert.equal(body.includes(secret), false, secret);
    }
  }
  assert.match(subject, /2026-09/);
  assert.doesNotMatch(html, /<b>/, 'tenant name is escaped');
  assert.equal(last4Only('000123456789'), '6789');
  assert.equal(last4Only('12'), null);
  assert.equal(last4Only(null), null);
  const lines = occurrenceInvoiceLines(OCC);
  assert.deepEqual(lines.map((l) => l.amount_cents), [10000, -1000, 250, 100]);
  assert.equal(lines.reduce((s, l) => s + l.amount_cents, 0), OCC.amount_cents);
  const plain = buildFeeInvoiceEmail({ tenantName: 'T', period: '2026-09', amountCents: 1, lines: [], last4: null });
  assert.match(plain.text, /your authorized bank account/);
});

test('wiring: only a submitted pull sends; preview, refusals, duplicates and the $1 verification never do', () => {
  const src = read('aws/functions/api/tenant-billing-engine.mjs');
  const preview = src.slice(src.indexOf('export async function previewTenantPeriodCharge'), src.indexOf('const legTransferIds'));
  assert.doesNotMatch(preview, /sendFeeInvoiceEmail/);
  const verify = src.slice(src.indexOf('export async function verifyTenantBillingDebit'), src.indexOf('export const BILLING_PULL_LOCK_SQL'));
  assert.doesNotMatch(verify, /sendFeeInvoiceEmail/);
  const pull = src.slice(src.indexOf('export async function chargeTenantPeriod'), src.indexOf('export async function resendTenantFeeInvoice'));
  assert.equal(pull.match(/sendFeeInvoiceEmail\(/g).length, 1);
  assert.match(pull, /const charged = submitted\.ok === true && submitted\.duplicate !== true\s+&& CHARGED_STATUSES\.has/);
  // The send comes after the pull's outcome audit, so a booked charge is always recorded first.
  assert.ok(pull.indexOf('sendFeeInvoiceEmail(') > pull.lastIndexOf("event: 'pull'"));
  const handlers = read('aws/functions/api/tenant-billing-handlers.mjs');
  assert.match(handlers, /action === 'invoice-resend'[\s\S]*?body\.confirm !== true/);
});
