import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createRefreshScheduler,
  emitDataChange,
  functionSignals,
  onDataChange,
  rpcSignals,
  tableWriteSignals,
  withDataChangeSignals,
} from '../../src/lib/liveUpdates.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// A stand-in for the AWS adapter: chainable builder whose methods return itself, thenable.
function fakeClient({ error = null } = {}) {
  const calls = [];
  const builderFor = (table) => {
    const b = {
      select() { return b; },
      insert() { calls.push(['insert', table]); return b; },
      update() { calls.push(['update', table]); return b; },
      upsert() { calls.push(['upsert', table]); return b; },
      delete() { calls.push(['delete', table]); return b; },
      eq() { return b; },
      single() { return b; },
      then(resolve, reject) {
        return Promise.resolve({ data: [], error, count: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return {
    calls,
    auth: { marker: 'auth' },
    from: builderFor,
    rpc: async (name) => ({ data: name, error }),
    functions: { invoke: async (name) => ({ data: name, error }) },
  };
}

const collect = () => {
  const seen = [];
  return { seen, notify: (c) => seen.push(`${c.source}:${c.name}`) };
};

test('successful table writes signal; reads, failures and quiet tables do not', async () => {
  const { seen, notify } = collect();
  const client = withDataChangeSignals(fakeClient(), notify);
  await client.from('check_intake_items').select('id').eq('id', 'x');
  await client.from('check_intake_items').update({ status: 'deposited' }).eq('id', 'x').select().single();
  await client.from('check_files').insert({ id: 'f' });
  await client.from('check_payees').delete().eq('id', 'p');
  await client.from('check_message_reads').upsert({ id: 'r' });
  await client.from('audit_logs').insert({ id: 'a' });
  assert.deepEqual(seen, ['table:check_intake_items', 'table:check_files', 'table:check_payees']);

  const failed = collect();
  const failing = withDataChangeSignals(fakeClient({ error: { message: 'writes_disabled' } }), failed.notify);
  const res = await failing.from('check_intake_items').update({}).eq('id', 'x');
  assert.equal(res.error.message, 'writes_disabled');
  assert.deepEqual(failed.seen, []);
});

test('the wrapper keeps the rest of the client and the result untouched', async () => {
  const { notify } = collect();
  const raw = fakeClient();
  const client = withDataChangeSignals(raw, notify);
  assert.equal(client.auth, raw.auth);
  const res = await client.from('check_intake_items').insert({ id: 'n' }).select();
  assert.deepEqual(res, { data: [], error: null, count: null });
  assert.deepEqual(raw.calls, [['insert', 'check_intake_items']]);
});

test('mutating RPCs and action functions signal; reads and bookkeeping do not', async () => {
  const { seen, notify } = collect();
  const client = withDataChangeSignals(fakeClient(), notify);
  for (const name of [
    'get_check_stage_totals',
    'is_approval_required',
    'has_permission',
    'list_partner_payout_options',
    'log_audit',
    'register_session',
    'contractor_verification_status',
    'deposit_action',
    'update_mortgage_handling_request_status',
    'admin_delete_check',
  ]) await client.rpc(name, {});
  await client.functions.invoke('get-check-image-urls', { body: {} });
  await client.functions.invoke('moov-readiness', { body: {} });
  await client.functions.invoke('homeowner-upload-check', { body: {} });
  assert.deepEqual(seen, [
    'rpc:deposit_action',
    'rpc:update_mortgage_handling_request_status',
    'rpc:admin_delete_check',
    'function:homeowner-upload-check',
  ]);
  assert.equal(rpcSignals('submit_check_review_decision_safe'), true);
  assert.equal(functionSignals('platform-announcements'), false);
  assert.equal(tableWriteSignals('check_intake_items', 'select'), false);
});

test('signals reach listeners until they unsubscribe', () => {
  const got = [];
  const off = onDataChange((c) => got.push(c.name));
  emitDataChange({ source: 'table', name: 'check_intake_items' });
  off();
  emitDataChange({ source: 'table', name: 'check_files' });
  assert.deepEqual(got, ['check_intake_items']);
});

// Manual clock for the scheduler.
function clock() {
  let t = 0;
  let timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = { fn, at: t + ms };
      timers.push(id);
      return id;
    },
    clearTimer: (id) => { timers = timers.filter((x) => x !== id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = due.at;
        due.fn();
      }
      t = end;
    },
  };
}

test('a burst of signals becomes one refresh', () => {
  const c = clock();
  let refreshes = 0;
  const s = createRefreshScheduler({ refresh: () => { refreshes += 1; }, ...c });
  s.signal(); s.signal(); s.signal();
  assert.equal(refreshes, 0);
  c.advance(150);
  assert.equal(refreshes, 1);
  s.signal();
  c.advance(150);
  assert.equal(refreshes, 2);
});

test('a signal loop is capped at the burst limit and resumes after the window', () => {
  const c = clock();
  let refreshes = 0;
  const s = createRefreshScheduler({
    refresh: () => { refreshes += 1; s.signal(); }, // every refresh signals again
    burstLimit: 6,
    burstWindowMs: 20_000,
    ...c,
  });
  s.signal();
  c.advance(19_000);
  assert.equal(refreshes, 6);
  // The oldest refresh (t=150) leaves the window at t=20150: one more refresh, then the cap again.
  c.advance(1_200);
  assert.equal(refreshes, 7);
  s.cancel();
  c.advance(60_000);
  assert.equal(refreshes, 7);
});

test('wiring: AWS client signals, App refreshes, queries refetch when stale, hidden tabs do not poll', () => {
  const client = read('src/integrations/supabase/client.ts');
  assert.match(client, /withDataChangeSignals\(createAwsStagingClient\(\), emitDataChange\)/);

  const app = read('src/App.tsx');
  assert.match(app, /<QueryClientProvider client=\{queryClient\}>\s+<LiveDataRefresh \/>/);
  assert.match(app, /refetchOnMount: true/);
  assert.match(app, /refetchOnWindowFocus: true/);

  const hook = read('src/hooks/useLiveDataRefresh.ts');
  assert.match(hook, /invalidateQueries\(\{ refetchType: "active" \}/);

  const polling = read('src/hooks/useAwsPollingFallback.ts');
  assert.match(polling, /document\.visibilityState === "hidden"\) return;/);
});
