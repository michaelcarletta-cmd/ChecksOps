/**
 * WalletOps "Pending in" counts invoices a customer is paying through the hosted payment link
 * (no payment_transfers row is written for them). Fixtures only. No provider calls.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  invoicePendingInCents,
  invoicesInFlight,
  isInvoiceBeingPaid,
} from '../../src/lib/payments/invoicePendingIn.ts';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('1 only an in-progress payment status counts as being paid', () => {
  for (const status of ['payment-pending', 'payment_pending', 'PAYMENT-PENDING', 'processing', 'in-progress']) {
    assert.equal(isInvoiceBeingPaid(status), true, status);
  }
  for (const status of ['draft', 'unpaid', 'overdue', 'paid', 'canceled', 'cancelled', 'void', '', null, undefined]) {
    assert.equal(isInvoiceBeingPaid(status), false, String(status));
  }
});

test('2 an invoice being paid adds its unpaid balance (dollars to cents) to Pending in', () => {
  const rows = [
    { id: 'a', tenant_id: TENANT, environment: 'production', status: 'payment-pending', total_amount: 1250.5, paid_amount: 0, invoice_number: 'INV-1', customer_name: 'Pat' },
    { id: 'b', tenant_id: TENANT, environment: 'production', status: 'payment-pending', total_amount: '100.00', paid_amount: '40.00' },
  ];
  assert.equal(invoicePendingInCents(rows, { tenantId: TENANT, environment: 'production' }), 125050 + 6000);
  assert.deepEqual(invoicesInFlight(rows, { tenantId: TENANT, environment: 'production' })[0], {
    id: 'a', invoice_number: 'INV-1', customer_name: 'Pat', status: 'payment-pending', pending_cents: 125050,
  });
});

test('3 unpaid, overdue, paid, canceled, draft, other tenants and other environments do not count', () => {
  const rows = [
    { id: 'u', tenant_id: TENANT, environment: 'production', status: 'unpaid', total_amount: 10 },
    { id: 'o', tenant_id: TENANT, environment: 'production', status: 'overdue', total_amount: 10 },
    { id: 'p', tenant_id: TENANT, environment: 'production', status: 'paid', total_amount: 10, paid_amount: 10 },
    { id: 'c', tenant_id: TENANT, environment: 'production', status: 'canceled', total_amount: 10 },
    { id: 'd', tenant_id: TENANT, environment: 'production', status: 'draft', total_amount: 10 },
    { id: 't', tenant_id: OTHER, environment: 'production', status: 'payment-pending', total_amount: 10 },
    { id: 's', tenant_id: TENANT, environment: 'sandbox', status: 'payment-pending', total_amount: 10 },
    { id: 'z', tenant_id: TENANT, environment: 'production', status: 'payment-pending', total_amount: 10, paid_amount: 10 },
  ];
  assert.equal(invoicePendingInCents(rows, { tenantId: TENANT, environment: 'production' }), 0);
  assert.equal(invoicePendingInCents(null, { tenantId: TENANT }), 0);
});

test('4 the WalletOps hook adds invoices being paid to its pending-in total and syncs open invoices when it opens', () => {
  const hook = readFileSync(new URL('../../src/hooks/useWalletOps.ts', import.meta.url), 'utf8');
  assert.match(hook, /\.from\("moov_invoices"\)/);
  assert.match(hook, /pendingInCents: summary\.pendingInCents \+ invoicePendingInCents/);
  assert.match(hook, /environment: walletEnvironment/);
  assert.match(hook, /export function useSyncOpenInvoicesOnOpen\(\)/);
  assert.match(hook, /invoke\("moov-invoice", \{ body: \{ action: "sync", tenant_id: tenantId \} \}\)/);
  const page = readFileSync(new URL('../../src/pages/WalletOps.tsx', import.meta.url), 'utf8');
  assert.match(page, /useSyncOpenInvoicesOnOpen\(\);/);
  // Owner decision 2026-10-30: the page shows no Pending in / Pending out cards; Recent Wallet Activity covers it.
  assert.doesNotMatch(page, /Pending in|Pending out|invoicesBeingPaid/);
});
