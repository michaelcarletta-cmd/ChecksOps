/**
 * Owner report 2026-11-03: invoices paid into the wallet did not show in Recent Wallet Activity.
 * An invoice is paid through the hosted payment link, so it writes no payment_transfers row and
 * no wallet ledger entry; its activity row comes from the invoice itself. Fixtures only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { invoiceWalletActivity } from '../../src/lib/payments/invoiceWalletActivity.ts';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const opts = { tenantId: TENANT, environment: 'production' };
const walletOps = readFileSync(new URL('../../src/pages/WalletOps.tsx', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../../src/hooks/useWalletOps.ts', import.meta.url), 'utf8');

test('1 a paid invoice is a completed credit for the paid amount, dated when it was paid', () => {
  const [row, ...rest] = invoiceWalletActivity([{
    id: 'a', tenant_id: TENANT, environment: 'production', status: 'paid',
    total_amount: '1250.50', paid_amount: '1250.50', invoice_number: 'INV-7', customer_name: 'Pat Doe',
    paid_at: '2026-11-02T15:00:00Z', last_synced_at: '2026-11-03T09:00:00Z', created_at: '2026-10-30T12:00:00Z',
  }], opts);
  assert.deepEqual(rest, []);
  assert.deepEqual(row, {
    key: 'invoice-paid-a', invoiceId: 'a', at: '2026-11-02T15:00:00Z',
    title: 'Invoice payment received', subtitle: 'Invoice INV-7 · Pat Doe', status: 'completed', amountCents: 125050,
  });
});

test('2 a paid invoice reported without a paid amount counts its total; without paid_at it is dated by its sync', () => {
  const [row] = invoiceWalletActivity([{
    id: 'b', tenant_id: TENANT, environment: 'production', status: 'PAID', total_amount: 300, paid_amount: 0,
    paid_at: null, last_synced_at: '2026-11-03T09:00:00Z', created_at: '2026-10-30T12:00:00Z',
  }], opts);
  assert.equal(row.amountCents, 30000);
  assert.equal(row.at, '2026-11-03T09:00:00Z');
  assert.equal(row.subtitle, 'Invoice');
});

test('3 an invoice being paid is a pending credit for its unpaid balance; a partial payment also shows as received', () => {
  const rows = invoiceWalletActivity([{
    id: 'c', tenant_id: TENANT, environment: 'production', status: 'payment-pending',
    total_amount: '100.00', paid_amount: '40.00', invoice_number: 'INV-9', customer_name: 'Lee',
    paid_at: '2026-11-01T10:00:00Z', last_synced_at: '2026-11-03T08:00:00Z',
  }], opts);
  assert.deepEqual(rows.map((r) => [r.key, r.status, r.amountCents, r.at]), [
    ['invoice-paid-c', 'completed', 4000, '2026-11-01T10:00:00Z'],
    ['invoice-pending-c', 'pending', 6000, '2026-11-03T08:00:00Z'],
  ]);
});

test('4 drafts, unpaid, overdue, canceled, void, other tenants and environments add nothing', () => {
  const base = { environment: 'production', total_amount: 10, paid_amount: 0, created_at: '2026-11-01T00:00:00Z' };
  const rows = invoiceWalletActivity([
    { ...base, id: 'd', tenant_id: TENANT, status: 'draft' },
    { ...base, id: 'u', tenant_id: TENANT, status: 'unpaid' },
    { ...base, id: 'o', tenant_id: TENANT, status: 'overdue' },
    { ...base, id: 'x', tenant_id: TENANT, status: 'canceled', paid_amount: 10 },
    { ...base, id: 'v', tenant_id: TENANT, status: 'void', paid_amount: 10 },
    { ...base, id: 't', tenant_id: OTHER, status: 'paid', paid_amount: 10 },
    { ...base, id: 'e', tenant_id: TENANT, environment: 'sandbox', status: 'paid', paid_amount: 10 },
    null,
  ], opts);
  assert.deepEqual(rows, []);
});

test('5 Recent Wallet Activity lists the invoice rows as credits, and the hook reads the dates they need', () => {
  assert.match(walletOps, /transferData\?\.invoiceActivity \?\? \[\]\)\.map/);
  const block = walletOps.slice(walletOps.indexOf('transferData?.invoiceActivity'), walletOps.indexOf('...sweepActivity.rows.map'));
  assert.match(block, /credit: true/);
  assert.match(block, /at: row\.at/);
  assert.doesNotMatch(block, /new Date\(\)/);
  assert.match(walletOps, /invoice payments/);
  assert.match(hook, /paid_at, sent_at, last_synced_at, updated_at, created_at/);
  assert.match(hook, /invoiceActivity,/);
});
