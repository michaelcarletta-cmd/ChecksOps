/**
 * Owner report 2026-11-04: checks Freedom shares with Condition One got "stuck" on Condition One's
 * side once Freedom released the funds (read-only production comparison: 45 shared checks at
 * check_stage funds_released, none with a payout of Condition One's). Deposited drops a check at
 * that stage and Funds Released lists only the viewer's own splits, so the check left every tab.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sharedReleasedRows, RELEASED_STAGES } from '../../src/features/check-command/sharedFundsReleased.ts';

const page = readFileSync(new URL('../../src/pages/CheckCommandCenter.tsx', import.meta.url), 'utf8');
const shared = (id, stage, extra = {}) => ({ id, amount: '1250.50', status: 'deposited', check_stage: stage,
  updated_at: '2026-11-03T10:00:00Z', _shared: true, _sourceTenantName: 'Freedom Adjustment', ...extra });

test('1 a shared check the source released becomes a Funds Released row from the check itself', () => {
  const [row, ...rest] = sharedReleasedRows([shared('c1', 'funds_released')]);
  assert.deepEqual(rest, []);
  assert.equal(row.id, 'shared-release-c1');
  assert.equal(row.amount, 1250.5);
  assert.equal(row.disbursement_batches.check_intake_item_id, 'c1');
  assert.equal(row.disbursement_batches.check_intake_items.id, 'c1');
  assert.equal(row._sharedReleasedBy, 'Freedom Adjustment');
  assert.equal(row.settled_at, null);
  assert.equal(row.updated_at, '2026-11-03T10:00:00Z');
  assert.equal(sharedReleasedRows([shared('c2', 'disbursed_externally')]).length, 1);
});

test('2 only released shared checks: other stages, own checks, and checks already covered by own splits add nothing', () => {
  const rows = sharedReleasedRows([
    shared('d', 'deposited'), shared('e', 'endorsing'), shared('r', 'review'),
    { ...shared('own', 'funds_released'), _shared: false },
    shared('covered', 'funds_released'),
  ], [{ disbursement_batches: { check_intake_item_id: 'covered' } }]);
  assert.deepEqual(rows, []);
  assert.deepEqual([...RELEASED_STAGES].sort(), ['disbursed_externally', 'funds_released']);
});

test('3 the Funds Released tab lists own splits plus released shared checks, and labels them as released by the partner', () => {
  assert.match(page, /sharedReleasedRows\(sharedChecks as any\[\], fundsReleased as any\[\]\)/);
  assert.match(page, /\[\.\.\.\(fundsReleased as any\[\]\), \.\.\.sharedReleased\]\.filter\(matchesSplitSearch\)/);
  assert.match(page, /\[fundsReleased, sharedChecks, matchesSplitSearch\]/);
  assert.match(page, /`Released by \$\{split\._sharedReleasedBy\}`/);
  // The Deposited tab still drops released checks (they now belong to Funds Released).
  assert.match(page, /if \(stage === "funds_released" \|\| stage === "disbursed_externally"\) return false;/);
});
