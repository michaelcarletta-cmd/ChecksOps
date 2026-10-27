/**
 * Other users' changes (owner item 9 follow-up, 2026-10-27): src/lib/liveCursor.ts polls a small
 * change cursor (newest timestamp and row count of a few key tables) while the tab is visible and
 * refreshes the screen only when it moves; src/hooks/useRemoteChangeCursor.ts wires it in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CURSOR_TABLES, createCursorPoller, cursorFingerprint } from '../../src/lib/liveCursor.ts';
import { QUIET_TABLES } from '../../src/lib/liveUpdates.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => [...timers.values()],
    async fire() {
      const [id, t] = [...timers.entries()][0];
      timers.delete(id);
      t.fn();
      await flush();
    },
  };
}

const reading = (count, latest) => Object.fromEntries(CURSOR_TABLES.map(({ table }) => [table, { count, latest }]));

function setup({ readings, visible = () => true, random = () => 0.5 } = {}) {
  const timers = fakeTimers();
  let i = 0;
  let reads = 0;
  let changes = 0;
  const poller = createCursorPoller({
    read: async () => {
      reads += 1;
      const r = readings[Math.min(i, readings.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
    onChange: () => { changes += 1; },
    isVisible: visible,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random,
  });
  return { poller, timers, counts: () => ({ reads, changes }) };
}

test('the first round only records the baseline; a moved timestamp or count calls onChange once', async () => {
  const { poller, timers, counts } = setup({ readings: [reading(5, 'a'), reading(5, 'a'), reading(5, 'b'), reading(4, 'b')] });
  poller.start();
  await flush();
  assert.deepEqual(counts(), { reads: 1, changes: 0 });
  await timers.fire();
  assert.deepEqual(counts(), { reads: 2, changes: 0 });
  await timers.fire();
  assert.deepEqual(counts(), { reads: 3, changes: 1 });
  // A delete: the newest timestamp is the same, the count is not.
  await timers.fire();
  assert.deepEqual(counts(), { reads: 4, changes: 2 });
  poller.stop();
  assert.equal(timers.pending().length, 0);
});

test('an unchanged cursor backs off 10s, 15s, 22.5s, then stays at 30s; a change resets it; jitter stays within 20%', async () => {
  const same = reading(1, 'x');
  const { poller, timers } = setup({ readings: [same, same, same, same, same, reading(2, 'y')] });
  poller.start();
  await flush();
  const waits = [];
  for (let k = 0; k < 5; k += 1) {
    waits.push(timers.pending()[0].ms);
    await timers.fire();
  }
  assert.deepEqual(waits, [15_000, 22_500, 30_000, 30_000, 30_000]);
  assert.equal(timers.pending()[0].ms, 10_000);
  poller.stop();
  for (const [random, want] of [[0, 0.8], [1, 1.2]]) {
    const { poller: p, timers: t } = setup({ readings: [same], random: () => random });
    p.start();
    await flush();
    assert.equal(t.pending()[0].ms, Math.round(15_000 * want));
    p.stop();
  }
});

test('a hidden tab schedules nothing; poke reads at once; reads never overlap', async () => {
  let visible = false;
  const { poller, timers, counts } = setup({ readings: [reading(1, 'a'), reading(1, 'a'), reading(2, 'b')], visible: () => visible });
  poller.start();
  await flush();
  assert.equal(timers.pending().length, 0);
  visible = true;
  poller.poke();
  poller.poke();
  await flush();
  await flush();
  // The second poke waited for the first read and then ran (the cursor moved on it).
  assert.equal(counts().reads, 3);
  assert.equal(counts().changes, 1);
  assert.equal(timers.pending().length, 1);
  poller.stop();
});

test('this tab\'s own write rebases the cursor without a second refresh', async () => {
  const { poller, timers, counts } = setup({ readings: [reading(1, 'a'), reading(2, 'b'), reading(2, 'b')] });
  poller.start();
  await flush();
  poller.rebase();
  await flush();
  assert.deepEqual(counts(), { reads: 2, changes: 0 });
  await timers.fire();
  assert.deepEqual(counts(), { reads: 3, changes: 0 });
  poller.stop();
});

test('a failed table keeps its previous value (no false change); all failing backs off to the maximum and never throws', async () => {
  const base = reading(3, 't');
  const oneFailed = { ...base, [CURSOR_TABLES[0].table]: 'error' };
  const { poller, timers, counts } = setup({ readings: [base, oneFailed, new Error('network'), base] });
  poller.start();
  await flush();
  await timers.fire();
  assert.equal(counts().changes, 0);
  await timers.fire();
  assert.equal(counts().changes, 0);
  assert.equal(timers.pending()[0].ms, 30_000);
  await timers.fire();
  assert.equal(counts().changes, 0);
  poller.stop();
  const fp = cursorFingerprint({ a: 'error', b: { count: 1, latest: 'z' } }, { a: { count: 9, latest: 'q' } });
  assert.equal(fp.key, 'a:9:q|b:1:z');
});

test('wiring: the cursor reads only a timestamp column of allowed, non-quiet tables, signed in and on the AWS adapter, mounted inside AuthProvider', () => {
  const allowed = JSON.parse(read('aws/functions/api/allowed-tables.json'));
  for (const { table, column } of CURSOR_TABLES) {
    assert.ok(JSON.stringify(allowed).includes(`"${table}"`), table);
    assert.ok(!QUIET_TABLES.has(table), table);
    assert.match(column, /^(updated_at|created_at)$/, table);
  }
  const hook = read('src/hooks/useRemoteChangeCursor.ts');
  assert.match(hook, /\.select\(column, \{ count: "exact" \}\)/);
  assert.match(hook, /\.order\(column, \{ ascending: false \}\)\s*\.limit\(1\)/);
  assert.match(hook, /if \(!signedIn \|\| !\(isAwsStaging\(\) \|\| import\.meta\.env\.MODE === "aws"\)\) return;/);
  assert.match(hook, /onDataChange\(\(\) => poller\.rebase\(\)\)/);
  assert.match(hook, /invalidateQueries\(\{ refetchType: "active" \}, \{ cancelRefetch: false \}\)/);
  const app = read('src/App.tsx');
  assert.match(app, /<AuthProvider>\s*<RemoteChangeCursor \/>/);
});
