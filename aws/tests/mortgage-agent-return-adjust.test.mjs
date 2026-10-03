import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WRITE_ACTIONS,
  isCompensationAdmin,
  runMortgageAgentCompensation,
} from '../functions/api/mortgage-agent-compensation.mjs';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const REQ = '00000000-0000-4000-8000-000000000021';
const ENTRY = '00000000-0000-4000-8000-0000000000e1';

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

const ownerClient = (extra = []) => sqlClient([
  {
    match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'),
    result: () => ({ rows: [{ is_master: true, is_platform: true }] }),
  },
  {
    match: (sql) => sql.includes('FROM public.user_roles'),
    result: () => ({ rows: [{ role: 'admin' }] }),
  },
  ...extra,
]);

test('return_to_queue and adjust are write actions and agents stay unauthorized', () => {
  assert.deepEqual(WRITE_ACTIONS, ['approve', 'mark_paid', 'set_status', 'return_to_queue', 'adjust']);
  assert.equal(isCompensationAdmin({}, ['mortgage_agent']), false);
});

test('mortgage agent cannot return or adjust', async () => {
  const client = sqlClient([
    {
      match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'),
      result: () => ({ rows: [{ is_master: false, is_platform: false }] }),
    },
    {
      match: (sql) => sql.includes('FROM public.user_roles'),
      result: () => ({ rows: [{ role: 'mortgage_agent' }] }),
    },
  ]);
  const returned = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: AGENT },
    body: { action: 'return_to_queue', request_id: REQ, reason: 'reassign' },
    spoof: {},
  });
  const adjusted = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: AGENT },
    body: { action: 'adjust', parent_entry_id: ENTRY, amount_cents: 100, reason: 'bonus' },
    spoof: {},
  });
  assert.equal(returned.statusCode, 403);
  assert.equal(adjusted.statusCode, 403);
});

test('owner return_to_queue and adjust call the SQL 48/49 RPCs', async () => {
  const seen = [];
  const client = ownerClient([
    {
      match: (sql) => sql.includes('return_mortgage_handling_request_to_queue')
        || sql.includes('adjust_mortgage_agent_compensation'),
      result: (_params, sql) => {
        seen.push(sql);
        return {
          rows: sql.includes('return_mortgage')
            ? [{ id: REQ, status: 'requested', accepted_at: '2026-10-03T00:00:00Z' }]
            : [{ adjustment: { paired: true } }],
        };
      },
    },
  ]);
  const returned = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: OWNER },
    body: { action: 'return_to_queue', request_id: REQ, reason: 'Agent A unavailable' },
    spoof: {},
  });
  const adjusted = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: OWNER },
    body: {
      action: 'adjust',
      parent_entry_id: ENTRY,
      amount_cents: -1000,
      reason: 'wrong agent',
      counterparty_agent_id: '00000000-0000-4000-8000-0000000000a2',
    },
    spoof: {},
  });
  assert.equal(returned.ok, true);
  assert.equal(returned.request.status, 'requested');
  assert.equal(adjusted.ok, true);
  assert.match(seen[0], /return_mortgage_handling_request_to_queue/);
  assert.match(seen[1], /adjust_mortgage_agent_compensation/);
  assert.doesNotMatch(seen.join('\n'), /moov_|stripe_|ach_/i);
});

test('monthly file counts stay on roots while money includes children', async () => {
  let monthlySql = '';
  const client = ownerClient([
    {
      match: (sql) => sql.includes('FROM public.mortgage_agent_compensation_entries') && sql.includes('pay_period'),
      result: (_params, sql) => {
        monthlySql = sql;
        return {
          rows: [{
            agent_user_id: AGENT,
            initial_count: 1,
            additional_count: 0,
            files_worked: 1,
            gross_owed_cents: 500,
            paid_cents: 0,
            balance_cents: 500,
          }],
        };
      },
    },
  ]);
  const result = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: OWNER },
    body: { action: 'monthly', period: '2026-10' },
    spoof: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.totals.files_worked, 1);
  assert.equal(result.totals.gross_owed_cents, 500);
  assert.match(monthlySql, /parent_entry_id IS NULL AND e\.classification = 'initial'/);
  assert.match(monthlySql, /count\(\*\) FILTER \(WHERE e\.parent_entry_id IS NULL\)/);
  assert.match(monthlySql, /coalesce\(sum\(e\.amount_cents\), 0\)/);
  assert.doesNotMatch(monthlySql, /AND e\.parent_entry_id IS NULL\s+AND e\.status NOT IN/);
});
