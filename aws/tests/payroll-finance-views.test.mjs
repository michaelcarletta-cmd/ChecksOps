import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  PAYROLL_FINANCE_QUERY_KEY,
  PAYROLL_SOURCE_LABEL,
  fetchPayrollRuns,
  isPayrollPaid,
  payrollExpenseTotal,
  payrollLedgerRows,
  payrollLedgerStatus,
  payrollRecipientReportRows,
  payrollStatusBucket,
  payrollTaxPayments,
} from '../../src/lib/payments/payrollRows.ts';
import { aggregateRecipientRows } from '../../src/lib/taxYtdSummary.ts';
import { PAYROLL_RUN_COLUMNS, payrollSpeedFeeExpenseTotal } from '../../src/lib/payments/payrollRows.ts';
import {
  PAYROLL_SPEED_FEES,
  PAYROLL_SPEED_FEES_LABEL,
  payrollSpeedFee,
} from '../../src/lib/payments/payrollSpeedFees.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const ann = { id: 'acct-ann', nickname: 'Ann', custname: 'Ann Lee', account_type: 'contractor', chk_acct: '000123456789' };
const run = (id, status, amount, created_at = '2026-03-10T15:00:00.000Z', extra = {}) => ({
  id, status, amount, memo: `memo ${id}`, created_at, stakeholder_account_id: ann.id, stakeholder_accounts: ann, ...extra,
});

const runs = [
  run('r1', 'submitted', '400.00'),
  run('r2', 'completed', 150),
  run('r3', 'pending', 75),
  run('r4', 'partial', 60),
  run('r5', 'unknown', 40),
  run('r6', 'failed', 999),
];

test('status rules: submitted/completed are paid, failed is excluded, pending stays pending, the rest are in flight', () => {
  assert.equal(payrollStatusBucket('submitted'), 'paid');
  assert.equal(payrollStatusBucket('completed'), 'paid');
  assert.equal(payrollStatusBucket('pending'), 'pending');
  assert.equal(payrollStatusBucket('failed'), 'excluded');
  assert.equal(payrollStatusBucket('partial'), 'in_flight');
  assert.equal(payrollStatusBucket('unknown'), 'in_flight');
  assert.equal(payrollStatusBucket(null), 'in_flight');
  assert.equal(payrollLedgerStatus('submitted'), 'settled');
  assert.equal(payrollLedgerStatus('partial'), 'submitted');
  assert.equal(payrollLedgerStatus('pending'), 'pending');
  assert.equal(payrollLedgerStatus('failed'), null);
  assert.equal(isPayrollPaid({ status: 'submitted' }), true);
  assert.equal(isPayrollPaid({ status: 'partial' }), false);
});

test('Payment History rows: labelled payroll, pending and failed left out, only paid rows settled', () => {
  const rows = payrollLedgerRows(runs);
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [
    ['payroll:r1', 'settled'],
    ['payroll:r2', 'settled'],
    ['payroll:r4', 'submitted'],
    ['payroll:r5', 'submitted'],
  ]);
  const [first] = rows;
  assert.equal(first.source, 'payroll');
  assert.equal(first.method, 'payroll');
  assert.equal(first.amount, 400);
  assert.equal(first.memo, 'memo r1');
  assert.equal(first.recipient_name, 'Ann');
  assert.equal(first.recipient_type, 'contractor');
  assert.equal(first.stakeholder_accounts.id, ann.id);
  assert.equal(first.settled_at, first.created_at);
  assert.equal(rows[2].settled_at, null);
  assert.equal(PAYROLL_SOURCE_LABEL, 'Payroll');
});

test('a run without the stakeholder embed still keys to its payee account', () => {
  const [row] = payrollLedgerRows([run('r7', 'submitted', 10, undefined, { stakeholder_accounts: null })]);
  assert.equal(row.stakeholder_accounts.id, ann.id);
  assert.equal(row.recipient_name, 'Payroll payee');
  assert.equal(row.recipient_type, 'other');
});

test('By Recipient rows use the payee name and type, so they group with the payee', () => {
  const rows = payrollRecipientReportRows(runs);
  assert.equal(rows.length, 4);
  assert.deepEqual(new Set(rows.map((r) => `${r.type}|${r.name}`)), new Set(['contractor|Ann']));
  assert.equal(rows[0].acct4, '••••6789');
  assert.equal(rows.filter((r) => r.status === 'settled').reduce((s, r) => s + r.amount, 0), 550);
});

test('Revenue & Profit: only paid payroll is an expense, amount only', () => {
  assert.deepEqual(payrollExpenseTotal(runs), { total: 550, count: 2 });
  assert.deepEqual(payrollExpenseTotal(null), { total: 0, count: 0 });
});

test('Tax & 1099: paid payroll merges with the payee\'s splits under acct:<id> and counts toward $600', () => {
  assert.equal(payrollTaxPayments(runs).length, 2);
  const split = { settled_at: '2026-02-01T12:00:00.000Z', created_at: '2026-01-30T12:00:00.000Z', amount: 100, stakeholder_accounts: ann };
  const withoutPayroll = aggregateRecipientRows({ payments: [split], year: 2026 });
  assert.equal(withoutPayroll[0].needs_1099, false);

  const rows = aggregateRecipientRows({ payments: [split], payrollRuns: runs, year: 2026 });
  assert.equal(rows.length, 1);
  const [annRow] = rows;
  assert.equal(annRow.id, `acct:${ann.id}`);
  assert.equal(annRow.total, 650);
  assert.equal(annRow.payment_count, 3);
  assert.equal(annRow.monthly[1], 100); // February, from the split's settled_at
  assert.equal(annRow.monthly[2], 550); // March, from payroll created_at
  assert.equal(annRow.needs_1099, true);
});

test('Tax & 1099: payroll from another year is left out', () => {
  const rows = aggregateRecipientRows({ payrollRuns: [run('old', 'submitted', 700, '2025-12-31T12:00:00.000Z')], year: 2026 });
  assert.deepEqual(rows, []);
});

test('fetchPayrollRuns: tenant filter, optional created_at range, newest first', async () => {
  const calls = [];
  const query = {
    eq: (...a) => (calls.push(['eq', ...a]), query),
    gte: (...a) => (calls.push(['gte', ...a]), query),
    lte: (...a) => (calls.push(['lte', ...a]), query),
    order: (...a) => (calls.push(['order', ...a]), Promise.resolve({ data: [runs[0]], error: null })),
  };
  const client = { from: (t) => (calls.push(['from', t]), { select: (c) => (calls.push(['select', c.includes('stakeholder_accounts')]), query) }) };
  const out = await fetchPayrollRuns(client, 't1', { from: 'A', to: 'B' });
  assert.equal(out.length, 1);
  assert.deepEqual(calls, [
    ['from', 'payroll_runs'],
    ['select', true],
    ['eq', 'tenant_id', 't1'],
    ['gte', 'created_at', 'A'],
    ['lte', 'created_at', 'B'],
    ['order', 'created_at', { ascending: false }],
  ]);
  calls.length = 0;
  await fetchPayrollRuns(client, 't1');
  assert.equal(calls.some(([k]) => k === 'gte' || k === 'lte'), false);

  const failing = { from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: new Error('rls') }) }) }) }) };
  await assert.rejects(() => fetchPayrollRuns(failing, 't1'), /rls/);
});

test('the four finance screens read payroll, and a payroll send refreshes them', () => {
  for (const file of [
    'src/components/ledger/PaymentLedger.tsx',
    'src/components/ledger/RevenueSummary.tsx',
    'src/components/ledger/RecipientReport.tsx',
    'src/components/ledger/TaxSummary.tsx',
  ]) {
    const src = read(file);
    assert.match(src, /fetchPayrollRuns\(/, file);
    assert.match(src, /queryKey: \[PAYROLL_FINANCE_QUERY_KEY,/, file);
  }
  assert.match(read('src/components/ledger/TaxSummary.tsx'), /aggregateRecipientRows\(\{[^}]*payrollRuns/);
  const dialog = read('src/components/payroll/RunPayrollDialog.tsx');
  assert.match(dialog, /invalidateQueries\(\{ queryKey: \[PAYROLL_FINANCE_QUERY_KEY\] \}\)/);
  assert.equal(PAYROLL_FINANCE_QUERY_KEY, 'payroll-finance');
});

test('speed fee mapping: next_day 0.75, same_day 1.00, anything else 0', () => {
  assert.deepEqual({ ...PAYROLL_SPEED_FEES }, { next_day: 0.75, same_day: 1 });
  assert.equal(payrollSpeedFee('next_day'), 0.75);
  assert.equal(payrollSpeedFee('same_day'), 1);
  assert.equal(payrollSpeedFee('instant'), 0);
  assert.equal(payrollSpeedFee('NEXT_DAY'), 0);
  assert.equal(payrollSpeedFee(''), 0);
  assert.equal(payrollSpeedFee(null), 0);
  assert.equal(payrollSpeedFee(undefined), 0);
  assert.equal(PAYROLL_SPEED_FEES_LABEL, 'Payroll speed fees');
});

test('Revenue & Profit: speed fees of paid runs only, a separate expense line', () => {
  const speedRuns = [
    run('s1', 'submitted', 400, undefined, { speed: 'next_day' }),
    run('s2', 'completed', 150, undefined, { speed: 'same_day' }),
    run('s3', 'submitted', 10, undefined, { speed: 'next_day' }),
    run('s4', 'completed', 20, undefined, { speed: 'warp' }),
    run('s5', 'submitted', 30, undefined, { speed: null }),
    run('s6', 'failed', 999, undefined, { speed: 'same_day' }),
    run('s7', 'pending', 75, undefined, { speed: 'same_day' }),
    run('s8', 'partial', 60, undefined, { speed: 'next_day' }),
    run('s9', 'unknown', 40, undefined, { speed: 'same_day' }),
  ];
  assert.deepEqual(payrollSpeedFeeExpenseTotal(speedRuns), { total: 2.5, count: 3 });
  assert.deepEqual(payrollSpeedFeeExpenseTotal(null), { total: 0, count: 0 });
  // The payee amount line is unchanged by the fee.
  assert.deepEqual(payrollExpenseTotal(speedRuns), { total: 610, count: 5 });
  // Summed in cents: ten next-day fees are exactly 7.50.
  const many = Array.from({ length: 10 }, (_, i) => run(`m${i}`, 'submitted', 1, undefined, { speed: 'next_day' }));
  assert.deepEqual(payrollSpeedFeeExpenseTotal(many), { total: 7.5, count: 10 });
});

test('the speed fee never reaches the payee views (Payment History, By Recipient, Tax & 1099)', () => {
  const paid = [run('p1', 'submitted', 400, undefined, { speed: 'same_day' }), run('p2', 'completed', 200, undefined, { speed: 'next_day' })];
  assert.deepEqual(payrollLedgerRows(paid).map((r) => r.amount), [400, 200]);
  assert.deepEqual(payrollRecipientReportRows(paid).map((r) => r.amount), [400, 200]);
  assert.deepEqual(payrollTaxPayments(paid).map((p) => p.amount), [400, 200]);
  assert.equal(aggregateRecipientRows({ payrollRuns: paid, year: 2026 })[0].total, 600);
});

test('one fee schedule: the dialog and Revenue & Profit read the shared helper, and the query selects speed', () => {
  const dialog = read('src/components/payroll/RunPayrollDialog.tsx');
  assert.match(dialog, /from "@\/lib\/payments\/payrollSpeedFees"/);
  assert.doesNotMatch(dialog, /next_day:\s*0\.75/);
  const revenue = read('src/components/ledger/RevenueSummary.tsx');
  assert.match(revenue, /payrollSpeedFeeExpenseTotal\(payrollRuns\)/);
  assert.match(revenue, /PAYROLL_SPEED_FEES_LABEL/);
  assert.match(revenue, /totalOutgoing = disbursementOutgoing \+ payroll\.total \+ speedFees\.total/);
  for (const file of ['src/components/ledger/PaymentLedger.tsx', 'src/components/ledger/RecipientReport.tsx', 'src/components/ledger/TaxSummary.tsx']) {
    assert.doesNotMatch(read(file), /SpeedFee|payrollSpeedFees/, file);
  }
  assert.match(PAYROLL_RUN_COLUMNS, /\bspeed\b/);
});
