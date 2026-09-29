import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PAYMENT_STATUS,
  EXCEPTION,
  billingMonthOf,
  extractProviderTransferId,
  extractKind,
  parseLineItemsFromNotes,
  classifyPaymentStatus,
  receivedCentsFor,
  assembleReceivables,
  filterReceivables,
  summarizeReceivables,
  tenantBillingSummary,
  enrichWalletTransactions,
  rowFromMaintenancePayment,
} from '../functions/api/providers/parity/tenant-receivables.mjs';
import { platformBank, platformTreasury } from '../functions/api/providers/parity/moov-onboard.mjs';
import { tenantFeeCharge } from '../functions/api/providers/parity/moov-money.mjs';

const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_PAYMENT_ID = '414d81a2-186b-4e42-8ea1-47077d77a85c';
const FREEDOM_TRANSFER_ID = '367c5353-ed20-430b-b767-c3e5d47f28ad';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';

const freedomPayment = {
  id: FREEDOM_PAYMENT_ID,
  tenant_id: FREEDOM_TENANT,
  amount_cents: 100,
  period_start: '2026-09-01',
  period_end: '2026-10-01',
  method: 'moov_ach',
  status: 'submitted',
  notes: 'Moov ACH pull (billing_verification) for September 2026 · moov:367c5353-ed20-430b-b767-c3e5d47f28ad',
  idempotence_key: 'billing_verification:2eff5f1a-929d-4ce3-9a8b-cd96b98df42a:f0ff0dbf-f5e5-4924-a060-811e7e568c8c',
  submitted_at: '2026-09-25T20:46:55Z',
  created_at: '2026-09-25T20:46:55Z',
  received_at: '2026-09-25T20:46:55Z',
};

const tenants = new Map([
  [FREEDOM_TENANT, { name: 'Freedom Adjustment' }],
  [OTHER_TENANT, { name: 'Condition One Commercial' }],
]);

test('billing month accepts ISO strings and Date objects from pg', () => {
  assert.equal(billingMonthOf('2026-09-01', '2026-08-20T16:26:20Z'), '2026-09');
  assert.equal(billingMonthOf(null, '2026-08-20T16:26:20Z'), '2026-08');
  assert.equal(billingMonthOf(new Date('2026-09-01T00:00:00Z')), '2026-09');
});

test('extracts provider transfer from notes, not bank metadata', () => {
  assert.equal(extractProviderTransferId(freedomPayment.notes), FREEDOM_TRANSFER_ID);
  assert.equal(extractProviderTransferId('Wells Fargo 4573', null), null);
  assert.equal(extractProviderTransferId(null, FREEDOM_TRANSFER_ID), FREEDOM_TRANSFER_ID);
});

test('kind comes from local operation key, not Moov description', () => {
  assert.equal(extractKind(freedomPayment), 'billing_verification');
  assert.equal(extractKind({
    idempotence_key: 'consolidated_moov_x',
    method: 'moov_ach_consolidated',
    notes: 'ChecksOps fees September 2026',
  }), 'consolidated');
});

test('parses accepted consolidated line items from stored notes', () => {
  const items = parseLineItemsFromNotes(
    'Moov ACH pull (consolidated) for September 2026: Monthly maintenance $100.00 · Referral discount $-5.00 · Check processing $44.00 · MortgageOps handling $0.00 · moov:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  assert.deepEqual(items, [
    { label: 'Monthly maintenance', amount_cents: 10000 },
    { label: 'Referral discount', amount_cents: -500 },
    { label: 'Check processing', amount_cents: 4400 },
    { label: 'MortgageOps handling', amount_cents: 0 },
  ]);
});

test('does not treat created/pending transfers as paid', () => {
  assert.equal(classifyPaymentStatus({
    localStatus: 'submitted',
    providerStatus: 'pending',
    achStatus: 'originated',
  }), PAYMENT_STATUS.ORIGINATED);
  assert.equal(receivedCentsFor(PAYMENT_STATUS.ORIGINATED, 100), 0);
  assert.equal(classifyPaymentStatus({
    localStatus: 'submitted',
    providerStatus: 'pending',
  }), PAYMENT_STATUS.SUBMITTED);
  assert.equal(receivedCentsFor(PAYMENT_STATUS.SUBMITTED, 100), 0);
  assert.equal(classifyPaymentStatus({
    localStatus: 'submitted',
    providerStatus: 'completed',
    settledAt: '2026-09-26T12:00:00Z',
  }), PAYMENT_STATUS.SETTLED);
  assert.equal(receivedCentsFor(PAYMENT_STATUS.SETTLED, 100), 100);
});

test('Freedom $1 fixture is attributed to Freedom Adjustment and is not unidentified', () => {
  const rows = assembleReceivables({
    payments: [freedomPayment],
    tenants,
    providerByTransferId: new Map([[FREEDOM_TRANSFER_ID, {
      status: 'pending',
      achStatus: 'originated',
      amount: { value: 100 },
    }]]),
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.tenant_id, FREEDOM_TENANT);
  assert.equal(row.tenant_name, 'Freedom Adjustment');
  assert.equal(row.local_operation_id, FREEDOM_PAYMENT_ID);
  assert.equal(row.provider_transfer_id, FREEDOM_TRANSFER_ID);
  assert.equal(row.billing_month, '2026-09');
  assert.equal(row.billing_period_label, 'September 2026');
  assert.equal(row.fee_type, 'Billing verification');
  assert.equal(row.amount_billed_cents, 100);
  assert.equal(row.amount_received_cents, 0);
  assert.equal(row.balance_cents, 100);
  assert.equal(row.payment_status, PAYMENT_STATUS.ORIGINATED);
  assert.equal(row.received_at, null);
  assert.ok(!row.exceptions.includes(EXCEPTION.PROVIDER_ONLY));
});

test('settled Freedom $1 becomes paid only after provider completed', () => {
  const rows = assembleReceivables({
    payments: [freedomPayment],
    tenants,
    providerByTransferId: new Map([[FREEDOM_TRANSFER_ID, {
      status: 'completed',
      completedOn: '2026-09-26T16:00:00Z',
      amount: { value: 100 },
    }]]),
  });
  assert.equal(rows[0].payment_status, PAYMENT_STATUS.SETTLED);
  assert.equal(rows[0].amount_received_cents, 100);
  assert.equal(rows[0].balance_cents, 0);
  assert.equal(rows[0].received_at, '2026-09-26T16:00:00Z');
});

test('month, tenant, and status filters work', () => {
  const other = {
    ...freedomPayment,
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenant_id: OTHER_TENANT,
    period_start: '2026-08-01',
    notes: 'Moov ACH pull (consolidated) for August 2026 · moov:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    idempotence_key: 'consolidated_moov_c1c',
    status: 'failed',
  };
  const rows = assembleReceivables({ payments: [freedomPayment, other], tenants });
  assert.equal(filterReceivables(rows, { tenantId: FREEDOM_TENANT }).length, 1);
  assert.equal(filterReceivables(rows, { billingMonth: '2026-09' })[0].tenant_id, FREEDOM_TENANT);
  assert.equal(filterReceivables(rows, { paymentStatus: PAYMENT_STATUS.FAILED })[0].tenant_id, OTHER_TENANT);
});

test('totals never count the same provider transfer twice', () => {
  const duplicateOccurrence = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    tenant_id: FREEDOM_TENANT,
    provider_transfer_id: FREEDOM_TRANSFER_ID,
    period_start: '2026-09-01',
    amount_cents: 100,
    status: 'processing',
  };
  const rows = assembleReceivables({
    payments: [freedomPayment],
    occurrences: [duplicateOccurrence],
    tenants,
  });
  assert.equal(rows.length, 1);
  const totals = summarizeReceivables([...rows, ...rows]);
  assert.equal(totals.row_count, 1);
  assert.equal(totals.amount_billed_cents, 100);
  assert.equal(totals.pending_cents, 100);
  assert.equal(totals.amount_collected_cents, 0);
});

test('monthly totals reconcile to displayed filtered rows', () => {
  const paid = {
    ...freedomPayment,
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    notes: 'Moov ACH pull (consolidated) for September 2026: Monthly maintenance $100.00 · moov:ffffffff-ffff-4fff-8fff-ffffffffffff',
    idempotence_key: 'consolidated_moov_freedom',
    amount_cents: 10000,
    status: 'cleared',
  };
  const rows = assembleReceivables({
    payments: [freedomPayment, paid],
    tenants,
    providerByTransferId: new Map([
      [FREEDOM_TRANSFER_ID, { status: 'pending', achStatus: 'originated', amount: { value: 100 } }],
      ['ffffffff-ffff-4fff-8fff-ffffffffffff', { status: 'completed', completedOn: '2026-09-20T00:00:00Z', amount: { value: 10000 } }],
    ]),
  });
  const september = filterReceivables(rows, { billingMonth: '2026-09' });
  const totals = summarizeReceivables(september);
  const billed = september.reduce((sum, row) => sum + row.amount_billed_cents, 0);
  const collected = september.reduce((sum, row) => sum + row.amount_received_cents, 0);
  assert.equal(totals.amount_billed_cents, billed);
  assert.equal(totals.amount_collected_cents, collected);
  assert.equal(totals.outstanding_cents, billed - collected);
});

test('tenant isolation: history for one tenant never includes another', () => {
  const other = {
    ...freedomPayment,
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenant_id: OTHER_TENANT,
    notes: 'Moov ACH pull (consolidated) · moov:99999999-9999-4999-8999-999999999999',
  };
  const rows = assembleReceivables({ payments: [freedomPayment, other], tenants });
  const freedomOnly = filterReceivables(rows, { tenantId: FREEDOM_TENANT });
  assert.equal(freedomOnly.every((row) => row.tenant_id === FREEDOM_TENANT), true);
  assert.equal(freedomOnly.some((row) => row.tenant_id === OTHER_TENANT), false);
});

test('wallet activity is enriched from local records, not bank name', () => {
  const rows = assembleReceivables({ payments: [freedomPayment], tenants });
  const enriched = enrichWalletTransactions([
    { id: FREEDOM_TRANSFER_ID, transferID: FREEDOM_TRANSFER_ID, type: 'transfer', amount_cents: 100 },
    { id: 'unidentified', type: 'transfer', amount_cents: 50 },
  ], rows);
  assert.equal(enriched[0].tenant_name, 'Freedom Adjustment');
  assert.equal(enriched[0].attribution.local_operation_id, FREEDOM_PAYMENT_ID);
  assert.equal(enriched[1].tenant_id, null);
  assert.equal(enriched[1].attribution, null);
});

test('tenant monthly history summary uses record amounts', () => {
  const row = rowFromMaintenancePayment(freedomPayment, {
    tenants,
    provider: { status: 'pending', achStatus: 'originated' },
  });
  const summary = tenantBillingSummary([row], { now: new Date('2026-09-29T00:00:00Z') });
  assert.equal(summary.current_month_amount_due_cents, 100);
  assert.equal(summary.current_payment_status, PAYMENT_STATUS.ORIGINATED);
  assert.equal(summary.last_successful_payment, null);
  assert.equal(summary.months[0].amount_due_cents, 100);
  assert.equal(summary.months[0].amount_paid_cents, 0);
});

test('exceptions flag local-only, amount mismatch, and returned without auto-repair', () => {
  const localOnly = assembleReceivables({
    payments: [{ ...freedomPayment, notes: 'no provider id yet' }],
    tenants,
  });
  assert.ok(localOnly[0].exceptions.includes(EXCEPTION.LOCAL_ONLY));

  const mismatch = assembleReceivables({
    payments: [freedomPayment],
    tenants,
    providerByTransferId: new Map([[FREEDOM_TRANSFER_ID, { status: 'pending', amount: { value: 999 } }]]),
  });
  assert.ok(mismatch[0].exceptions.includes(EXCEPTION.AMOUNT_MISMATCH));

  const returned = classifyPaymentStatus({ localStatus: 'returned', providerStatus: 'returned' });
  assert.equal(returned, PAYMENT_STATUS.RETURNED);
});

test('platform finance read handlers use platform-owner contract; fee charge does not', () => {
  assert.equal(platformTreasury.platformOwnerOnly, true);
  assert.equal(platformBank.platformOwnerOnly, true);
  assert.equal(tenantFeeCharge.platformOwnerOnly, undefined);
  assert.equal(tenantFeeCharge.requireAdmin, true);
});
