/**
 * Owner report 2026-11-04: checks Freedom shares with Condition One got "stuck" on Condition One's
 * side once Freedom released the funds (read-only production comparison: 45 shared checks at
 * check_stage funds_released, none with a payout of Condition One's). Deposited drops a check at
 * that stage and Funds Released lists only the viewer's own splits, so the check left every tab.
 *
 * Owner report 2026-11-12: listing those checks under Condition One's Funds Released was wrong
 * (Condition One sent no money through ChecksOps, so the tab must show zero), and the names on the
 * tab kept changing places. A shared check the partner released stays in Deposited, labelled
 * "Released by <partner>"; Funds Released holds only the viewer's own splits and sends; and the
 * claim groups are ordered by the rows alone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  RELEASED_STAGES,
  isSharedReleased,
  sharedReleasedLabel,
  sharedReleasedSummary,
} from '../../src/features/check-command/sharedFundsReleased.ts';
import { groupSplitsByClaim, splitOrderDate } from '../../src/features/check-command/groupSplitsByClaim.ts';

const page = readFileSync(new URL('../../src/pages/CheckCommandCenter.tsx', import.meta.url), 'utf8');
const shared = (id, stage, extra = {}) => ({ id, amount: '1250.50', status: 'deposited', check_stage: stage,
  updated_at: '2026-11-03T10:00:00Z', _shared: true, _sourceTenantName: 'Freedom Adjustment', ...extra });

test('1 a shared check the source released is recognised, counted once and labelled by its source', () => {
  assert.equal(isSharedReleased(shared('c1', 'funds_released')), true);
  assert.equal(isSharedReleased(shared('c2', 'disbursed_externally')), true);
  assert.equal(sharedReleasedLabel(shared('c1', 'funds_released')), 'Released by Freedom Adjustment');
  assert.equal(sharedReleasedLabel(shared('c1', 'funds_released', { _sourceTenantName: null })), 'Released by Partner');
  const summary = sharedReleasedSummary([
    shared('c1', 'funds_released'), shared('c1', 'funds_released'), shared('c2', 'disbursed_externally'),
  ]);
  assert.deepEqual([...summary.ids].sort(), ['c1', 'c2']);
  assert.equal(summary.count, 2);
  assert.equal(summary.total, 2501);
});

test('2 only released shared checks: other stages and own checks add nothing', () => {
  const summary = sharedReleasedSummary([
    shared('d', 'deposited'), shared('e', 'endorsing'), shared('r', 'review'),
    { ...shared('own', 'funds_released'), _shared: false },
  ]);
  assert.deepEqual([...summary.ids], []);
  assert.deepEqual({ count: summary.count, total: summary.total }, { count: 0, total: 0 });
  assert.equal(isSharedReleased(null), false);
  assert.deepEqual([...RELEASED_STAGES].sort(), ['disbursed_externally', 'funds_released']);
});

test('3 Funds Released lists only own splits and sends; a partner release stays in Deposited', () => {
  assert.match(page, /\[\.\.\.\(fundsReleased as any\[\]\), \.\.\.sentReleased\]\.filter\(matchesSplitSearch\)/);
  assert.match(page, /\[fundsReleased, checkSends, matchesSplitSearch\]/);
  assert.doesNotMatch(page, /sharedReleasedRows|_sharedReleasedBy/);
  // Deposited keeps the shared released check, ahead of the rule that drops released checks.
  assert.match(page, /if \(sharedReleased\.ids\.has\(c\.id\)\) return matchesSearch\(c\);[\s\S]{0,300}if \(stage === "funds_released" \|\| stage === "disbursed_externally"\) return false;/);
  // The server's Deposited total counts check_stage deposited only.
  assert.match(page, /server - sentDeposited\.count\) \+ sharedReleased\.count/);
  assert.match(page, /server - sentDeposited\.total\) \+ sharedReleased\.total/);
  assert.match(page, /activeTab === "deposited" && isSharedReleased\(check as any\) \? \([\s\S]{0,160}\{sharedReleasedLabel\(check as any\)\}/);
});

const row = (id, claim, extra = {}) => ({ id, amount: 10,
  disbursement_batches: { check_intake_items: { detected_claim_number: claim } }, ...extra });
const resolve = (check) => ({ claimNumber: check?.detected_claim_number ?? null, policyholderName: null });

test('4 the claim groups keep one order however often the list is rebuilt, dated or not', () => {
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
