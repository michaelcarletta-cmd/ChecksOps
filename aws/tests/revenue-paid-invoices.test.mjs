/**
 * Owner request 2026-11-04: Payments & Financials revenue must include paid invoices so revenue
 * and profit are accurate. An invoice is paid through the hosted payment link (no check is
 * deposited and no transfer row is written); the invoice row is the record. Fixtures only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { paidInvoiceRevenue } from '../../src/lib/payments/invoiceWalletActivity.ts';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const opts = { tenantId: TENANT, environment: 'production' };
const summary = readFileSync(new URL('../../src/components/ledger/RevenueSummary.tsx', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../../src/hooks/useWalletOps.ts', import.meta.url), 'utf8');

test('1 a paid invoice is revenue for its paid amount, dated when it was paid', () => {
  assert.deepEqual(paidInvoiceRevenue([{
    id: 'a', tenant_id: TENANT, environment: 'production', status: 'paid', total_amount: '1250.50', paid_amount: '1250.50',
    invoice_number: ' INV-7 ', customer_name: 'Pat Doe', paid_at: '2026-11-02T15:00:00Z', created_at: '2026-10-30T12:00:00Z',
  }], opts), [{ id: 'a', at: '2026-11-02T15:00:00Z', invoiceNumber: 'INV-7', customerName: 'Pat Doe', amountCents: 125050 }]);
});

test('2 only money received counts: a partial payment counts what was paid, a pending balance does not', () => {
  const rows = paidInvoiceRevenue([{
    id: 'c', tenant_id: TENANT, environment: 'production', status: 'payment-pending', total_amount: '100.00', paid_amount: '40.00',
    paid_at: '2026-11-01T10:00:00Z',
  }, {
    id: 'p', tenant_id: TENANT, environment: 'production', status: 'payment-pending', total_amount: '500.00', paid_amount: 0,
    last_synced_at: '2026-11-03T08:00:00Z',
  }], opts);
  assert.deepEqual(rows.map((r) => [r.id, r.amountCents]), [['c', 4000]]);
});

test('3 drafts, unpaid, overdue, canceled, void, other tenants and sandbox invoices are not revenue', () => {
  const base = { environment: 'production', total_amount: 10, paid_amount: 0, created_at: '2026-11-01T00:00:00Z' };
  assert.deepEqual(paidInvoiceRevenue([
    { ...base, id: 'd', tenant_id: TENANT, status: 'draft' },
    { ...base, id: 'u', tenant_id: TENANT, status: 'unpaid' },
    { ...base, id: 'o', tenant_id: TENANT, status: 'overdue' },
    { ...base, id: 'x', tenant_id: TENANT, status: 'canceled', paid_amount: 10 },
    { ...base, id: 'v', tenant_id: TENANT, status: 'void', paid_amount: 10 },
    { ...base, id: 't', tenant_id: OTHER, status: 'paid', paid_amount: 10 },
    { ...base, id: 's', tenant_id: TENANT, environment: 'sandbox', status: 'paid', paid_amount: 10 },
  ], opts), []);
});

test('4 Revenue & Profit adds paid invoices to revenue (and so to profit) and lists them as revenue sources', () => {
  assert.match(summary, /usePaidInvoiceRevenue\(\)/);
  assert.match(summary, /const totalIncoming = checkIncoming \+ invoiceIncoming;/);
  assert.match(summary, /const profit = totalIncoming - totalOutgoing;/);
  assert.match(summary, /revenueSources\.map/);
  assert.match(summary, /From deposited checks and paid invoices/);
  assert.match(summary, /revenueLoading \|\| disbursementLoading \|\| invoicesLoading/);
  // The hook reads the live payments environment and the paid-at date.
  const fn = hook.slice(hook.indexOf('export function usePaidInvoiceRevenue'), hook.indexOf('export function useSyncOpenInvoicesOnOpen'));
  assert.match(fn, /resolveWalletOpsEnvironment/);
  assert.match(fn, /paid_at/);
  assert.match(fn, /paidInvoiceRevenue\(/);
});
