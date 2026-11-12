/**
 * Owner request 2026-11-06: "Once funds are disbursed once from a check, the check should move to
 * funds released for the disburser ... Tenants should still be able to send money from that check
 * always." A send writes payment_transfers legs (send_wallet / send_bank, check_id) and no
 * disbursement split, and leaves check_stage at deposited, so the check stayed in Deposited.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DISBURSED_SEND_STATUSES,
  SEND_LEG_ROLES,
  disbursedCheckIds,
  isDisbursedSendLeg,
  sentReleasedRows,
  sentStillDeposited,
} from '../../src/features/check-command/sentFundsReleased.ts';

const page = readFileSync(new URL('../../src/pages/CheckCommandCenter.tsx', import.meta.url), 'utf8');
const send = readFileSync(new URL('../functions/api/providers/production/moov-send.mjs', import.meta.url), 'utf8');

const leg = (extra = {}) => ({
  id: 'l1', check_id: 'c1', leg_role: 'send_wallet', status: 'submitted', amount_cents: 50000,
  created_at: '2026-11-05T10:00:00Z', submitted_at: '2026-11-05T10:00:05Z', completed_at: null,
  destination_tenant_id: 'T-C1',
  provider_metadata: { recipient_kind: 'partner', recipient_id: 't-c1', recipient_name: 'Condition One' },
  ...extra,
});

test('1 disbursed = a send leg for a check that Moov accepted; drafts, unknown and failed legs are not', () => {
  assert.deepEqual([...SEND_LEG_ROLES], ['send_wallet', 'send_bank']);
  // The same accepted set the send server uses.
  assert.match(send, /const ACCEPTED = new Set\(\['submitted', 'pending', 'processing', 'completed'\]\);/);
  assert.deepEqual([...DISBURSED_SEND_STATUSES].sort(), ['completed', 'pending', 'processing', 'submitted']);
  for (const status of ['submitted', 'pending', 'processing', 'completed']) {
    assert.equal(isDisbursedSendLeg(leg({ status })), true, status);
  }
  for (const status of ['ready', 'submitting', 'unknown', 'failed', 'canceled', 'returned']) {
    assert.equal(isDisbursedSendLeg(leg({ status })), false, status);
  }
  assert.equal(isDisbursedSendLeg(leg({ leg_role: 'wallet_funding' })), false);
  assert.equal(isDisbursedSendLeg(leg({ check_id: null })), false);
  assert.deepEqual([...disbursedCheckIds([leg(), leg({ check_id: 'c2', status: 'failed' })])], ['c1']);
});

test('2 one row per check and recipient: wallet and bank legs add up, partial sends count, failed legs do not', () => {
  const check = { id: 'c1', check_number: '1001', amount: 2000, check_stage: 'deposited' };
  const rows = sentReleasedRows([
    leg(),
    leg({ id: 'l2', leg_role: 'send_bank', amount_cents: 25000, status: 'completed', completed_at: '2026-11-06T09:00:00Z' }),
    leg({ id: 'l3', amount_cents: 99900, status: 'failed' }),
    leg({ id: 'l4', destination_tenant_id: null, amount_cents: 10000, status: 'completed', completed_at: '2026-11-04T09:00:00Z',
      provider_metadata: { recipient_kind: 'stakeholder', recipient_id: 'S1', recipient_name: 'Roofer LLC' } }),
  ], [check]);
  assert.equal(rows.length, 2);
  const [partner, stakeholder] = rows;
  assert.equal(partner.amount, 750);
  assert.equal(partner.recipient_name, 'Condition One');
  assert.equal(partner._sendStatus, 'in_transit');
  assert.equal(partner.settled_at, null);
  assert.equal(partner._sentAt, '2026-11-06T09:00:00Z');
  assert.equal(partner.disbursement_batches.check_intake_item_id, 'c1');
  assert.equal(partner.disbursement_batches.check_intake_items, check);
  assert.equal(stakeholder.amount, 100);
  assert.equal(stakeholder._sendStatus, 'completed');
  assert.equal(stakeholder.settled_at, '2026-11-04T09:00:00Z');
  // A check missing from the loaded details still gets a row.
  assert.deepEqual(sentReleasedRows([leg({ check_id: 'zz' })])[0].disbursement_batches.check_intake_items, { id: 'zz' });
  assert.deepEqual(sentReleasedRows([leg({ status: 'ready' })]), []);
});

test('3 the Deposited badge leaves out sent checks the server still counts as deposited', () => {
  const ids = new Set(['a', 'b']);
  assert.deepEqual(
    sentStillDeposited([
      { id: 'a', check_stage: 'deposited', amount: 100 },
      { id: 'b', check_stage: 'funds_released', amount: 50 },
      { id: 'c', check_stage: 'deposited', amount: 7 },
    ], ids),
    { count: 1, total: 100 },
  );
});

test('4 Check Command Center: sent checks move from Deposited to Funds Released', () => {
  assert.match(page, /\.from\("payment_transfers"\)[\s\S]{0,300}\.eq\("tenant_id", tenantId!\)\s*\.in\("leg_role", \[\.\.\.SEND_LEG_ROLES\]\)\s*\.in\("status", \[\.\.\.DISBURSED_SEND_STATUSES\]\)/);
  assert.match(page, /if \(sentCheckIds\.has\(c\.id\)\) return false;/);
  assert.match(page, /!sentCheckIds\.has\(c\.id\) && matchesSearch\(c\)/);
  assert.match(page, /\[\.\.\.\(fundsReleased as any\[\]\), \.\.\.sentReleased\]\.filter\(matchesSplitSearch\)/);
  assert.match(page, /server - sentDeposited\.count/);
  assert.match(page, /queryKey: \["funds-released-sends", tenantId\] \}\);/);
});

test('5 Send stays available after the check moves to Funds Released', () => {
  assert.match(page, /const isDeposited = stage === "deposited" \|\| status === "deposited"\s*\|\| stage === "funds_released" \|\| stage === "disbursed_externally";/);
  assert.match(page, /payoutEnabled=\{isDeposited\}/);
  // The send server gates on the check's owner only, never on its stage.
  assert.match(send, /if \(!check \|\| String\(check\.tenant_id\) !== String\(tenantId\)\) return fail\('check_not_found'/);
  assert.doesNotMatch(send, /check_stage/);
});
