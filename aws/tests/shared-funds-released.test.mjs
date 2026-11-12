/**
 * Owner report 2026-11-04: checks Freedom shares with Condition One got "stuck" on Condition One's
 * side once Freedom released the funds (read-only production comparison: 45 shared checks at
 * check_stage funds_released, none with a payout of Condition One's). Deposited drops a check at
 * that stage and Funds Released lists only the viewer's own splits, so the check left every tab.
 *
 * Owner reports 2026-11-12: listing those checks under Condition One's Funds Released was wrong
 * (Condition One sent no money through ChecksOps, so the tab must show zero), the names on the
 * tab kept changing places, and "All of the checks that were in their funds released should have
 * been funds received since they received funds". A shared check the partner released is listed
 * under the viewer's Funds Received: by the recorded payment when there is one, otherwise by a
 * row built from the check that adds nothing to the totals. It is in neither Funds Released nor
 * Deposited, and the claim groups are ordered by the rows alone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  RELEASED_STAGES,
  isSharedReleased,
  receivedAmount,
  sharedReleasedReceivedRows,
} from '../../src/features/check-command/sharedFundsReleased.ts';
import { groupSplitsByClaim, splitOrderDate } from '../../src/features/check-command/groupSplitsByClaim.ts';

const page = readFileSync(new URL('../../src/pages/CheckCommandCenter.tsx', import.meta.url), 'utf8');
const shared = (id, stage, extra = {}) => ({ id, amount: '1250.50', status: 'deposited', check_stage: stage,
  updated_at: '2026-11-03T10:00:00Z', created_at: '2026-10-20T09:00:00Z', _shared: true, _sourceTenantName: 'Freedom Adjustment', ...extra });

test('1 a shared check the source released becomes one Funds Received row built from the check', () => {
  assert.equal(isSharedReleased(shared('c1', 'funds_released')), true);
  assert.equal(isSharedReleased(shared('c2', 'disbursed_externally')), true);
  const [row, ...rest] = sharedReleasedReceivedRows([shared('c1', 'funds_released'), shared('c1', 'funds_released')]);
  assert.deepEqual(rest, []);
  assert.equal(row.id, 'shared-release-c1');
  assert.equal(row.amount, 1250.5);
  assert.equal(row.disbursement_batches.check_intake_item_id, 'c1');
  assert.equal(row.disbursement_batches.check_intake_items.id, 'c1');
  assert.equal(row._sharedReleasedBy, 'Freedom Adjustment');
  assert.deepEqual(row.sender, { name: 'Freedom Adjustment' });
  assert.equal(row.settled_at, null);
  assert.equal(row.updated_at, '2026-11-03T10:00:00Z');
  assert.equal(sharedReleasedReceivedRows([shared('c2', 'disbursed_externally', { _sourceTenantName: null })])[0]._sharedReleasedBy, 'Partner');
});

test('2 only released shared checks without a recorded payment: other stages, own checks and covered checks add nothing', () => {
  const rows = sharedReleasedReceivedRows([
    shared('d', 'deposited'), shared('e', 'endorsing'), shared('r', 'review'),
    { ...shared('own', 'funds_released'), _shared: false },
    shared('paid', 'funds_released'), shared('sent', 'disbursed_externally'),
  ], [
    { disbursement_batches: { check_intake_item_id: 'paid' } },   // a recorded payout to the viewer
    { disbursement_batches: { check_intake_item_id: 'sent' } },   // an incoming transfer from the check
    { disbursement_batches: { check_intake_item_id: null } }, null,
  ]);
  assert.deepEqual(rows, []);
  assert.equal(isSharedReleased(null), false);
  assert.deepEqual([...RELEASED_STAGES].sort(), ['disbursed_externally', 'funds_released']);
});

test('3 a row built from the check adds nothing to the Funds Received totals; a recorded payment adds its amount', () => {
  const [built] = sharedReleasedReceivedRows([shared('c1', 'funds_released')]);
  assert.equal(receivedAmount(built), 0);
  assert.equal(receivedAmount({ amount: '300.25' }), 300.25);
  assert.equal(receivedAmount(null), 0);
  const resolveClaim = () => ({ claimNumber: 'C-1', policyholderName: null });
  const [group] = groupSplitsByClaim([built, { id: 'p', amount: 300.25, settled_at: '2026-11-01T00:00:00Z' }], resolveClaim);
  assert.equal(group.rows.length, 2);
  assert.equal(group.total, 300.25);
});

test('4 the page lists a partner release under Funds Received, and under neither Funds Released nor Deposited', () => {
  // Funds Released: only own splits and sends.
  assert.match(page, /\[\.\.\.\(fundsReleased as any\[\]\), \.\.\.sentReleased\]\.filter\(matchesSplitSearch\)/);
  assert.match(page, /\[fundsReleased, checkSends, matchesSplitSearch\]/);
  // Funds Received: recorded payments, incoming transfers, then the released shared checks they do not cover.
  assert.match(page, /const received = \[\.\.\.\(fundsReceived as any\[\]\), \.\.\.incomingFundsReceivedRows\(incomingTransfers\)\];/);
  assert.match(page, /sharedReleasedReceivedRows\(sharedChecks as any\[\], received\)/);
  assert.match(page, /return \[\.\.\.received, \.\.\.sharedReleased\]\.filter\(matchesSplitSearch\);/);
  assert.match(page, /\[fundsReceived, incomingTransfers, sharedChecks, matchesSplitSearch\]/);
  assert.match(page, /`Released by \$\{split\._sharedReleasedBy\}`/);
  assert.match(page, /getAmount=\{\(s: any\) => receivedAmount\(s\)\}\s*itemLabel="receipt"/);
  // Deposited drops every released check again, shared ones included.
  assert.match(page, /if \(stage === "funds_released" \|\| stage === "disbursed_externally"\) return false;/);
  assert.doesNotMatch(page, /sharedReleased\.ids|sharedReleased\.count|sharedReleased\.total|sharedReleasedLabel|sharedReleasedSummary/);
});

const row = (id, claim, extra = {}) => ({ id, amount: 10,
  disbursement_batches: { check_intake_items: { detected_claim_number: claim } }, ...extra });
const resolve = (check) => ({ claimNumber: check?.detected_claim_number ?? null, policyholderName: null });

test('5 the claim groups keep one order however often the list is rebuilt, dated or not', () => {
  // No row is dated "now": the page reads no clock when it orders the groups.
  assert.doesNotMatch(
    readFileSync(new URL('../../src/features/check-command/groupSplitsByClaim.ts', import.meta.url), 'utf8')
      .replace(/\/\*\*[\s\S]*?\*\//g, ''),
    /new Date\(\)|Date\.now\(\)/,
  );
  assert.match(page, /import \{ groupSplitsByClaim \} from "@\/features\/check-command\/groupSplitsByClaim";/);
  assert.doesNotMatch(page, /function groupSplitsByClaim/);

  const rows = [
    row('a', 'C-3'), row('b', 'C-1'), row('c', null), row('d', 'C-2'),            // undated
    row('e', 'C-9', { settled_at: '2026-11-01T00:00:00Z' }),
    row('f', 'C-8', { _sentAt: '2026-11-05T00:00:00Z', settled_at: null }),       // send in transit
    row('g', 'C-1', { settled_at: '2026-10-01T00:00:00Z' }),
  ];
  const keys = () => groupSplitsByClaim(rows, resolve).map((g) => g.key);
  const first = keys();
  assert.deepEqual(first, ['claim::c-8', 'claim::c-9', 'claim::c-1', 'claim::c-2', 'claim::c-3', 'unlinked::c']);
  for (let i = 0; i < 50; i += 1) assert.deepEqual(keys(), first);
  assert.deepEqual(groupSplitsByClaim([...rows].reverse(), resolve).map((g) => g.key), first);

  const c1 = groupSplitsByClaim(rows, resolve).find((g) => g.key === 'claim::c-1');
  assert.equal(c1.rows.length, 2);
  assert.equal(c1.total, 20);
  assert.equal(c1.latest, '2026-10-01T00:00:00Z');
  assert.equal(splitOrderDate(row('z', null)), '');
  assert.equal(splitOrderDate({ settled_at: null, updated_at: '2026-11-02T00:00:00Z' }), '2026-11-02T00:00:00Z');
});
