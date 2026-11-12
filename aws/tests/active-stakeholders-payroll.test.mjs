import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  ACTIVE_STAKEHOLDER_COLUMNS,
  activeStakeholderName,
  activeStakeholders,
  isActiveStakeholder,
  isPayableStakeholder,
  recipientNameKey,
  recipientTotalsByName,
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

test('the recipient report tracks a recipient by name, not by type', () => {
  // Owner 2026-11-12: Condition One was paid as a partner (a send) and as a contractor (a payout)
  // and showed as two recipients. One person or company is one row.
  assert.equal(recipientNameKey('Condition One Commercial, LLC'), 'condition one commercial');
  assert.equal(recipientNameKey('  CONDITION  ONE commercial '), 'condition one commercial');
  assert.equal(recipientNameKey('Ann Lee'), 'ann lee');
  assert.notEqual(recipientNameKey('Condition One'), recipientNameKey('Condition One Commercial'));
  assert.equal(recipientNameKey(null), '');

  const rows = recipientTotalsByName([
    { name: 'Condition One Commercial', type: 'partner', amount: 8307, date: '2026-11-06T19:06:02Z', method: 'send' },
    { name: 'Condition One Commercial LLC', type: 'contractor', amount: 500, date: '2026-11-08T10:00:00Z', method: 'ach' },
    { name: 'Condition One Commercial', type: 'contractor', amount: 250, date: '2026-10-01T10:00:00Z', method: 'external_check' },
    { name: 'Ann', type: 'contractor', amount: 120, date: '2026-05-01T00:00:00Z', method: 'payroll' },
  ]);
  assert.equal(rows.length, 2);
  const [c1, ann] = rows;
  assert.deepEqual({ name: c1.name, type: c1.type, types: c1.types, total: c1.total, count: c1.count, sendCount: c1.sendCount, payrollCount: c1.payrollCount, last: c1.last }, {
    name: 'Condition One Commercial', type: 'partner', types: ['partner', 'contractor'], total: 9057, count: 3, sendCount: 1, payrollCount: 0, last: '2026-11-08T10:00:00Z',
  });
  // Only the split rows can be renamed: each exact name and type they were recorded under.
  assert.deepEqual(c1.splitVariants, [
    { name: 'Condition One Commercial LLC', type: 'contractor', count: 1 },
    { name: 'Condition One Commercial', type: 'contractor', count: 1 },
  ]);
  assert.deepEqual({ name: ann.name, types: ann.types, payrollCount: ann.payrollCount, splitVariants: ann.splitVariants }, { name: 'Ann', types: ['contractor'], payrollCount: 1, splitVariants: [] });
  assert.deepEqual(recipientTotalsByName([]), []);

  // A stakeholder already paid under another type is not listed a second time with $0.
  const withStakeholders = withActiveStakeholders(rows, [{ ...payee, nickname: 'ANN', account_type: 'sales_rep' }, pending]);
  assert.deepEqual(withStakeholders.map((r) => r.name), ['Condition One Commercial', 'Ann', 'Bob']);

  const report = read('src/components/ledger/RecipientReport.tsx');
  assert.match(report, /recipientTotalsByName\(filtered\.filter\(\(r\) => r\.status === "settled"\)\)/);
  assert.doesNotMatch(report, /`\$\{r\.type\}\|\$\{r\.name\}`/);
  assert.match(report, /for \(const variant of editTarget\.variants\)/);
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
