/**
 * Owner 2026-11-06: "include partner payments as income not tax. Payment being sent to partners or anyone is an
 * expense for that company and any money coming in is income." A send writes payment_transfers legs under the
 * sender's tenant_id (no disbursement split), so Payments & Financials counted neither side; the recipient reads its
 * incoming legs through SQL 144's get_tenant_incoming_transfers (src/lib/payments/transferFinanceRows.ts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACCEPTED_SEND_STATUSES,
  INCOMING_TRANSFERS_RPC,
  fetchIncomingTransfers,
  incomingBySender,
  incomingFundsReceivedRows,
  incomingLedgerRows,
  incomingPayments,
  incomingRevenueRows,
  incomingRevenueTotal,
  incomingWalletActivity,
  isPaidSendLeg,
  sendExpenseRows,
  sendExpenseTotal,
  sendLedgerRows,
  sendRecipientReportRows,
  sentPayments,
} from '../../src/lib/payments/transferFinanceRows.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const send = read('aws/functions/api/providers/production/moov-send.mjs');

const leg = (id, extra = {}) => ({
  id, check_id: 'chk-1', leg_role: 'send_wallet', status: 'submitted', amount_cents: 640520,
  created_at: '2026-11-06T19:06:01Z', submitted_at: '2026-11-06T19:06:02Z', completed_at: null,
  destination_tenant_id: 'c1-tenant',
  provider_metadata: { request_hash: 'h1', recipient_index: 0, recipient_kind: 'partner', recipient_id: 'c1-tenant', recipient_name: 'Condition One Commrecial' },
  check: { check_number: '1001', carrier_name: 'State Farm' },
  ...extra,
});
// The Freedom -> Condition One send of 2026-11-06 (read-only production facts): two legs, both submitted.
const FREEDOM_LEGS = [leg('w'), leg('b', { leg_role: 'send_bank', amount_cents: 190180 })];

test('sender: a send leg counts once Moov accepted it (the server\'s ACCEPTED set); payroll legs are left to payroll_runs', () => {
  assert.match(send, /const ACCEPTED = new Set\(\['submitted', 'pending', 'processing', 'completed'\]\);/);
  assert.deepEqual([...ACCEPTED_SEND_STATUSES].sort(), ['completed', 'pending', 'processing', 'submitted']);
  for (const status of ['ready', 'submitting', 'unknown', 'failed', 'canceled', 'returned']) assert.equal(isPaidSendLeg(leg('x', { status })), false, status);
  assert.equal(isPaidSendLeg(leg('x', { leg_role: 'wallet_funding' })), false);
  assert.equal(isPaidSendLeg(leg('x', { provider_metadata: { purpose: 'payroll' } })), false);
  // The send server tags payroll legs exactly so.
  assert.match(send, /\.\.\.\(payroll \? \{ purpose: 'payroll', payroll_run_id: payrollRunId \} : \{\}\)/);
});

test('sender: the wallet and bank legs of one recipient are one payment and one expense row; partial sends count', () => {
  const [p, ...rest] = sentPayments(FREEDOM_LEGS);
  assert.deepEqual(rest, []);
  assert.equal(p.amountCents, 830700);
  assert.equal(p.recipientName, 'Condition One Commrecial');
  assert.equal(p.recipientKind, 'partner');
  assert.equal(p.completed, false);
  assert.deepEqual(p.sources.sort(), ['balance', 'bank']);
  assert.deepEqual(sendExpenseTotal([...FREEDOM_LEGS, leg('f', { status: 'failed', provider_metadata: { request_hash: 'h2' } })]), { total: 8307, count: 1 });
  const [row] = sendExpenseRows(FREEDOM_LEGS);
  assert.deepEqual({ ...row, key: undefined }, {
    key: undefined, kind: 'send', at: '2026-11-06T19:06:02Z', title: 'Condition One Commrecial',
    subtitle: 'Payment sent to partner · from balance and bank', reference: 'Ck #1001', amount: 8307, status: 'Sent',
  });
  const done = sendExpenseRows([leg('w', { status: 'completed', completed_at: '2026-11-06T20:00:00Z' })])[0];
  assert.equal(done.status, 'Settled');
  // Two recipients of one send are two payments.
  assert.equal(sentPayments([leg('a'), leg('c', { provider_metadata: { request_hash: 'h1', recipient_index: 1, recipient_kind: 'stakeholder', recipient_id: 's1', recipient_name: 'Roofer' } })]).length, 2);
  const [ledger] = sendLedgerRows(FREEDOM_LEGS);
  assert.equal(ledger.source, 'send');
  assert.equal(ledger.status, 'settled');
  assert.equal(ledger.send_status, 'in_transit');
  assert.equal(ledger.recipient_type, 'partner');
  assert.equal(ledger.disbursement_batches.check_intake_items.check_number, '1001');
  assert.ok(ledger.id.startsWith('send:'));
  const [byRecipient] = sendRecipientReportRows(FREEDOM_LEGS);
  assert.deepEqual([byRecipient.name, byRecipient.type, byRecipient.amount, byRecipient.status, byRecipient.method], ['Condition One Commrecial', 'partner', 8307, 'settled', 'send']);
});

const incoming = (id, extra = {}) => ({
  id, amount_cents: 640520, status: 'submitted', environment: 'production', leg_role: 'send_wallet',
  created_at: '2026-11-06T19:06:01Z', submitted_at: '2026-11-06T19:06:02Z', completed_at: null,
  check_id: 'chk-1', sender_tenant_id: 'freedom', sender_name: 'Freedom Adjustment',
  check_number: '1001', carrier_name: 'State Farm', property_address: '1 Main St', funds_type: 'dwelling', check_amount: 9029.35,
  claim_id: 'cl-1', detected_claim_number: 'D-1', payee_line: 'Deen Bandhu & Freedom Adjustment', claim_number: 'CL-1', policyholder_name: 'Deen Bandhu',
  ...extra,
});
const C1_ROWS = [incoming('w'), incoming('b', { leg_role: 'send_bank', amount_cents: 190180 })];

test('recipient: the legs of one send are one incoming payment; income counts accepted legs, never returned ones', () => {
  const [p, ...rest] = incomingPayments(C1_ROWS);
  assert.deepEqual(rest, []);
  assert.equal(p.amountCents, 830700);
  assert.equal(p.senderName, 'Freedom Adjustment');
  assert.equal(p.status, 'in_transit');
  assert.equal(p.counted, true);
  assert.deepEqual(incomingRevenueTotal(C1_ROWS), { total: 8307, count: 1 });
  const returned = incoming('r', { status: 'returned', amount_cents: 5000, created_at: '2026-11-05T10:00:00Z' });
  const ignored = ['ready', 'failed', 'canceled', 'unknown'].map((status, i) => incoming(`x${i}`, { status, created_at: `2026-11-0${i + 1}T00:00:00Z` }));
  assert.deepEqual(incomingRevenueTotal([...C1_ROWS, returned, ...ignored]), { total: 8307, count: 1 });
  const rows = incomingRevenueRows([...C1_ROWS, returned]);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], key: undefined }, {
    key: undefined, at: '2026-11-06T19:06:02Z', title: 'Freedom Adjustment', subtitle: 'Partner payment · State Farm', reference: '1001', amount: 8307, status: 'In transit',
  });
  assert.equal(incomingRevenueRows([incoming('d', { status: 'completed', completed_at: '2026-11-06T21:00:00Z' })])[0].status, 'Received');
  // Payment History: received rows, the returned one shown but not counted.
  const ledger = incomingLedgerRows([...C1_ROWS, returned]);
  assert.deepEqual(ledger.map((r) => [r.status, r.counted, r.amount]), [['in_transit', true, 8307], ['returned', false, 50]]);
  assert.deepEqual(incomingBySender([...C1_ROWS, returned]), [{ name: 'Freedom Adjustment', total: 8307, count: 1, last: '2026-11-06T19:06:02Z' }]);
  assert.deepEqual(incomingBySender(C1_ROWS, () => false), []);
});

test('recipient: Recent Wallet Activity credits "From <sender>", pending until completed, returned as returned, this environment only', () => {
  const rows = incomingWalletActivity([
    ...C1_ROWS,
    incoming('d', { status: 'completed', completed_at: '2026-11-06T21:00:00Z', created_at: '2026-11-06T20:59:00Z', amount_cents: 100 }),
    incoming('r', { status: 'returned', created_at: '2026-11-04T10:00:00Z', amount_cents: 5000 }),
    incoming('s', { environment: 'sandbox', created_at: '2026-11-03T10:00:00Z' }),
  ], { environment: 'production' });
  assert.deepEqual(rows.map((r) => [r.title, r.status, r.amountCents]), [
    ['From Freedom Adjustment', 'completed', 100],
    ['From Freedom Adjustment', 'pending', 830700],
    ['From Freedom Adjustment', 'returned', 5000],
  ]);
  assert.equal(rows[1].subtitle, 'Partner payment · Check 1001');
});

test('recipient: Funds Received lane rows open the check only when its context came back (a shared check)', () => {
  const [shared] = incomingFundsReceivedRows(C1_ROWS);
  assert.equal(shared.amount, 8307);
  assert.equal(shared.sender.name, 'Freedom Adjustment');
  assert.equal(shared._incomingStatus, 'in_transit');
  assert.equal(shared.settled_at, null);
  assert.equal(shared.disbursement_batches.check_intake_item_id, 'chk-1');
  assert.equal(shared.disbursement_batches.check_intake_items.check_number, '1001');
  assert.equal(shared.disbursement_batches.check_intake_items.claims.policyholder_name, 'Deen Bandhu');
  const unshared = incomingFundsReceivedRows([incoming('u', { check_number: null, carrier_name: null, property_address: null })])[0];
  assert.equal(unshared.disbursement_batches.check_intake_item_id, null);
});

test('the read degrades to no rows while SQL 144 or its API is not live', async () => {
  assert.equal(INCOMING_TRANSFERS_RPC, 'get_tenant_incoming_transfers');
  const calls = [];
  const client = (reply) => ({ rpc: async (name, args) => { calls.push([name, args]); if (reply instanceof Error) throw reply; return reply; } });
  assert.deepEqual(await fetchIncomingTransfers(client({ data: null, error: { code: '403', message: 'rpc_disabled' } }), 't1'), []);
  assert.deepEqual(await fetchIncomingTransfers(client(new Error('network')), 't1'), []);
  assert.deepEqual(await fetchIncomingTransfers(client({ data: { not: 'an array' }, error: null }), 't1'), []);
  assert.deepEqual(await fetchIncomingTransfers(client({ data: C1_ROWS, error: null }), 't1'), C1_ROWS);
  assert.deepEqual(calls[0], ['get_tenant_incoming_transfers', { _tenant_id: 't1' }]);
});

test('wiring: Revenue & Profit, Payment History, By Recipient, WalletOps and Funds Received read them; Tax & 1099 does not', () => {
  const revenue = read('src/components/ledger/RevenueSummary.tsx');
  assert.match(revenue, /\.\.\.incomingRevenueRows\(incomingTransfers\)/);
  assert.match(revenue, /const totalIncoming = checkIncoming \+ invoiceIncoming \+ partnerIncoming;/);
  assert.match(revenue, /const totalOutgoing = disbursementOutgoing \+ payroll\.total \+ speedFees\.total \+ sends\.total;/);
  assert.match(revenue, /\.\.\.sendExpenseRows\(sentLegs\)/);
  const ledger = read('src/components/ledger/PaymentLedger.tsx');
  assert.match(ledger, /\.\.\.inRange\(sendLedgerRows\(sentLegs\), \(r\) => r\.created_at, dateFilters\)/);
  assert.match(ledger, /if \(id\.startsWith\("send:"\)\) return;/);
  assert.match(ledger, /Payments received/);
  const report = read('src/components/ledger/RecipientReport.tsx');
  assert.match(report, /\.\.\.payrollRecipientReportRows\(payrollRuns\), \.\.\.sendRows\]/);
  assert.match(report, /Received from/);
  assert.match(report, /r\.count - \(r\.payrollCount \?\? 0\) - \(r\.sendCount \?\? 0\) > 0/);
  const wallet = read('src/hooks/useWalletOps.ts');
  assert.match(wallet, /const incomingActivity = incomingWalletActivity\(incomingRows, \{ environment: walletEnvironment \}\);/);
  assert.match(read('src/pages/WalletOps.tsx'), /kind: "incoming" as const,\n\s+credit: true,/);
  const page = read('src/pages/CheckCommandCenter.tsx');
  assert.match(page, /\[\.\.\.\(fundsReceived as any\[\]\), \.\.\.incomingFundsReceivedRows\(incomingTransfers\)\]\.filter\(matchesSplitSearch\)/);
  // Partner payments are income, never 1099 / tax payments; sends are not added to Tax & 1099 either.
  const tax = read('src/components/ledger/TaxSummary.tsx');
  assert.doesNotMatch(tax, /transferFinanceRows|useTransferFinance|get_tenant_incoming_transfers|payment_transfers/);
});
