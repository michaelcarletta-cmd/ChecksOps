// Mortgage Ops queue: no list is cut at one 500-row read (src/pages/mortgage-ops/MortgageOpsQueue.tsx used
// .limit(500) over all three statuses). Each list has its own server-side filter, is read page by page, and is
// checked against an exact count; a shortfall is shown, never silent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fetchQueueList,
  MORTGAGE_QUEUE_COMPLETED_STEP,
  MORTGAGE_QUEUE_PAGE_SIZE,
  queueCountLabel,
} from '../../src/lib/mortgageOpsQueuePaging.ts';
import { MAX_PAGE_LIMIT } from '../functions/api/data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGE = fs.readFileSync(path.join(ROOT, 'src/pages/mortgage-ops/MortgageOpsQueue.tsx'), 'utf8');

/** A fake server over `n` rows that honors range() and the 500-row clamp, counting on request. */
const server = (n, { failAt = -1, clamp = MAX_PAGE_LIMIT } = {}) => {
  const all = Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
  const calls = [];
  const fetchPage = async (from, to, withCount) => {
    calls.push([from, to, withCount]);
    if (calls.length - 1 === failAt) return { data: null, error: new Error('boom'), count: null };
    const end = Math.min(to + 1, from + clamp);
    return { data: all.slice(from, end), error: null, count: withCount ? n : null };
  };
  return { fetchPage, calls };
};

test('page size is the data API clamp; every row of a long list is read', async () => {
  assert.equal(MORTGAGE_QUEUE_PAGE_SIZE, MAX_PAGE_LIMIT);
  for (const n of [0, 1, 499, 500, 501, 1234, 5000]) {
    const { fetchPage, calls } = server(n);
    const out = await fetchQueueList(fetchPage);
    assert.equal(out.rows.length, n, `n=${n}`);
    assert.equal(out.total, n);
    assert.equal(out.incomplete, false);
    assert.equal(out.error, null);
    assert.deepEqual(calls[0], [0, 499, true]);
    assert.ok(calls.slice(1).every((c) => c[2] === false));
    assert.equal(new Set(out.rows.map((r) => r.id)).size, n);
  }
});

test('maxRows (completed, Load more) stops early and reports the rest; the page cap and errors are never silent', async () => {
  const done = await fetchQueueList(server(340).fetchPage, { maxRows: MORTGAGE_QUEUE_COMPLETED_STEP });
  assert.equal(done.rows.length, 100);
  assert.equal(done.total, 340);
  assert.equal(done.incomplete, true);
  assert.equal(queueCountLabel(done), '100 of 340');
  const capped = await fetchQueueList(server(2000).fetchPage, { maxPages: 2 });
  assert.equal(capped.rows.length, 1000);
  assert.equal(capped.incomplete, true);
  const failed = await fetchQueueList(server(1200, { failAt: 1 }).fetchPage);
  assert.equal(failed.rows.length, 500);
  assert.equal(failed.incomplete, true);
  assert.ok(failed.error);
  // A row that moves between pages is listed once; a skipped row shows up as incomplete against the count.
  const dup = await fetchQueueList(async (from) => ({ data: from === 0 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'b' }], error: null, count: 4 }), { pageSize: 2 });
  assert.deepEqual(dup.rows.map((r) => r.id), ['a', 'b']);
  assert.equal(dup.incomplete, true);
  assert.equal(queueCountLabel({ rows: [1, 2], total: 2 }), '2');
  assert.equal(queueCountLabel({ rows: [1, 2], total: null }), '2');
});

test('the queue reads three server-filtered lists through fetchQueueList, with no fixed 500-row limit', () => {
  assert.doesNotMatch(PAGE, /\.limit\(500\)/);
  assert.match(PAGE, /\{ count: "exact" \}/);
  assert.match(PAGE, /\.eq\("status", "requested"\)\.is\("assigned_employee_id", null\)\.order\("created_at", \{ ascending: true \}\)\.range\(from, to\)/);
  assert.match(PAGE, /\.eq\("status", "in_progress"\)\.eq\("assigned_employee_id", user\.id\)/);
  assert.match(PAGE, /\.eq\("status", "completed"\)\.eq\("assigned_employee_id", user\.id\)\.order\("completed_at", \{ ascending: false \}\)\.range\(from, to\)\), \{ maxRows: completedLimit \}/);
  assert.match(PAGE, /Load more/);
  assert.match(PAGE, /Refresh to load the rest\./);
});
