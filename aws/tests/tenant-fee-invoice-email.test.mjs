/**
 * Tenant fee invoice email (owner decision 2026-10-17): queued with the charge
 * (outbox), sent only after that transaction commits, at most once per
 * charge, never fails the pull, carries the last four digits only, behind
 * AWS_TENANT_FEE_INVOICE_EMAIL_ENABLED (off on production until the owner
 * turns it on). The database side (commit failure sends nothing, a crash
 * between commit and send is resendable once, failure isolation, preview
 * sends nothing) is tenant-fee-collection-sql98-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FEE_INVOICE_EMAIL_FLAG,
  OUTBOX_QUEUE_SQL,
  buildFeeInvoiceEmail,
  deliverFeeInvoiceEmail,
  feeInvoiceEmailEnabled,
  feeInvoiceIdempotencyKey,
  last4Only,
  occurrenceInvoiceLines,
  queueFeeInvoiceEmail,
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
  ach_authorized_by: AUTHORIZER,
  account_number_last4: '6789',
  // Fields that must never reach an email even if a row carried them.
  routing_number: '021000021',
  account_number: '000123456789',
  provider_payment_method_id: 'pm-bank-secret-id',
};

/**
 * A fake database with an outbox row; records every statement and every
 * transaction runTxn opened. failOn makes matching statements throw.
 */
const fakeDb = ({
  outbox = 'pending', authorizerEmail = 'Billing@Example.com', companyEmail = null, failOn = null, occurrence = OCC,
} = {}) => {
  const state = { outbox, attempts: 0 };
  const queries = [];
  const txns = [];
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (failOn && failOn.test(text)) throw new Error(`boom: ${failOn}`);
      if (/FROM public\.tenant_fee_invoice_outbox WHERE occurrence_id = \$1::uuid FOR UPDATE/.test(text)) {
        return { rows: state.outbox ? [{ occurrence_id: OCC.id, tenant_id: TENANT, billing_period: '2026-09', status: state.outbox, attempts: state.attempts }] : [] };
      }
      if (/UPDATE public\.tenant_fee_invoice_outbox SET status = 'sending'/.test(text)) { state.outbox = 'sending'; state.attempts += 1; return { rows: [] }; }
      if (/UPDATE public\.tenant_fee_invoice_outbox\s+SET status = \$2/.test(text)) { state.outbox = params[1]; return { rows: [] }; }
      if (/FROM public\.tenant_maintenance_payments WHERE id/.test(text)) return { rows: occurrence ? [occurrence] : [] };
      if (/FROM public\.tenant_billing_accounts/.test(text)) return { rows: [AUTH] };
      if (/FROM public\.identity_accounts/.test(text)) return { rows: authorizerEmail ? [{ email: authorizerEmail }] : [] };
      if (/SELECT company_email FROM public\.tenants/.test(text)) return { rows: [{ company_email: companyEmail }] };
      if (/SELECT name FROM public\.tenants/.test(text)) return { rows: [{ name: 'Acme Restoration <b>' }] };
      return { rows: [] };
    },
  };
  /** Commits ok results; a commit failure is simulated by commitFails. */
  const runTxn = async (fn, { commitFails = false } = {}) => {
    const before = { ...state };
    txns.push('BEGIN');
    try {
      const result = await fn({ client });
      if (commitFails || result?.ok === false) {
        Object.assign(state, before);
        txns.push('ROLLBACK');
        return { ok: false, error: 'transaction_not_committed' };
      }
      txns.push('COMMIT');
      return result;
    } catch (error) {
      Object.assign(state, before);
      txns.push('ROLLBACK');
      throw error;
    }
  };
  return { state, queries, txns, client, runTxn };
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

const deliver = (db, extra = {}) => deliverFeeInvoiceEmail({
  runTxn: (fn) => db.runTxn(fn),
  occurrenceId: OCC.id,
  ...extra,
  deps: { invoiceEmailEnabled: true, ...(extra.deps || {}) },
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

test('queue (inside the pull transaction): one outbox row per charge, savepoint-isolated, nothing sent', async () => {
  const db = fakeDb();
  const queued = await queueFeeInvoiceEmail(db.client, { occurrenceId: OCC.id, tenantId: TENANT, period: '2026-09', deps: { invoiceEmailEnabled: true } });
  assert.equal(queued.status, 'pending');
  assert.deepEqual(db.queries.map((q) => q.sql), ['SAVEPOINT fee_invoice_queue', OUTBOX_QUEUE_SQL, 'RELEASE SAVEPOINT fee_invoice_queue']);
  assert.deepEqual(db.queries[1].params, [OCC.id, TENANT, '2026-09']);
  assert.match(OUTBOX_QUEUE_SQL, /ON CONFLICT \(occurrence_id\) DO NOTHING/);
  // A failing queue never throws or aborts the pull's transaction.
  const broken = fakeDb({ failOn: /INSERT INTO public\.tenant_fee_invoice_outbox/ });
  const failed = await queueFeeInvoiceEmail(broken.client, { occurrenceId: OCC.id, tenantId: TENANT, period: '2026-09', deps: { invoiceEmailEnabled: true } });
  assert.equal(failed.status, 'queue_failed');
  assert.ok(broken.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT fee_invoice_queue'));
  // Disabled: no statement at all.
  const off = fakeDb();
  assert.equal((await queueFeeInvoiceEmail(off.client, { occurrenceId: OCC.id, tenantId: TENANT, period: '2026-09', deps: { invoiceEmailEnabled: false } })).status, 'disabled');
  assert.equal(off.queries.length, 0);
});

test('deliver: claim commits before the send, the outcome commits after, from the ChecksOps address to the ACH authorizer', async () => {
  const db = fakeDb();
  const mailer = sinkMailer();
  const audit = audits();
  const order = [];
  const res = await deliverFeeInvoiceEmail({
    runTxn: async (fn) => { order.push('txn'); return db.runTxn(fn); },
    occurrenceId: OCC.id,
    recordAudit: audit,
    deps: { invoiceEmailEnabled: true, sendViaSesOrSink: async (msg) => { order.push('send'); return mailer(msg); } },
  });
  assert.equal(res.status, 'sunk');
  assert.equal(res.sent, true);
  assert.deepEqual(order, ['txn', 'send', 'txn'], 'claim committed, then send outside any transaction, then outcome');
  assert.deepEqual(db.txns, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  assert.equal(db.state.outbox, 'sunk');
  assert.equal(db.state.attempts, 1);
  assert.equal(mailer.calls.length, 1);
  assert.equal(mailer.calls[0].to, 'billing@example.com');
  assert.match(mailer.calls[0].from, /checksops\.com/i);
  assert.equal(res.idempotency_key, feeInvoiceIdempotencyKey(OCC.id));
  assert.deepEqual(audit.rows.map((r) => [r.event, r.outcome, r.occurrenceId]), [['invoice_email', 'sunk', OCC.id]]);
  assert.equal(audit.rows[0].details.recipient_source, 'ach_authorizer');
  const log = db.queries.find((q) => /INSERT INTO public\.email_send_log/.test(q.sql));
  assert.equal(log.params[5], `fee-invoice:${OCC.id}`);
});

test('exactly once: sent / sunk is final; sending (unconfirmed) is never resent without confirm_unsent', async () => {
  for (const status of ['sent', 'sunk']) {
    const db = fakeDb({ outbox: status });
    const mailer = sinkMailer();
    const res = await deliver(db, { recordAudit: audits(), resend: true, deps: { sendViaSesOrSink: mailer } });
    assert.equal(res.status, 'already_sent', status);
    assert.equal(mailer.calls.length, 0, status);
  }
  const sending = fakeDb({ outbox: 'sending' });
  const mailer = sinkMailer();
  assert.equal((await deliver(sending, { recordAudit: audits(), deps: { sendViaSesOrSink: mailer } })).status, 'delivery_unconfirmed');
  assert.equal(mailer.calls.length, 0);
  const released = await deliver(sending, { recordAudit: audits(), confirmUnsent: true, deps: { sendViaSesOrSink: mailer } });
  assert.equal(released.status, 'sunk');
  assert.equal(mailer.calls.length, 1);
  // No queued row (the charge never committed): nothing to send.
  const none = fakeDb({ outbox: null });
  assert.equal((await deliver(none, { recordAudit: audits(), deps: { sendViaSesOrSink: mailer } })).status, 'no_pending_invoice');
  // A charge that is not submitted / settled is never invoiced.
  const returned = fakeDb({ occurrence: { ...OCC, status: 'returned' } });
  assert.equal((await deliver(returned, { recordAudit: audits(), deps: { sendViaSesOrSink: mailer } })).status, 'not_charged');
  assert.equal(mailer.calls.length, 1);
  const sql = read('aws/workflows/sql/98_tenant_fee_collection.sql');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS platform_billing_audit_invoice_email_once_uidx\s+ON public\.platform_billing_audit \(occurrence_id\)\s+WHERE event = 'invoice_email' AND outcome IN \('sent', 'sunk'\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tenant_fee_invoice_outbox \(\s+occurrence_id uuid PRIMARY KEY/);
});

test('a claim that does not commit sends nothing and leaves the row as it was', async () => {
  const db = fakeDb();
  const mailer = sinkMailer();
  const res = await deliverFeeInvoiceEmail({
    runTxn: (fn) => db.runTxn(fn, { commitFails: true }),
    occurrenceId: OCC.id,
    recordAudit: audits(),
    deps: { invoiceEmailEnabled: true, sendViaSesOrSink: mailer },
  });
  assert.equal(res.status, 'failed');
  assert.equal(mailer.calls.length, 0);
  assert.equal(db.state.outbox, 'pending');
});

test('failure isolation: a throwing or failing send is recorded as failed and stays resendable; nothing throws', async () => {
  for (const [label, mailer] of [
    ['mailer throws', async () => { throw new Error('ses down'); }],
    ['SES reports failed', async () => ({ mode: 'ses', results: [{ delivery: 'sink_fallback', status: 'failed', error: 'throttled' }] })],
  ]) {
    const db = fakeDb();
    const audit = audits();
    const res = await deliver(db, { recordAudit: audit, deps: { sendViaSesOrSink: mailer } });
    assert.equal(res.status, 'failed', label);
    assert.equal(db.state.outbox, 'failed', label);
    assert.deepEqual(audit.rows.map((r) => r.outcome), ['failed'], label);
    const retry = sinkMailer();
    assert.equal((await deliver(db, { recordAudit: audits(), resend: true, deps: { sendViaSesOrSink: retry } })).status, 'sunk', label);
    assert.equal(retry.calls.length, 1, label);
  }
  // A failing recipient lookup rolls the claim back: nothing sent, row unchanged.
  const lookup = fakeDb({ failOn: /identity_accounts/ });
  const mailer = sinkMailer();
  const res = await deliver(lookup, { recordAudit: audits(), deps: { sendViaSesOrSink: mailer } });
  assert.equal(res.status, 'failed');
  assert.equal(mailer.calls.length, 0);
  assert.equal(lookup.state.outbox, 'pending');
  // A failing send log does not turn a delivered email into failed (no second send later).
  const logFails = fakeDb({ failOn: /INSERT INTO public\.email_send_log/ });
  const delivered = await deliver(logFails, { recordAudit: audits(), deps: { sendViaSesOrSink: sinkMailer() } });
  assert.equal(delivered.status, 'sunk');
  assert.equal(logFails.state.outbox, 'sunk');
  // A failing outcome transaction leaves the row 'sending' (never resent automatically).
  const outcomeFails = fakeDb({ failOn: /SET status = \$2/ });
  const once = sinkMailer();
  const lost = await deliver(outcomeFails, { recordAudit: audits(), deps: { sendViaSesOrSink: once } });
  assert.equal(lost.outcome_recorded, false);
  assert.equal(outcomeFails.state.outbox, 'sending');
  assert.equal((await deliver(outcomeFails, { recordAudit: audits(), deps: { sendViaSesOrSink: once } })).status, 'delivery_unconfirmed');
  assert.equal(once.calls.length, 1);
});

test('no recipient: nothing sent, recorded, resendable; company email is the fallback', async () => {
  const db = fakeDb({ authorizerEmail: null, companyEmail: null });
  const audit = audits();
  const mailer = sinkMailer();
  const res = await deliver(db, { recordAudit: audit, deps: { sendViaSesOrSink: mailer } });
  assert.equal(res.status, 'no_recipient');
  assert.equal(mailer.calls.length, 0);
  assert.equal(db.state.outbox, 'no_recipient');
  assert.deepEqual(audit.rows.map((r) => r.outcome), ['no_recipient']);
  const fallback = sinkMailer();
  const ok = await deliver(fakeDb({ authorizerEmail: null, companyEmail: 'AP@Acme.example' }), { recordAudit: audits(), deps: { sendViaSesOrSink: fallback } });
  assert.equal(ok.recipient_source, 'company_email');
  assert.equal(fallback.calls[0].to, 'ap@acme.example');
});

test('contents: amount, lines, period, date and last four only; no account, routing or provider ids, no recipient address', async () => {
  const mailer = sinkMailer();
  await deliver(fakeDb(), { recordAudit: audits(), deps: { sendViaSesOrSink: mailer } });
  const { subject, html, text } = mailer.calls[0];
  for (const body of [html, text]) {
    assert.match(body, /2026-09/);
    assert.match(body, /\$93\.50/);
    assert.match(body, /\$100\.00/);
    assert.match(body, /-\$10\.00|\$-10\.00/);
    assert.match(body, /\$2\.50/);
    assert.match(body, /2026-10-05/);
    assert.match(body, /ending in 6789/);
    for (const secret of ['021000021', '000123456789', 'pm-bank-secret-id', 'billing@example.com', AUTHORIZER, TENANT]) {
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

test('wiring: the pull only queues; the handler sends after commit; preview and verification never touch the email', () => {
  const src = read('aws/functions/api/tenant-billing-engine.mjs');
  assert.doesNotMatch(src, /deliverFeeInvoiceEmail|sendViaSesOrSink/);
  const preview = src.slice(src.indexOf('export async function previewTenantPeriodCharge'), src.indexOf('const legTransferIds'));
  assert.doesNotMatch(preview, /FeeInvoiceEmail/);
  const verify = src.slice(src.indexOf('export async function verifyTenantBillingDebit'), src.indexOf('export const BILLING_PULL_LOCK_SQL'));
  assert.doesNotMatch(verify, /FeeInvoiceEmail/);
  const pull = src.slice(src.indexOf('export async function chargeTenantPeriod'), src.indexOf('export async function resendTenantFeeInvoice'));
  assert.equal(pull.match(/queueFeeInvoiceEmail\(/g).length, 1);
  assert.match(pull, /const charged = submitted\.ok === true && submitted\.duplicate !== true\s+&& CHARGED_STATUSES\.has/);
  assert.ok(pull.indexOf('queueFeeInvoiceEmail(') > pull.lastIndexOf("event: 'pull'"));
  const handlers = read('aws/functions/api/tenant-billing-handlers.mjs');
  // The send runs only after the request's own transaction returned ok (committed).
  const wrapper = handlers.slice(handlers.indexOf('export const handleTenantBillingAdmin'), handlers.indexOf('const handleTenantBillingAdminInTransaction'));
  assert.match(wrapper, /const result = await handleTenantBillingAdminInTransaction\(event, deps\);/);
  assert.match(wrapper, /if \(!marker \|\| result\?\.ok !== true\) return result;/);
  assert.ok(wrapper.indexOf('handleTenantBillingAdminInTransaction(event, deps)') < wrapper.indexOf('deliverFeeInvoiceEmail('));
  assert.match(handlers, /action === 'invoice-resend'[\s\S]*?body\.confirm !== true/);
});
