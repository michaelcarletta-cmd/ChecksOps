import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bankDepositDayInRange } from '../../src/lib/bankDepositGroups.ts';

test('Bank Deposits date search: no dates, one date, a range in either order, an end date alone', () => {
  const days = ['2026-10-20', '2026-10-22', '2026-10-24', '2026-10-26', 'unknown'];
  const pick = (from, to) => days.filter((d) => bankDepositDayInRange(d, from, to));
  // No dates: every day, the unknown day included.
  assert.deepEqual(pick('', ''), days);
  // One date: exactly that day.
  assert.deepEqual(pick('2026-10-22', ''), ['2026-10-22']);
  assert.deepEqual(pick('2026-10-21', ''), []);
  // A range is inclusive and order does not matter.
  assert.deepEqual(pick('2026-10-22', '2026-10-24'), ['2026-10-22', '2026-10-24']);
  assert.deepEqual(pick('2026-10-24', '2026-10-22'), ['2026-10-22', '2026-10-24']);
  assert.deepEqual(pick('2026-10-21', '2026-10-25'), ['2026-10-22', '2026-10-24']);
  // An end date alone: everything up to it.
  assert.deepEqual(pick('', '2026-10-22'), ['2026-10-20', '2026-10-22']);
  // Whitespace is ignored.
  assert.deepEqual(pick(' 2026-10-26 ', ''), ['2026-10-26']);
});
