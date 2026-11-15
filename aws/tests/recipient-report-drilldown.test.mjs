/**
 * Owner 2026-11-15: "In recipient report, I want to be able to click the recipient and the system
 * shows me every transaction between the tenant and that recipient, filter between sent and
 * received." Pure grouping and filtering in src/lib/payments/recipientDrilldown.ts, built from rows
 * the report already loads; the sheet is src/components/ledger/RecipientDrilldownSheet.tsx.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  drilldownMethodLabel,
  drilldownStatusLabel,
  drilldownTotals,
  filterByDirection,
  receivedTransactions,
  recipientTransactions,
  sentTransactions,
} from '../../src/lib/payments/recipientDrilldown.ts';
import { recipientTotalsByName } from '../../src/lib/payments/activeStakeholders.ts';
import { payrollRecipientReportRows } from '../../src/lib/payments/payrollRows.ts';
import { sendRecipientReportRows } from '../../src/lib/payments/transferFinanceRows.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

// The Freedom -> Condition One send of 2026-11-06 (as in transfer-finance-rows.test.mjs): two legs,
// recorded under the Moov account name "Condition One Commrecial".
const leg = (id, extra = {}) => ({
  id, check_id: 'chk-1', leg_role: 'send_wallet', status: 'submitted', amount_cents: 640520,
  created_at: '2026-11-06T19:06:01Z', submitted_at: '2026-11-06T19:06:02Z', completed_at: null,
  destination_tenant_id: 'c1-tenant',
  provider_metadata: { request_hash: 'h1', recipient_index: 0, recipient_kind: 'partner', recipient_id: 'c1-tenant', recipient_name: 'Condition One Commrecial' },
  check: { check_number: '1001', carrier_name: 'State Farm' },
  ...extra,
});
const FREEDOM_LEGS = [leg('w'), leg('b', { leg_role: 'send_bank', amount_cents: 190180 })];
const ORG_NAMES = new Map([['c1-tenant', 'Condition One Commercial']]);

// Split rows as RecipientReport normalizes them (name, type, amount, status, method, reference).
const split = (id, extra = {}) => ({
  id, date: '2026-11-08T10:00:00Z', name: 'Condition One Commercial', type: 'contractor', acct4: '••••1234',
  amount: 500, status: 'settled', method: 'actum', reference: null, ...extra,
});

const incoming = (id, extra = {}) => ({
  id, amount_cents: 20000, status: 'completed', environment: 'production', leg_role: 'send_wallet',
  created_at: '2026-11-10T09:00:00Z', submitted_at: '2026-11-10T09:00:01Z', completed_at: '2026-11-10T12:00:00Z',
  check_id: 'chk-9', sender_tenant_id: 'c1-tenant', sender_name: 'Condition One Commercial LLC',
  check_number: '2002', carrier_name: 'Allstate', claim_number: 'CL-77',
  ...extra,
});

const reportRows = () => [
  split('s1'),
  split('s2', { name: 'Condition One Commercial LLC', amount: 250.1, date: '2026-11-09T10:00:00Z', method: 'external_check', reference: '5550' }),
  split('s3', { status: 'returned', amount: 75, date: '2026-11-07T10:00:00Z' }),
  split('other', { name: 'Ann Roofing', amount: 999 }),
  ...sendRecipientReportRows(FREEDOM_LEGS, ORG_NAMES),
];

test('labels: split methods, payroll, sends and statuses read as words', () => {
  assert.equal(drilldownMethodLabel('actum'), 'ACH');
  assert.equal(drilldownMethodLabel('plaid'), 'ACH');
  assert.equal(drilldownMethodLabel(null), 'ACH');
  assert.equal(drilldownMethodLabel('external_check'), 'External check');
  assert.equal(drilldownMethodLabel('wire'), 'Wire');
  assert.equal(drilldownMethodLabel('manual'), 'Manual payment');
  assert.equal(drilldownMethodLabel('payroll'), 'Payroll');
  assert.equal(drilldownMethodLabel('something_new'), 'Something new');
  assert.equal(drilldownStatusLabel('settled'), 'Settled');
  assert.equal(drilldownStatusLabel('in_transit'), 'In transit');
  assert.equal(drilldownStatusLabel('returned'), 'Returned');
  assert.equal(drilldownStatusLabel(''), '—');
});

test('sent: split, payroll and send rows become transactions; a send carries its organization, check and transit status', () => {
  const payroll = payrollRecipientReportRows([{
    id: 'run-1', status: 'completed', amount: 1200, created_at: '2026-11-05T08:00:00Z',
    stakeholder_accounts: { id: 'sa-1', nickname: 'Ann Roofing', account_type: 'contractor', chk_acct: '9999' },
  }]);
  const rows = sentTransactions([...reportRows(), ...payroll], FREEDOM_LEGS);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const send = rows.find((r) => r.method === 'send');
  assert.deepEqual(
    { name: send.name, amount: send.amount, methodLabel: send.methodLabel, status: send.status, reference: send.reference, orgId: send.orgId, counted: send.counted, direction: send.direction },
    { name: 'Condition One Commercial', amount: 8307, methodLabel: 'Partner wallet', status: 'in_transit', reference: 'Ck #1001', orgId: 'c1-tenant', counted: true, direction: 'sent' },
  );
  assert.equal(byId.get('s2').methodLabel, 'External check');
  assert.equal(byId.get('s2').reference, 'Ck #5550');
  assert.equal(byId.get('s1').reference, null);
  assert.equal(byId.get('s3').counted, false);
  assert.equal(byId.get('s3').statusLabel, 'Returned');
  const pay = rows.find((r) => r.method === 'payroll');
  assert.deepEqual([pay.name, pay.methodLabel, pay.status, pay.counted, pay.orgId], ['Ann Roofing', 'Payroll', 'settled', true, null]);
  // Payroll groups with the payee's other payments.
  assert.deepEqual(recipientTransactions('Ann Roofing', rows).map((r) => r.method).sort(), ['actum', 'payroll']);
  // A completed send is settled.
  const done = sentTransactions(sendRecipientReportRows([leg('w', { status: 'completed', completed_at: '2026-11-06T20:00:00Z' })]), [leg('w', { status: 'completed', completed_at: '2026-11-06T20:00:00Z' })]);
  assert.equal(done[0].status, 'settled');
  // Rows with no date are left out; no legs means no send details, never a crash.
  assert.deepEqual(sentTransactions([split('x', { date: null })]), []);
  assert.equal(sentTransactions(sendRecipientReportRows(FREEDOM_LEGS), null)[0].methodLabel, 'Wallet send');
});

test('received: incoming partner payments, returned ones listed but not counted, the date range applied', () => {
  const rows = receivedTransactions([
    incoming('a'),
    incoming('r', { status: 'returned', created_at: '2026-11-11T09:00:00Z', completed_at: null, submitted_at: null }),
    incoming('f', { status: 'failed', created_at: '2026-11-12T09:00:00Z' }),
    incoming('old', { created_at: '2025-01-01T09:00:00Z', submitted_at: null, completed_at: '2025-01-01T10:00:00Z' }),
  ]);
  assert.deepEqual(rows.map((r) => [r.status, r.counted, r.amount]), [['returned', false, 200], ['completed', true, 200], ['completed', true, 200]]);
  assert.equal(rows[1].methodLabel, 'Partner wallet');
  assert.equal(rows[1].reference, 'Ck #2002 · Claim CL-77');
  assert.equal(rows[1].orgId, 'c1-tenant');
  assert.equal(rows[1].direction, 'received');
  const inYear = receivedTransactions([incoming('a'), incoming('old', { created_at: '2025-01-01T09:00:00Z', submitted_at: null, completed_at: '2025-01-01T10:00:00Z' })], (at) => at >= '2026-01-01');
  assert.deepEqual(inYear.map((r) => r.date), ['2026-11-10T12:00:00Z']);
});

test('grouping: one recipient gathers its rows by recipientNameKey and by organization id, newest first', () => {
  const all = [
    ...sentTransactions(reportRows(), FREEDOM_LEGS),
    // Recorded under another name, but from the same organization id as the partner send.
    ...receivedTransactions([incoming('a', { sender_name: 'C1 Roofing' }), incoming('z', { sender_tenant_id: 'zeta', sender_name: 'Zeta Builders', created_at: '2026-11-11T00:00:00Z' })]),
  ];
  const c1 = recipientTransactions('Condition One Commercial', all);
  assert.deepEqual(c1.map((t) => t.id).filter((id) => !id.startsWith('send:') && !id.startsWith('incoming-')), ['s2', 's1', 's3']);
  assert.equal(c1.filter((t) => t.direction === 'received').length, 1, 'matched by sender_tenant_id');
  assert.equal(c1.some((t) => t.name === 'Ann Roofing' || t.name === 'Zeta Builders'), false);
  // Newest first.
  const times = c1.map((t) => new Date(t.date).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  // Case, punctuation and a trailing LLC do not split a recipient.
  assert.equal(recipientTransactions('condition one commercial, llc', all).length, c1.length);
  assert.deepEqual(recipientTransactions('Nobody', all), []);
});

test('Condition One: a partner send plus contractor splits land under one recipient, in the report and in the drill-down', () => {
  const rows = reportRows();
  const report = recipientTotalsByName(rows.filter((r) => r.status === 'settled'));
  const c1Row = report.find((r) => r.name.startsWith('Condition One'));
  assert.equal(report.filter((r) => r.name.startsWith('Condition One')).length, 1);
  assert.deepEqual(c1Row.types, ['partner', 'contractor']);
  assert.equal(c1Row.total, 8307 + 500 + 250.1);

  const all = [...sentTransactions(rows, FREEDOM_LEGS), ...receivedTransactions([incoming('a')])];
  const mine = recipientTransactions(c1Row.name, all);
  const totals = drilldownTotals(mine);
  // The drill-down's Sent total is the report row's Total Paid.
  assert.equal(totals.sent.total, c1Row.total);
  assert.equal(totals.sent.count, c1Row.count);
  assert.deepEqual(totals.received, { total: 200, count: 1 });
  assert.equal(totals.net, 200 - 9057.1);
  assert.deepEqual(totals.rows, { all: 5, sent: 4, received: 1 });
});

test('direction filter and totals', () => {
  const all = recipientTransactions('Condition One Commercial', [
    ...sentTransactions(reportRows(), FREEDOM_LEGS),
    ...receivedTransactions([incoming('a'), incoming('r', { status: 'returned', created_at: '2026-11-11T09:00:00Z', completed_at: null, submitted_at: null })]),
  ]);
  assert.equal(filterByDirection(all, 'all'), all);
  assert.ok(filterByDirection(all, 'sent').every((t) => t.direction === 'sent'));
  assert.ok(filterByDirection(all, 'received').every((t) => t.direction === 'received'));
  assert.equal(filterByDirection(all, 'sent').length + filterByDirection(all, 'received').length, all.length);
  const t = drilldownTotals(all);
  assert.deepEqual(t.received, { total: 200, count: 1 }, 'the returned payment is listed, not totaled');
  assert.equal(t.rows.received, 2);
  // Cents, not floats.
  const cents = drilldownTotals([{ direction: 'sent', amount: 0.1, counted: true }, { direction: 'sent', amount: 0.2, counted: true }]);
  assert.equal(cents.sent.total, 0.3);
  assert.deepEqual(drilldownTotals([]), { sent: { total: 0, count: 0 }, received: { total: 0, count: 0 }, net: 0, rows: { all: 0, sent: 0, received: 0 } });
});

test('wiring: the recipient rows open the drill-down; the rename action still works; the sheet has the filter and the date range', () => {
  const report = read('src/components/ledger/RecipientReport.tsx');
  // Per-Recipient Detail and Received from: the row and a keyboard-reachable button open the sheet.
  assert.equal((report.match(/onClick=\{\(\) => setDrillName\(r\.name\)\}/g) ?? []).length, 2);
  assert.equal((report.match(/<button\s+type="button"[\s\S]{0,300}?aria-label=\{`Show transactions with \$\{r\.name\}`\}\s+onClick=\{\(e\) => \{ e\.stopPropagation\(\); setDrillName\(r\.name\); \}\}/g) ?? []).length, 2);
  // The pencil keeps renaming and does not open the sheet.
  assert.match(report, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); openEdit\(r\.name, r\.type, r\.splitVariants \?\? \[\]\); \}\}/);
  assert.match(report, /\(r\.splitVariants\?\.length \?\? 0\) > 0/);
  // Built from the rows already loaded: the normalized rows (every type), the send legs and the incoming transfers in range.
  assert.match(report, /\.\.\.sentTransactions\(normalized, sentLegs\),/);
  assert.match(report, /\.\.\.receivedTransactions\(incomingTransfers, \(at\) => inRange\(\[at\], \(x\) => x, dateFilters\)\.length > 0\),/);
  assert.match(report, /<RecipientDrilldownSheet\s+name=\{drillName\}\s+transactions=\{drillTransactions\}\s+rangeLabel=\{rangeLabel\}/);
  // The one field added to the existing split read: the check reference.
  assert.match(report, /external_check_number,\n\s+stakeholder_accounts \(id, nickname, custname, account_type, chk_acct\),\n\s+disbursement_batches \(check_intake_items:check_intake_item_id \(check_number\)\)/);
  // No write besides the existing rename.
  assert.equal((report.match(/\.update\(/g) ?? []).length, 1);

  const sheet = read('src/components/ledger/RecipientDrilldownSheet.tsx');
  assert.match(sheet, /from "@\/components\/ui\/sheet"/);
  assert.match(sheet, /<ToggleGroup\s+type="single"/);
  for (const value of ['all', 'sent', 'received']) assert.match(sheet, new RegExp(`value: "${value}"`));
  assert.match(sheet, /filterByDirection\(mine, filter\)/);
  assert.match(sheet, /drilldownTotals\(mine\)/);
  assert.match(sheet, /in the report's date range: <span[^>]*>\{rangeLabel\}<\/span>/);
  assert.match(sheet, /className="w-full max-w-full sm:max-w-xl/);
  assert.doesNotMatch(sheet, /supabase|useQuery/);
});
