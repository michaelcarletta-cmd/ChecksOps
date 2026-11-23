/**
 * Per-job P&L (owner 2026-11-23: "Proceed with the per job build. Make sure it is for insurance jobs and
 * cash jobs"). Step 1: Payments & Financials > Revenue & Profit gets a "Totals | By Job" toggle. Step 2:
 * a Job P&L card on a check's Funds tab (its claim) and on a cash job. Both use src/lib/jobPnl.ts; the
 * reads are src/lib/jobPnlLoad.ts. Website only: no database or API change. Fixtures only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  UNASSIGNED_JOB_KEY,
  buildJobPnl,
  isCountedCheck,
  isPendingCheck,
  jobKey,
  jobMargin,
  jobPnlFor,
  jobRefForCheck,
} from '../../src/lib/jobPnl.ts';
import {
  JOB_PNL_CASH_PAYMENT_COLUMNS,
  JOB_PNL_CHECK_COLUMNS,
  JOB_PNL_FEE_COLUMNS,
  loadJobPnlForJob,
  loadJobPnlTenantRows,
  withInvoiceClaims,
} from '../../src/lib/jobPnlLoad.ts';
import { REVENUE_EXPENSE_SPLIT_COLUMNS } from '../../src/lib/payments/revenueExpenseRows.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const byKey = (result) => new Map(result.jobs.map((job) => [job.key, job]));
const cents = (n) => Math.round(n * 100);

const CHECKS = [
  { id: 'ck1', amount: 1000, status: 'deposited', deposited_at: '2026-11-01T00:00:00Z', check_number: '101', carrier_name: 'Acme Mutual', claim_id: 'claim-a', customer_name: 'Pat Doe' },
  { id: 'ck2', amount: '500.50', status: 'funds_released', deposited_at: '2026-11-03T00:00:00Z', check_number: '102', carrier_name: 'Acme Mutual', claim_id: 'claim-a' },
  { id: 'ck3', amount: 250, status: 'pending_review', check_stage: 'review', created_at: '2026-11-05T00:00:00Z', check_number: '103', claim_id: 'claim-a' },
  { id: 'ck4', amount: 900, status: 'returned', check_stage: 'returned', claim_id: 'claim-a' },
  { id: 'ck5', amount: 2000, status: 'deposited', deposited_at: '2026-11-02T00:00:00Z', check_number: '501', cash_job_id: 'cash-1' },
  { id: 'ck6', amount: 300, status: 'deposited', deposited_at: '2026-11-04T00:00:00Z', check_number: '601', case_id: 'case-9', customer_name: 'Lee Case' },
  { id: 'ck7', amount: 400, status: 'deposited', deposited_at: '2026-11-06T00:00:00Z', check_number: '701' },
  { id: 'ck8', amount: 75, status: 'ready_for_deposit', check_stage: 'ready_for_deposit', check_number: '801' },
];

const fixture = () => ({
  checks: CHECKS,
  invoices: [
    { id: 'inv-a', at: '2026-11-07T00:00:00Z', invoiceNumber: 'INV-1', customerName: 'Pat Doe', amountCents: 12500, claimId: 'claim-a' },
    { id: 'inv-x', at: '2026-11-07T00:00:00Z', invoiceNumber: 'INV-2', customerName: 'Walk-in', amountCents: 5000, claimId: null },
  ],
  cashPayments: [
    // The database's automatic payment for deposited check ck5 (reference_number = the check id): same money.
    { id: 'cp-auto', cash_job_id: 'cash-1', amount: 2000, payment_date: '2026-11-02', payment_method: 'check', reference_number: 'ck5' },
    { id: 'cp-zelle', cash_job_id: 'cash-1', amount: 350, payment_date: '2026-11-08', payment_method: 'zelle', reference_number: 'ZX-1' },
  ],
  splits: [
    { id: 's1', amount: 400, status: 'settled', settled_at: '2026-11-09T00:00:00Z', method: 'ach', recipient_name: 'Roof Sub LLC', recipient_type: 'subcontractor', disbursement_batches: { id: 'b1', check_intake_item_id: 'ck1', check_intake_items: { check_number: '101' } } },
    // Check not among the given checks: the embedded check's links place it.
    { id: 's2', amount: 150, status: 'settled', settled_at: '2026-11-09T00:00:00Z', method: 'external_check', external_check_number: '9001', recipient_type: 'supplier', stakeholder_accounts: { nickname: 'ABC Supply' }, disbursement_batches: { id: 'b2', check_intake_item_id: 'ck-old', check_intake_items: { check_number: '55', cash_job_id: 'cash-1' } } },
    { id: 's3', amount: 999, status: 'pending', disbursement_batches: { id: 'b3', check_intake_item_id: 'ck1' } },
    { id: 's4', amount: 60, status: 'settled', recipient_name: 'Someone', disbursement_batches: { id: 'b4', check_intake_item_id: 'ck7' } },
  ],
  sends: [
    { id: 'l1', check_id: 'ck6', leg_role: 'send_wallet', status: 'completed', amount_cents: 10000, completed_at: '2026-11-10T00:00:00Z', provider_metadata: { recipient_name: 'Partner Co', recipient_kind: 'partner' }, destination_tenant_id: 't2' },
    { id: 'l2', check_id: 'ck-other', leg_role: 'send_bank', status: 'submitted', amount_cents: 2500, provider_metadata: { recipient_name: 'Vendor V', recipient_kind: 'vendor' }, check: { claim_id: 'claim-a', check_number: '999' } },
    { id: 'l3', check_id: 'ck1', leg_role: 'send_wallet', status: 'completed', amount_cents: 70000, provider_metadata: { purpose: 'payroll' } },
  ],
  fees: [
    { id: 'f1', amount_cents: 1000, status: 'billed', check_id: 'ck1', occurred_at: '2026-11-01T00:00:00Z' },
    { id: 'f2', amount_cents: 500, status: 'unbilled', claim_id: 'claim-a', occurred_at: '2026-11-11T00:00:00Z' },
    { id: 'f3', amount_cents: 700, status: 'void', check_id: 'ck1' },
    { id: 'f4', amount_cents: 200, status: 'unbilled', check_id: 'ck5' },
    { id: 'f5', amount_cents: 300, status: 'unbilled' },
  ],
  otherRevenue: [{ key: 'in-1', at: '2026-11-12T00:00:00Z', title: 'Partner Org', subtitle: 'Partner payment', reference: '7', amount: 80 }],
  claims: [{ id: 'claim-a', claim_number: 'CLM-1', policyholder_name: 'Pat Doe' }],
  cases: [{ id: 'case-9', claim_number: 'CASE-9', insured_name: null }],
  cashJobs: [{ id: 'cash-1', job_name: 'Smith roof', customer_name: 'Jo Smith' }],
});

test('check rules: deposited and funds_released count, in-process checks are pending, returned ones are neither', () => {
  assert.equal(isCountedCheck({ status: 'deposited' }), true);
  assert.equal(isCountedCheck({ status: 'FUNDS_RELEASED' }), true);
  assert.equal(isCountedCheck({ status: 'pending_review' }), false);
  assert.equal(isPendingCheck({ status: 'pending_review', check_stage: 'review' }), true);
  assert.equal(isPendingCheck({ status: 'approved', check_stage: 'ready_for_deposit' }), true);
  assert.equal(isPendingCheck({ status: 'returned' }), false);
  assert.equal(isPendingCheck({ status: 'x', check_stage: 'returned' }), false);
  assert.equal(isPendingCheck({ status: 'deposited' }), false);
  assert.deepEqual(jobRefForCheck({ claim_id: 'c', case_id: 'k', cash_job_id: 'j' }), { kind: 'claim', id: 'c' });
  assert.deepEqual(jobRefForCheck({ case_id: 'k', cash_job_id: 'j' }), { kind: 'case', id: 'k' });
  assert.deepEqual(jobRefForCheck({ cash_job_id: 'j' }), { kind: 'cash_job', id: 'j' });
  assert.equal(jobRefForCheck({ claim_id: '  ' }), null);
});

test('claim, case and cash-job grouping, with names as the app labels them', () => {
  const jobs = byKey(buildJobPnl(fixture()));
  const claim = jobs.get('claim:claim-a');
  assert.equal(claim.type, 'claim');
  assert.equal(claim.name, 'Pat Doe');
  assert.equal(claim.subtitle, 'Claim #CLM-1');
  // ck1 + ck2 + its invoice.
  assert.equal(cents(claim.revenue), 100000 + 50050 + 12500);
  const kase = jobs.get('case:case-9');
  assert.equal(kase.type, 'claim');
  assert.equal(kase.name, 'Lee Case', 'falls back to the insured name on its checks');
  assert.equal(kase.subtitle, 'Claim #CASE-9');
  const cash = jobs.get('cash_job:cash-1');
  assert.equal(cash.type, 'cash_job');
  assert.equal(cash.name, 'Smith roof');
  assert.equal(cash.subtitle, 'Jo Smith');
  // Deposited check ck5 + the Zelle payment; the automatic payment for ck5 is not counted twice.
  assert.equal(cents(cash.revenue), 200000 + 35000);
  assert.deepEqual(cash.moneyIn.map((l) => l.key).sort(), ['cash-payment-cp-zelle', 'check-ck5']);
  const zelle = cash.moneyIn.find((l) => l.source === 'cash_payment');
  assert.equal(zelle.title, 'Zelle payment');
  assert.equal(zelle.dateLabel, 'Paid');
  assert.match(zelle.detail, /Ref ZX-1/);
});

test('money linked to no job goes to the Unassigned row, listed last', () => {
  const result = buildJobPnl(fixture());
  const last = result.jobs[result.jobs.length - 1];
  assert.equal(last.key, UNASSIGNED_JOB_KEY);
  assert.equal(last.type, 'unassigned');
  assert.equal(last.ref, null);
  // ck7 + invoice without claim + partner payment.
  assert.equal(cents(last.revenue), 40000 + 5000 + 8000);
  // s4 (from ck7) + the fee with neither check nor claim.
  assert.equal(cents(last.costs), 6000 + 300);
  assert.equal(last.pendingCount, 1, 'ck8 is in process and on no job');
  assert.equal(result.totals.jobCount, 3, 'the Unassigned row is not a job');
  assert.equal(jobKey(null), UNASSIGNED_JOB_KEY);
});

test('deposited vs pending: pending checks are flagged with their amount, never counted', () => {
  const claim = byKey(buildJobPnl(fixture())).get('claim:claim-a');
  assert.equal(claim.pendingCount, 1);
  assert.equal(claim.pendingAmount, 250);
  assert.deepEqual(claim.pendingChecks.map((l) => l.title), ['Check #103']);
  assert.equal(claim.moneyIn.some((l) => l.key === 'check-ck3' || l.key === 'check-ck4'), false);
  const released = claim.moneyIn.find((l) => l.key === 'check-ck2');
  assert.equal(released.dateLabel, 'Funds released');
  assert.equal(released.detail, 'Acme Mutual');
  assert.equal(claim.moneyIn.find((l) => l.key === 'check-ck1').dateLabel, 'Deposited');
  // A check given both as pending and as counted counts once, as counted.
  const dup = buildJobPnl({ checks: [{ ...CHECKS[2], status: 'deposited' }, CHECKS[2]] });
  assert.equal(dup.totals.revenue, 250);
  assert.equal(dup.totals.pendingCount, 0);
});

test('payouts reach the job through batch -> check -> job; only settled splits count', () => {
  const jobs = byKey(buildJobPnl(fixture()));
  const claim = jobs.get('claim:claim-a');
  const payout = claim.moneyOut.find((l) => l.key === 'split-s1');
  assert.equal(payout.title, 'Roof Sub LLC');
  assert.equal(payout.detail, 'Subcontractor · ACH · from check #101');
  assert.equal(payout.dateLabel, 'Settled');
  assert.equal(claim.moneyOut.some((l) => l.key === 'split-s3'), false, 'a pending split is not a cost');
  const cash = jobs.get('cash_job:cash-1');
  const external = cash.moneyOut.find((l) => l.key === 'split-s2');
  assert.equal(external.title, 'ABC Supply');
  assert.equal(external.detail, 'Supplier · External check #9001 · from check #55');
});

test('sends: by the sent check, else the check\'s claim; payroll sends are never job costs', () => {
  const jobs = byKey(buildJobPnl(fixture()));
  const kase = jobs.get('case:case-9');
  assert.equal(cents(kase.costs), 10000);
  assert.equal(kase.moneyOut[0].detail, 'Partner · Payment sent · from check #601');
  const claim = jobs.get('claim:claim-a');
  const vendor = claim.moneyOut.find((l) => l.source === 'send');
  assert.equal(vendor.title, 'Vendor V');
  assert.equal(vendor.amount, 25);
  assert.equal(vendor.dateLabel, 'Sent');
  const all = buildJobPnl(fixture()).jobs.flatMap((j) => j.moneyOut);
  assert.equal(all.some((l) => l.amount === 700), false, 'the payroll leg is left out');
});

test('ChecksOps fees: summed into one line per job, by check then claim; void fees are skipped', () => {
  const jobs = byKey(buildJobPnl(fixture()));
  const claimFees = jobs.get('claim:claim-a').moneyOut.filter((l) => l.source === 'fees');
  assert.equal(claimFees.length, 1);
  assert.equal(claimFees[0].title, 'ChecksOps fees');
  assert.equal(claimFees[0].amount, 15);
  assert.equal(claimFees[0].detail, '2 fees combined');
  assert.equal(claimFees[0].at, '2026-11-11T00:00:00Z');
  assert.equal(jobs.get('cash_job:cash-1').moneyOut.find((l) => l.source === 'fees').amount, 2);
  assert.equal(buildJobPnl(fixture()).reconciliation.fees, 15 + 2 + 3);
});

test('margin: percent of revenue, null (shown as —) with zero revenue; a costs-only job is a loss', () => {
  assert.equal(jobMargin(0, -50), null);
  assert.equal(jobMargin(-1, 0), null);
  assert.equal(jobMargin(200, 50), 25);
  const result = buildJobPnl({ splits: [{ id: 'x', status: 'settled', amount: 80, disbursement_batches: { check_intake_items: { claim_id: 'c9' } } }] });
  const job = result.jobs[0];
  assert.equal(job.key, 'claim:c9');
  assert.equal(job.revenue, 0);
  assert.equal(job.profit, -80);
  assert.equal(job.margin, null);
  assert.equal(result.totals.margin, null);
  const claim = byKey(buildJobPnl(fixture())).get('claim:claim-a');
  assert.ok(Math.abs(claim.margin - (claim.profit / claim.revenue) * 100) < 1e-9);
});

test('totals equal the sum of the rows, and reconcile with the Totals view', () => {
  const input = fixture();
  const result = buildJobPnl(input);
  const sum = (pick) => result.jobs.reduce((s, j) => s + cents(pick(j)), 0);
  assert.equal(cents(result.totals.revenue), sum((j) => j.revenue));
  assert.equal(cents(result.totals.costs), sum((j) => j.costs));
  assert.equal(cents(result.totals.profit), sum((j) => j.profit));
  assert.equal(cents(result.totals.pendingAmount), sum((j) => j.pendingAmount));
  assert.equal(result.totals.pendingCount, result.jobs.reduce((s, j) => s + j.pendingCount, 0));
  for (const job of result.jobs) {
    assert.equal(cents(job.revenue), job.moneyIn.reduce((s, l) => s + cents(l.amount), 0), job.key);
    assert.equal(cents(job.costs), job.moneyOut.reduce((s, l) => s + cents(l.amount), 0), job.key);
  }
  // Totals view revenue: deposited/released checks + paid invoices + partner payments.
  const totalsViewRevenue = CHECKS.filter((c) => isCountedCheck(c)).reduce((s, c) => s + cents(Number(c.amount)), 0)
    + input.invoices.reduce((s, i) => s + i.amountCents, 0) + cents(80);
  assert.equal(cents(result.totals.revenue), totalsViewRevenue + cents(result.reconciliation.cashPaymentsRevenue));
  assert.equal(result.reconciliation.cashPaymentsRevenue, 350);
  // Totals view costs (without payroll): settled splits + paid sends (payroll legs excluded).
  const totalsViewCosts = cents(400 + 150 + 60) + 10000 + 2500;
  assert.equal(cents(result.totals.costs), totalsViewCosts + cents(result.reconciliation.fees));
  // Jobs sorted by revenue, Unassigned last.
  assert.deepEqual(result.jobs.map((j) => j.key), ['cash_job:cash-1', 'claim:claim-a', 'case:case-9', UNASSIGNED_JOB_KEY]);
});

test('expenses: the step-3 extension point adds costs to the named job (empty today)', () => {
  const result = buildJobPnl({ ...fixture(), expenses: [{ id: 'e1', job: { kind: 'cash_job', id: 'cash-1' }, amount: '120.25', payee: 'Dumpster Co', category: 'Materials' }] });
  const line = byKey(result).get('cash_job:cash-1').moneyOut.find((l) => l.source === 'expense');
  assert.equal(line.title, 'Dumpster Co');
  assert.equal(line.amount, 120.25);
  assert.equal(result.reconciliation.expenses, 120.25);
  assert.equal(buildJobPnl(fixture()).reconciliation.expenses, 0);
});

test('jobPnlFor: one job, or an empty named one', () => {
  assert.equal(jobPnlFor(fixture(), { kind: 'claim', id: 'claim-a' }).name, 'Pat Doe');
  const empty = jobPnlFor({ cashJobs: [{ id: 'cash-2', job_name: 'Gutters' }] }, { kind: 'cash_job', id: 'cash-2' });
  assert.equal(empty.name, 'Gutters');
  assert.equal(empty.type, 'cash_job');
  assert.equal(empty.revenue, 0);
  assert.equal(empty.margin, null);
  assert.deepEqual(empty.moneyIn, []);
  assert.deepEqual(withInvoiceClaims([{ id: 'a' }, { id: 'b' }], [{ id: 'a', claim_id: 'c1' }]), [{ id: 'a', claimId: 'c1' }, { id: 'b', claimId: null }]);
});

/** A tiny stand-in for the data client: records each read and answers from in-memory tables. */
function fakeClient(tables) {
  const calls = [];
  const from = (table) => {
    const q = { table, filters: [], select: null };
    const run = () => {
      calls.push(q);
      let rows = (tables[table] ?? []).slice();
      for (const [op, col, val] of q.filters) {
        if (op === 'eq') rows = rows.filter((r) => r[col] === val);
        if (op === 'neq') rows = rows.filter((r) => r[col] !== val);
        if (op === 'in') rows = rows.filter((r) => val.includes(r[col]));
        if (op === 'not-in') rows = rows.filter((r) => !val.includes(r[col]));
        if (op === 'not-null') rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
      }
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      return Promise.resolve({ data: rows, error: null, count: null });
    };
    const b = {
      select(cols) { q.select = cols; return b; },
      eq(c, v) { q.filters.push(['eq', c, v]); return b; },
      neq(c, v) { q.filters.push(['neq', c, v]); return b; },
      in(c, v) { q.filters.push(['in', c, v]); return b; },
      not(c, op, v) {
        if (op === 'is') q.filters.push(['not-null', c]);
        else q.filters.push(['not-in', c, String(v).replace(/[()]/g, '').split(',')]);
        return b;
      },
      order() { return b; },
      range(a, z) { q.range = [a, z]; return b; },
      then(ok, bad) { return run().then(ok, bad); },
    };
    return b;
  };
  return { client: { from }, calls };
}

test('loader: one claim job reads its checks, their payouts, sends, fees and invoice links (tenant-scoped)', async () => {
  const { client, calls } = fakeClient({
    check_intake_items: [
      { id: 'ck1', tenant_id: 't1', claim_id: 'claim-a', status: 'deposited', amount: 100, check_number: '1' },
      { id: 'ckz', tenant_id: 't2', claim_id: 'claim-a', status: 'deposited', amount: 999 },
    ],
    disbursement_batches: [{ id: 'b1', tenant_id: 't1', check_intake_item_id: 'ck1' }],
    disbursement_splits: [{ id: 's1', tenant_id: 't1', batch_id: 'b1', status: 'settled', amount: 40, disbursement_batches: { check_intake_item_id: 'ck1' } }],
    payment_transfers: [{ id: 'l1', tenant_id: 't1', claim_id: 'claim-a', check_id: null, leg_role: 'send_wallet', status: 'completed', amount_cents: 500, provider_metadata: {} }],
    platform_fee_line_items: [{ id: 'f1', tenant_id: 't1', check_id: 'ck1', amount_cents: 100, status: 'billed' }, { id: 'f1', tenant_id: 't1', claim_id: 'claim-a', check_id: 'ck1', amount_cents: 100, status: 'billed' }],
    moov_invoices: [{ id: 'inv', tenant_id: 't1', claim_id: 'claim-a' }],
    claims: [{ id: 'claim-a', claim_number: 'C-1', policyholder_name: 'Pat' }],
  });
  const ref = { kind: 'claim', id: 'claim-a' };
  const rows = await loadJobPnlForJob(client, 't1', ref);
  assert.deepEqual(rows.checks.map((c) => c.id), ['ck1']);
  assert.deepEqual(rows.invoiceClaims, [{ id: 'inv', tenant_id: 't1', claim_id: 'claim-a' }]);
  assert.equal(rows.fees.length, 1, 'a fee read by check and by claim counts once');
  const job = jobPnlFor({ ...rows, invoices: [] }, ref);
  assert.equal(job.name, 'Pat');
  assert.equal(job.revenue, 100);
  assert.equal(job.costs, 0.4 * 100 + 5 + 1);
  for (const q of calls) {
    if (q.table === 'claims') continue;
    assert.ok(q.filters.some(([op, col, val]) => op === 'eq' && col === 'tenant_id' && val === 't1'), `${q.table} is tenant-scoped`);
  }
  assert.ok(calls.some((q) => q.table === 'disbursement_splits' && q.select === REVENUE_EXPENSE_SPLIT_COLUMNS));
});

test('loader: By Job reads checks still in process, cash-job payments, fees and invoice links', async () => {
  const { client, calls } = fakeClient({
    check_intake_items: [
      { id: 'a', tenant_id: 't1', status: 'deposited' },
      { id: 'b', tenant_id: 't1', status: 'pending_review' },
    ],
    cash_job_payments: [{ id: 'p', tenant_id: 't1', cash_job_id: 'j', amount: 5 }],
    platform_fee_line_items: [{ id: 'f', tenant_id: 't1', status: 'void' }, { id: 'g', tenant_id: 't1', status: 'billed' }],
    moov_invoices: [{ id: 'i1', tenant_id: 't1', claim_id: null }, { id: 'i2', tenant_id: 't1', claim_id: 'c' }],
  });
  const rows = await loadJobPnlTenantRows(client, 't1');
  assert.deepEqual(rows.pendingChecks.map((c) => c.id), ['b']);
  assert.deepEqual(rows.cashPayments.map((p) => p.id), ['p']);
  assert.deepEqual(rows.fees.map((f) => f.id), ['g']);
  assert.deepEqual(rows.invoiceClaims.map((i) => i.id), ['i2']);
  assert.deepEqual(rows.unavailable, []);
  assert.ok(calls.find((q) => q.table === 'check_intake_items').select === JOB_PNL_CHECK_COLUMNS);
  // A fee read that fails leaves fees out and says so instead of failing the view.
  const failing = {
    from: (table) => (table === 'platform_fee_line_items'
      ? { select: () => { const b = { eq: () => b, neq: () => b, order: () => b, range: () => Promise.resolve({ data: null, error: new Error('denied') }) }; return b; } }
      : client.from(table)),
  };
  const partial = await loadJobPnlTenantRows(failing, 't1');
  assert.deepEqual(partial.unavailable, ['fees']);
  assert.deepEqual(partial.fees, []);
});

test('reads only tables the data API serves, and no secret column', () => {
  const allowed = new Set(JSON.parse(read('aws/functions/api/allowed-tables.json')));
  const loader = read('src/lib/jobPnlLoad.ts');
  const tables = [...loader.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
  assert.ok(tables.length >= 8);
  for (const table of tables) assert.ok(allowed.has(table), table);
  const data = read('aws/functions/api/data.mjs');
  for (const secret of ['mortgage_portal_password', 'plaid_access_token', 'verification_token', 'public_token']) {
    assert.doesNotMatch(`${JOB_PNL_CHECK_COLUMNS} ${JOB_PNL_FEE_COLUMNS} ${JOB_PNL_CASH_PAYMENT_COLUMNS} ${REVENUE_EXPENSE_SPLIT_COLUMNS} ${loader}`, new RegExp(`\\b${secret}\\b`));
    assert.match(data, new RegExp(secret));
  }
  assert.doesNotMatch(loader, /from "@\//);
  assert.doesNotMatch(read('src/lib/jobPnl.ts'), /from "@\//);
  assert.doesNotMatch(loader, /\.(insert|update|upsert|delete|rpc)\(/);
});

test('wiring: Revenue & Profit has Totals | By Job; the card shows with the Claim Ledger (owner only) and on a cash job', () => {
  const summary = read('src/components/ledger/RevenueSummary.tsx');
  assert.match(summary, /useState<RevenueView>\("totals"\)/);
  assert.match(summary, /<ToggleGroupItem value="totals"[^>]*>Totals<\/ToggleGroupItem>/);
  assert.match(summary, /<ToggleGroupItem value="byJob"[^>]*>By Job<\/ToggleGroupItem>/);
  assert.match(summary, /<RevenueByJob\s+countedChecks=\{countedChecks\}\s+splits=\{disbursementData as JobPnlSplit\[\] \| undefined\}/);
  assert.match(summary, /payrollNotAllocated=\{stats\.payrollOutgoing \+ stats\.speedFeeOutgoing\}/);
  // Totals stays as it was.
  assert.match(summary, /const totalOutgoing = disbursementOutgoing \+ payroll\.total \+ speedFees\.total \+ sends\.total;/);
  const byJob = read('src/components/ledger/RevenueByJob.tsx');
  assert.match(byJob, /buildJobPnl\(/);
  assert.match(byJob, /Payroll and other company-wide costs are not allocated to jobs/);
  assert.match(byJob, /expenses: \[\]/);
  assert.match(byJob, /to=\{`\.\.\/cash-jobs\?job=\$\{encodeURIComponent\(job\.ref\.id\)\}`\}/);
  // The claim's card rides with the Claim Ledger (the check's Funds tab passes readOnly={isSharedView}),
  // so the release-locked CheckCommandCenter.tsx is not edited.
  const ledger = read('src/components/payments/ClaimLedgerCard.tsx');
  assert.match(ledger, /export function ClaimLedgerCard\(props: Props\)/);
  assert.match(ledger, /const jobClaimId = readOnly\s*\? null/);
  assert.match(ledger, /<ClaimLedgerCardBody \{\.\.\.props\} \/>\s*\{jobClaimId \? \(\s*<div className="mt-4">\s*<JobPnlCard job=\{\{ kind: "claim", id: jobClaimId \}\} \/>/);
  const page = read('src/pages/CheckCommandCenter.tsx');
  assert.match(page, /<ClaimLedgerCard\s+checkIntakeItemId=\{checkId\}\s+claimId=\{check\.claim_id \?\? null\}\s+detectedClaimNumber=\{check\.detected_claim_number \?\? null\}\s+readOnly=\{isSharedView\}/);
  assert.doesNotMatch(page, /JobPnlCard/);
  const cash = read('src/components/cash-jobs/CashJobDetail.tsx');
  assert.match(cash, /<JobPnlCard job=\{\{ kind: "cash_job", id: jobId \}\} \/>/);
  const card = read('src/components/jobs/JobPnlCard.tsx');
  assert.match(card, /jobPnlFor\(/);
  assert.match(card, /usePaidInvoiceRevenue\(\)/);
});
