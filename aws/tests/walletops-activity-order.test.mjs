import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBillingActivity } from '../../src/lib/payments/walletRelativeTransfers.ts';

// Owner report 2026-10-29: a just-submitted wallet funding showed second in Recent
// Wallet Activity. A ChecksOps Billing row had no timestamp and was dated "now",
// so it always sorted first.
const walletOps = readFileSync(new URL('../../src/pages/WalletOps.tsx', import.meta.url), 'utf8');

test('a billing row is dated by its occurrence created_at', () => {
  const [row] = buildBillingActivity({
    tenantId: 't1',
    occurrences: [{ id: 'o1', tenant_id: 't1', amount_cents: 10000, status: 'paid', billing_period: '2026-10', created_at: '2026-10-01T09:00:00Z' }],
  });
  assert.equal(row.at, '2026-10-01T09:00:00Z');
});

test('a billing row without any timestamp has at null, not now', () => {
  const [row] = buildBillingActivity({
    tenantId: 't1',
    occurrences: [{ id: 'o1', tenant_id: 't1', amount_cents: 10000, status: 'due', billing_period: null }],
  });
  assert.equal(row.at, null);
});

test('Recent Wallet Activity never dates a billing row as now', () => {
  const billingAt = walletOps.match(/key: `billing-\$\{bill\.id\}`,\s*\n(?:\s*\/\/.*\n)*\s*at: ([^\n]+)/);
  assert.ok(billingAt, 'billing row at line found');
  assert.doesNotMatch(billingAt[1], /new Date\(\)/);
  assert.match(billingAt[1], /bill\.at/);
});
