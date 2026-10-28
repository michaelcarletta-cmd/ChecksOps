import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  ACTIVE_STAKEHOLDER_COLUMNS,
  activeStakeholderName,
  activeStakeholders,
  isActiveStakeholder,
  isPayableStakeholder,
  withActiveStakeholders,
} from '../../src/lib/payments/activeStakeholders.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// A stakeholder added in Settings through the payee setup flow: verified by the
// Moov webhook, never given the legacy consumer_unique.
const payee = { id: 'a1', nickname: 'Ann', custname: 'Ann Lee', account_type: 'contractor', is_active: true, verification_status: 'verified', origin: null };
const pending = { id: 'a2', nickname: 'Bob', custname: null, account_type: 'sales_rep', is_active: true, verification_status: 'unverified', origin: null };
const tenantBank = { id: 'op', nickname: 'Operating', account_type: 'operating', is_active: true, verification_status: 'verified' };
const paymentAccount = { id: 'pc', nickname: 'Payment account', account_type: 'vendor', is_active: true, origin: 'provider_connected', verification_status: 'verified' };
const removed = { id: 'r1', nickname: 'Old', account_type: 'vendor', is_active: false, verification_status: 'verified' };

test('active means what Settings lists: active, not the tenant bank, not the provider payment account', () => {
  assert.equal(isActiveStakeholder(payee), true);
  assert.equal(isActiveStakeholder(pending), true);
  assert.equal(isActiveStakeholder(tenantBank), false);
  assert.equal(isActiveStakeholder(paymentAccount), false);
  assert.equal(isActiveStakeholder(removed), false);
  assert.deepEqual(activeStakeholders([payee, tenantBank, pending, paymentAccount, removed]).map((a) => a.id), ['a1', 'a2']);
});

test('payable needs verified bank setup, not the legacy consumer_unique', () => {
  assert.equal(isPayableStakeholder(payee), true);
  assert.equal(isPayableStakeholder({ ...payee, verification_status: 'admin_override' }), true);
  assert.equal(isPayableStakeholder(pending), false);
  assert.equal(isPayableStakeholder({ ...payee, verification_status: null }), false);
  assert.doesNotMatch(ACTIVE_STAKEHOLDER_COLUMNS, /consumer_unique/);
  assert.equal(activeStakeholderName(payee), 'Ann Lee');
  assert.equal(activeStakeholderName({ id: 'x', homeowner_name: 'Home Owner', custname: 'C', nickname: 'N' }), 'Home Owner');
  assert.equal(activeStakeholderName(pending), 'Bob');
});

test('recipient report lists every Active Stakeholder once, with $0 when unpaid', () => {
  const paid = [{ name: 'Ann', type: 'contractor', total: 120, count: 2, last: '2026-05-01T00:00:00Z' }];
  const rows = withActiveStakeholders(paid, [payee, pending, tenantBank, paymentAccount, removed]);
  assert.deepEqual(rows, [
    paid[0],
    { name: 'Bob', type: 'sales_rep', total: 0, count: 0, last: null },
  ]);
  // The report's search and type filters apply to the added rows too.
  assert.deepEqual(withActiveStakeholders([], [payee, pending], { typeFilter: 'sales_rep' }).map((r) => r.name), ['Bob']);
  assert.deepEqual(withActiveStakeholders([], [payee, pending], { search: 'an' }).map((r) => r.name), ['Ann']);
  assert.deepEqual(withActiveStakeholders([], null), []);
});

test('Settings, Payroll and the recipient report read the one Active Stakeholders query', () => {
  const hook = read('src/hooks/useActiveStakeholders.ts');
  assert.match(hook, /queryKey: \["stakeholder-accounts", tenantId\] as const/);
  assert.match(hook, /\.from\("stakeholder_accounts"\)\s*\.select\(ACTIVE_STAKEHOLDER_COLUMNS\)\s*\.eq\("tenant_id", tenantId!\)\s*\.eq\("is_active", true\)/);
  assert.match(hook, /return activeStakeholders\(/);

  const settings = read('src/components/disbursement/StakeholderAccountSettings.tsx');
  assert.match(settings, /const \{ data: accounts = \[\], isLoading \} = useActiveStakeholders\(tenant\?\.id\);/);

  const payroll = read('src/components/payroll/RunPayrollDialog.tsx');
  assert.match(payroll, /const \{ data: payees = \[\], isLoading \} = useActiveStakeholders\(tenant\?\.id, open\);/);
  assert.doesNotMatch(payroll, /\.not\("consumer_unique"/);
  assert.doesNotMatch(payroll, /from\("stakeholder_accounts"\)/);
  // Every active stakeholder is listed; only verified ones can be chosen and paid.
  assert.match(payroll, /<SelectItem key=\{p\.id\} value=\{p\.id\} disabled=\{!payable\}>/);
  assert.match(payroll, /payees\.find\(\(p\) => p\.id === stakeholderId && isPayableStakeholder\(p\)\)/);

  const report = read('src/components/ledger/RecipientReport.tsx');
  assert.match(report, /useActiveStakeholders\(tenant\?\.id\)/);
  assert.match(report, /withActiveStakeholders\(paid, stakeholders, \{ search, typeFilter \}\)/);
});
