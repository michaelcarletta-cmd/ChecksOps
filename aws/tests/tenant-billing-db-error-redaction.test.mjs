/**
 * Security audit 2026-10-29, finding 25 (Low): billing 503 responses returned the
 * raw database error text (`detail: error.message`) to the browser. A database
 * failure in tenant-billing-engine.mjs now answers with its fixed code and
 * message only, the same HTTP status and the same machine-readable `error` the
 * SPA reads (src/lib/tenantFeeBilling.ts reads error, message and
 * invoice_email.status), and the driver detail goes to the server log
 * (logBillingDbFailure, redacted with data.mjs sanitizeLogText). No database:
 * a fake client answers the reads and fails the write under test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  chargeTenantPeriod,
  logBillingDbFailure,
  previewTenantPeriodCharge,
  resendTenantFeeInvoice,
  verifyTenantBillingDebit,
} from '../functions/api/tenant-billing-engine.mjs';
import { CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID } from '../functions/api/tenant-billing-destination.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const PM = '22222222-2222-4222-8222-222222222222';
const ACCT = '33333333-3333-4333-8333-333333333333';
const OCC = '66666666-6666-4666-8666-666666666666';
const VERIFICATION = '55555555-5555-4555-8555-555555555555';
const PERIOD = '2026-09';
const AUDIT_MESSAGE = 'permission denied for function aws_platform_owner_record_billing_audit';
const OUTBOX_MESSAGE = 'duplicate key value violates unique constraint "tenant_fee_invoice_outbox_pkey"';
const AUDIT_MESSAGE_TEXT = 'The billing audit writer is not available (SQL 98). Nothing was charged.';

/** What a pg driver error carries: SQL text, SQLSTATE, constraint, table, a DETAIL line and a stack. */
const driverError = (message, extra = {}) => Object.assign(new Error(message), {
  code: '42501',
  severity: 'ERROR',
  table: 'platform_billing_audit',
  constraint: 'platform_billing_audit_pkey',
  routine: 'aclcheck_error',
  detail: 'Key (occurrence_id)=(66666666-6666-4666-8666-666666666666) already exists.',
  ...extra,
});

/** Every fragment of the driver error that must never reach a response body. */
const LEAKS = [
  AUDIT_MESSAGE, OUTBOX_MESSAGE, 'permission denied', 'duplicate key', 'aws_platform_owner_record_billing_audit',
  'platform_billing_audit', 'tenant_fee_invoice_outbox', '42501', 'aclcheck_error', 'Key (occurrence_id)', '    at ',
  'detail',
];
const assertNoLeak = (body) => {
  const text = JSON.stringify(body);
  for (const leak of LEAKS) assert.equal(text.includes(leak), false, `response body carries ${JSON.stringify(leak)}: ${text}`);
};

/**
 * Answers the billing reads for one ready tenant; fails the audit writer or the
 * invoice outbox when asked. `settled` makes the period (and the verification)
 * already collected.
 */
const fakeClient = ({ auditError = null, outboxError = null, settled = false } = {}) => {
  const queries = [];
  let occurrence = null;
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push(text);
      if (/aws_platform_owner_record_billing_audit/.test(text)) {
        if (auditError) throw auditError;
        return { rows: [{ id: 'audit-1' }] };
      }
      if (/INSERT INTO public\.tenant_fee_invoice_outbox/.test(text)) {
        if (outboxError) throw outboxError;
        return { rows: [] };
      }
      if (/FROM public\.tenants WHERE id/.test(text)) {
        return { rows: [{ id: TENANT, name: 'Acme', slug: 'acme', subscription_status: 'active', monthly_rate_cents: 5000, referral_discount_cents: 0 }] };
      }
      if (/FROM public\.tenant_billing_settings/.test(text)) return { rows: [{ tenant_id: TENANT, billing_enabled: true, billing_day_of_month: 1 }] };
      if (/FROM public\.tenant_billing_accounts/.test(text)) {
        return { rows: [{ id: 'billing-1', tenant_id: TENANT, auto_debit_enabled: true, ach_authorized_at: '2026-10-01T00:00:00Z', provider_payment_method_id: PM, provider_account_id: ACCT }] };
      }
      if (/FROM public\.payment_provider_accounts/.test(text)) return { rows: [{ provider_account_id: ACCT, onboarding_status: 'active', can_ach_debit: true }] };
      if (/FROM public\.payment_provider_methods/.test(text)) return { rows: [{ id: 'method-1', connection_status: 'connected', can_send: true, provider_payment_method_id: PM }] };
      if (/INSERT INTO public\.tenant_maintenance_payments/.test(text)) {
        occurrence = { id: OCC, tenant_id: TENANT, status: 'due', amount_cents: 5000, billing_period: PERIOD, idempotence_key: params[0] };
        return { rows: [occurrence] };
      }
      if (/UPDATE public\.tenant_maintenance_payments/.test(text) && /RETURNING/.test(text)) {
        occurrence = { ...occurrence, status: params[1] ?? occurrence?.status };
        return { rows: [occurrence] };
      }
      if (/FROM public\.tenant_maintenance_payments/.test(text) && settled) {
        return { rows: [{ id: OCC, tenant_id: TENANT, status: 'settled', amount_cents: 5000, billing_period: PERIOD, provider_transfer_id: 'tr-1' }] };
      }
      return { rows: [] };
    },
  };
};

const deps = {
  environment: 'sandbox',
  destination: { moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, moov_payment_method_id: '44444444-4444-4444-8444-444444444444' },
  simulate: true,
  ignoreEnabledFlag: true,
  invoiceEmailEnabled: true,
  resolveBillingDebitSource: async (_client, { authorization }) => ({
    ok: true, sourceMethodId: `debit-${authorization.provider_payment_method_id}`, sourceAccountId: authorization.provider_account_id,
  }),
};

/** The JSON lines the engine wrote to console.error during fn. */
const captureErrors = async (t, fn) => {
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });
  const result = await fn();
  t.mock.restoreAll();
  return { result, logs: lines.map((line) => JSON.parse(line)) };
};

const pull = async (client) => {
  const preview = await previewTenantPeriodCharge(client, { tenantId: TENANT, period: PERIOD, deps });
  assert.equal(preview.ok, true);
  return chargeTenantPeriod(client, { tenantId: TENANT, period: PERIOD, previewHash: preview.preview_hash, deps });
};

test('verification debit: a failed audit writer answers 503 billing_audit_unavailable with the fixed message only, and logs the driver detail', async (t) => {
  const client = fakeClient({ auditError: driverError(AUDIT_MESSAGE) });
  const { result, logs } = await captureErrors(t, () => verifyTenantBillingDebit(client, { tenantId: TENANT, verificationId: VERIFICATION, deps }));
  assert.deepEqual(result, { ok: false, error: 'billing_audit_unavailable', statusCode: 503, message: AUDIT_MESSAGE_TEXT });
  assertNoLeak(result);
  // Refused before anything was booked or posted.
  assert.equal(client.queries.some((sql) => /tenant_maintenance_payments/.test(sql)), false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].service, 'checksops-api');
  assert.equal(logs[0].event, 'billing_audit_unavailable');
  assert.equal(logs[0].action, 'verify_debit');
  assert.equal(logs[0].tenantId, TENANT);
  assert.equal(logs[0].sqlstate, '42501');
  assert.equal(logs[0].constraint, 'platform_billing_audit_pkey');
  assert.equal(logs[0].table, 'platform_billing_audit');
  assert.equal(logs[0].routine, 'aclcheck_error');
  assert.equal(logs[0].message, AUDIT_MESSAGE);
  // The DETAIL keeps its shape; the key value is redacted the way data.mjs logs a query failure.
  assert.match(logs[0].detail, /^Key \(occurrence_id\)=\(.*\[(?:id|redacted)\].*\) already exists\.$/);
  assert.equal(logs[0].detail.includes(OCC), false);
  assert.equal(JSON.stringify(logs[0]).includes('    at '), false);
});

test('fee pull: a failed audit writer answers 503 billing_audit_unavailable with the fixed message only, and logs the driver detail', async (t) => {
  const client = fakeClient({ auditError: driverError(AUDIT_MESSAGE) });
  const { result, logs } = await captureErrors(t, () => pull(client));
  assert.deepEqual(result, { ok: false, error: 'billing_audit_unavailable', statusCode: 503, message: AUDIT_MESSAGE_TEXT });
  assertNoLeak(result);
  assert.equal(client.queries.some((sql) => /INSERT INTO public\.tenant_maintenance_payments/.test(sql)), false);
  assert.equal(logs.length, 1);
  assert.deepEqual(
    { event: logs[0].event, action: logs[0].action, tenantId: logs[0].tenantId, period: logs[0].period, sqlstate: logs[0].sqlstate, table: logs[0].table, constraint: logs[0].constraint, message: logs[0].message },
    { event: 'billing_audit_unavailable', action: 'pull', tenantId: TENANT, period: PERIOD, sqlstate: '42501', table: 'platform_billing_audit', constraint: 'platform_billing_audit_pkey', message: AUDIT_MESSAGE },
  );
});

test('invoice resend: a failed outbox write answers 503 invoice_queue_failed with the queue status only, and logs the driver text', async (t) => {
  const client = fakeClient({ settled: true, outboxError: driverError(OUTBOX_MESSAGE, { code: '23505', table: 'tenant_fee_invoice_outbox', constraint: 'tenant_fee_invoice_outbox_pkey' }) });
  const { result, logs } = await captureErrors(t, () => resendTenantFeeInvoice(client, { tenantId: TENANT, period: PERIOD, deps }));
  assert.deepEqual(result, { ok: false, error: 'invoice_queue_failed', statusCode: 503, invoice_email: { status: 'queue_failed', sent: false } });
  assertNoLeak(result);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'tenant_fee_invoice_queue_failed');
  assert.equal(logs[0].action, 'resend_invoice');
  assert.equal(logs[0].status, 'queue_failed');
  assert.equal(logs[0].message, OUTBOX_MESSAGE);
});

test('fee pull: a charge whose invoice could not be queued keeps the charge and the queue status, without the driver text', async (t) => {
  const client = fakeClient({ outboxError: driverError(OUTBOX_MESSAGE, { code: '23505', table: 'tenant_fee_invoice_outbox' }) });
  const { result, logs } = await captureErrors(t, () => pull(client));
  assert.equal(result.ok, true);
  assert.equal(result.occurrence.status, 'submitted');
  assert.equal(result.audit_recorded, true);
  assert.deepEqual(result.invoice_email, { status: 'queue_failed', sent: false });
  assert.equal(result.invoice_email_after_commit, null);
  assertNoLeak(result.invoice_email);
  assert.equal(JSON.stringify(result).includes(OUTBOX_MESSAGE), false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'tenant_fee_invoice_queue_failed');
  assert.equal(logs[0].action, 'pull');
  assert.equal(logs[0].message, OUTBOX_MESSAGE);
});

test('successful paths are unchanged: verification, pull and resend answer as before and log nothing', async (t) => {
  const verified = await captureErrors(t, () => verifyTenantBillingDebit(fakeClient({ settled: true }), { tenantId: TENANT, verificationId: VERIFICATION, deps }));
  assert.equal(verified.result.ok, true);
  assert.equal(verified.result.duplicate, true);
  assert.equal(verified.result.reason, 'already_settled');
  assert.equal(verified.result.audit_recorded, true);
  assert.equal(verified.result.amount_cents, 100);
  assert.deepEqual(verified.logs, []);

  const pulled = await captureErrors(t, () => pull(fakeClient()));
  assert.equal(pulled.result.ok, true);
  assert.equal(pulled.result.booked, true);
  assert.equal(pulled.result.occurrence.status, 'submitted');
  assert.equal(pulled.result.amount_cents, 5000);
  assert.equal(pulled.result.audit_recorded, true);
  assert.deepEqual(pulled.result.invoice_email, { status: 'pending', sent: false, occurrence_id: OCC });
  assert.equal(pulled.result.invoice_email_sent, false);
  assert.equal(pulled.result.invoice_email_after_commit, OCC);
  assert.deepEqual(pulled.logs, []);

  const resent = await captureErrors(t, () => resendTenantFeeInvoice(fakeClient({ settled: true }), { tenantId: TENANT, period: PERIOD, deps }));
  assert.deepEqual(resent.result, { ok: true, statusCode: 200, invoice_email: { status: 'pending', sent: false, occurrence_id: OCC }, invoice_email_after_commit: OCC });
  assert.deepEqual(resent.logs, []);

  const disabled = await resendTenantFeeInvoice(fakeClient({ settled: true }), { tenantId: TENANT, period: PERIOD, deps: { ...deps, invoiceEmailEnabled: false } });
  assert.deepEqual(disabled, { ok: true, statusCode: 200, invoice_email: { status: 'disabled', sent: false } });
});

test('logBillingDbFailure: identifiers and redacted text only, never a stack or a connection string', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => { lines.push(JSON.parse(line)); });
  logBillingDbFailure('billing_audit_unavailable', driverError('connect failed postgres://user:pw@db.internal:5432/app for owner@example.com'), { action: 'pull' });
  t.mock.restoreAll();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'connect failed [db-url] for [email]');
  assert.equal(JSON.stringify(lines[0]).includes('    at '), false);
  assert.equal(JSON.stringify(lines[0]).includes('pw@'), false);
});

test('the engine source no longer puts error.message into a billing response', () => {
  const source = fs.readFileSync(path.join(ROOT, 'aws/functions/api/tenant-billing-engine.mjs'), 'utf8');
  assert.doesNotMatch(source, /detail:\s*error\.message/);
  assert.match(source, /import \{ sanitizeLogText \} from '\.\/data\.mjs';/);
  assert.equal((source.match(/logBillingDbFailure\('billing_audit_unavailable'/g) || []).length, 2);
});
