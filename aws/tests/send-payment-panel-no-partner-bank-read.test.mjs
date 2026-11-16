// Owner report 2026-11-16: sending to Condition One from a check file said the partner "has not set up a
// primary bank account" although money had been sent to them. The legacy SendPaymentPanel read the partner's
// stakeholder_accounts from the browser; those rows belong to another organization, the read comes back empty,
// and the panel showed the false message. Sending is Disburse funds (the server-side partner send), so the panel
// no longer reads another organization's banks and shows only an already-sent legacy payment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const panel = read('src/components/payments/SendPaymentPanel.tsx');

test('the panel does not read the partner organization\'s bank accounts', () => {
  assert.doesNotMatch(panel, /stakeholder_accounts/);
  assert.doesNotMatch(panel, /contractor-primary-account/);
});

test('the false "has not set up a primary bank account" message is gone', () => {
  assert.doesNotMatch(panel, /has not set up a primary bank/);
  assert.doesNotMatch(panel, /currently moving to Moov/);
});

test('the panel only shows an already-sent payment and renders nothing otherwise', () => {
  assert.match(panel, /from\("claim_check_payments"\)/);
  assert.match(panel, /if \(!existingPayment \|\| existingPayment\.status === "pending"\) return null;/);
  assert.doesNotMatch(panel, /\.insert\(/);
});

test('the check file still renders the panel with the same props', () => {
  const ccc = read('src/pages/CheckCommandCenter.tsx');
  assert.match(ccc, /<SendPaymentPanel[\s\S]*?contractorTenantId=\{contractorPartner\.id\}/);
});
