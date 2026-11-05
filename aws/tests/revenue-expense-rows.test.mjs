/**
 * Owner request 2026-11-05: Revenue & Profit shows Total Paid (Expenses) at the top but no list
 * of what makes it up. The Expenses table lists exactly those items (settled splits, paid
 * payroll, payroll speed fees) and sums to the card. Fixtures only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  PAYROLL_SPEED_FEE_ROW_LABEL,
  REVENUE_EXPENSE_SPLIT_COLUMNS,
  revenueExpenseRows,
  revenueExpenseRowsTotal,
  splitMethodLabel,
} from '../../src/lib/payments/revenueExpenseRows.ts';
import { payrollExpenseTotal, payrollSpeedFeeExpenseTotal } from '../../src/lib/payments/payrollRows.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const ann = { id: 'acct-ann', nickname: 'Ann', custname: 'Ann Lee', account_type: 'contractor', chk_acct: '000123456789' };
const run = (id, status, amount, created_at, extra = {}) => ({
  id, status, amount, memo: `memo ${id}`, created_at, stakeholder_account_id: ann.id, stakeholder_accounts: ann, ...extra,
});

const splits = [
  {
    id: 's1', amount: '1200.10', status: 'settled', settled_at: '2026-10-02T12:00:00Z', created_at: '2026-10-01T12:00:00Z',
    method: 'ach', recipient_name: 'Fallback Name', stakeholder_accounts: { nickname: 'Roofer Co', custname: 'Roofer Co LLC' },
    disbursement_batches: { check_intake_items: { check_number: '55501' } },
  },
  {
    id: 's2', amount: 300.2, status: 'settled', settled_at: null, created_at: '2026-09-15T12:00:00Z',
    method: 'external_check', external_check_number: '1042', recipient_name: 'Bob Plumbing', stakeholder_accounts: null,
    disbursement_batches: null,
  },
];

const runs = [
  run('r1', 'submitted', '400.00', '2026-10-05T15:00:00Z', { speed: 'same_day' }),
  run('r2', 'completed', 150.33, '2026-08-01T15:00:00Z', { speed: 'next_day' }),
  run('r3', 'completed', 25, '2026-07-01T15:00:00Z', { speed: null }),
  run('r4', 'pending', 75, '2026-10-06T15:00:00Z', { speed: 'same_day' }),
  run('r5', 'partial', 60, '2026-10-06T15:00:00Z', { speed: 'same_day' }),
  run('r6', 'failed', 999, '2026-10-06T15:00:00Z', { speed: 'same_day' }),
];

/** The card's formula in RevenueSummary.tsx: disbursementOutgoing + payroll.total + speedFees.total. */
const cardTotal = (splitRows, payrollRuns) => {
  const disbursementOutgoing = splitRows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return disbursementOutgoing + payrollExpenseTotal(payrollRuns).total + payrollSpeedFeeExpenseTotal(payrollRuns).total;
};
const cents = (n) => Math.round(n * 100);

test('the rows sum to Total Paid (Expenses) (totalOutgoing)', () => {
  const rows = revenueExpenseRows({ splits, payrollRuns: runs });
  assert.equal(cents(revenueExpenseRowsTotal(rows)), cents(cardTotal(splits, runs)));
  assert.equal(revenueExpenseRowsTotal(rows), 1200.1 + 300.2 + 400 + 150.33 + 25 + 1.0 + 0.75);
});

test('exactly the counted items: settled splits, paid payroll, and one fee row per paid run with a speed', () => {
  const rows = revenueExpenseRows({ splits, payrollRuns: runs });
  assert.deepEqual(rows.map((r) => [r.key, r.kind, r.amount]), [
    ['payroll-r1', 'payroll', 400],
    ['payroll-fee-r1', 'payroll_speed_fee', 1],
    ['split-s1', 'disbursement', 1200.1],
    ['split-s2', 'disbursement', 300.2],
    ['payroll-r2', 'payroll', 150.33],
    ['payroll-fee-r2', 'payroll_speed_fee', 0.75],
    ['payroll-r3', 'payroll', 25],
  ]);
  assert.equal(rows.filter((r) => r.kind === 'payroll').length, payrollExpenseTotal(runs).count);
  assert.equal(rows.filter((r) => r.kind === 'payroll_speed_fee').length, payrollSpeedFeeExpenseTotal(runs).count);
});

test('newest first; a split dates by settled_at, else created_at', () => {
  const rows = revenueExpenseRows({ splits, payrollRuns: runs });
  const times = rows.map((r) => new Date(r.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.equal(rows.find((r) => r.key === 'split-s1').at, '2026-10-02T12:00:00Z');
  assert.equal(rows.find((r) => r.key === 'split-s2').at, '2026-09-15T12:00:00Z');
});

test('display fields: payee, memo, check number or type, status', () => {
  const rows = revenueExpenseRows({ splits, payrollRuns: runs });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(
    [byKey['split-s1'].title, byKey['split-s1'].subtitle, byKey['split-s1'].reference, byKey['split-s1'].status],
    ['Roofer Co', 'Disbursement · ACH', 'Ck #55501', 'Settled'],
  );
  assert.deepEqual(
    [byKey['split-s2'].title, byKey['split-s2'].reference],
    ['Bob Plumbing', 'Ck #1042'],
  );
  assert.deepEqual(
    [byKey['payroll-r1'].title, byKey['payroll-r1'].subtitle, byKey['payroll-r1'].reference, byKey['payroll-r1'].status],
    ['Ann', 'Payroll · memo r1', 'Payroll', 'Paid'],
  );
  assert.deepEqual(
    [byKey['payroll-fee-r1'].title, byKey['payroll-fee-r1'].subtitle, byKey['payroll-fee-r1'].reference, byKey['payroll-fee-r1'].status],
    [PAYROLL_SPEED_FEE_ROW_LABEL, 'Same Day · Ann', 'Same Day', 'Fee'],
  );
  assert.equal(byKey['payroll-fee-r2'].reference, 'Next Day');
  assert.equal(splitMethodLabel('external_check'), 'External check');
  assert.equal(splitMethodLabel(null), 'Disbursement');
});

test('a non-settled split never becomes a row, so the list cannot exceed the card', () => {
  const rows = revenueExpenseRows({ splits: [{ id: 'x', amount: 50, status: 'pending' }, { id: 'y', amount: 5, status: 'returned' }] });
  assert.deepEqual(rows, []);
});

test('empty inputs give no rows and a zero total', () => {
  assert.deepEqual(revenueExpenseRows({ splits: null, payrollRuns: undefined }), []);
  assert.equal(revenueExpenseRowsTotal([]), 0);
});

test('Revenue & Profit renders the Expenses table from the helper and keeps the card query filters', () => {
  const revenue = read('src/components/ledger/RevenueSummary.tsx');
  assert.match(revenue, /revenueExpenseRows\(\{ splits: disbursementData, payrollRuns \}\)/);
  assert.match(revenue, /\.select\(REVENUE_EXPENSE_SPLIT_COLUMNS\)\s*\.eq\("tenant_id", tenant!\.id\)\s*\.eq\("status", "settled"\);/);
  assert.match(revenue, /No paid expenses found\./);
  assert.match(revenue, /totalOutgoing = disbursementOutgoing \+ payroll\.total \+ speedFees\.total/);
  for (const col of ['amount', 'status', 'settled_at', 'created_at', 'recipient_name', 'external_check_number', 'stakeholder_accounts', 'check_number']) {
    assert.match(REVENUE_EXPENSE_SPLIT_COLUMNS, new RegExp(`\\b${col}\\b`), col);
  }
});
