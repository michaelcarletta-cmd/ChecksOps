import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isCompensationAdmin,
  runMortgageAgentCompensation,
} from '../functions/api/mortgage-agent-compensation.mjs';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const AGENT = '00000000-0000-4000-8000-0000000000a1';

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

test('compensation admin is platform owner only, not mortgage_agent', () => {
  assert.equal(isCompensationAdmin({ is_master: true }, ['mortgage_agent']), true);
  assert.equal(isCompensationAdmin({ is_platform: true }, []), true);
  assert.equal(isCompensationAdmin({}, ['admin']), true);
  assert.equal(isCompensationAdmin({}, ['mortgage_agent']), false);
  assert.equal(isCompensationAdmin({}, []), false);
});

test('mortgage agent cannot list or approve compensation', async () => {
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
  const denied = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: AGENT },
    body: { action: 'monthly', period: '2026-10' },
    spoof: {},
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.statusCode, 403);
  const approve = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: AGENT },
    body: { action: 'approve', entry_ids: ['00000000-0000-4000-8000-000000000001'] },
    spoof: {},
  });
  assert.equal(approve.statusCode, 403);
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

test('platform owner monthly totals stay bookkeeping-only', async () => {
  const seen = [];
  const client = ownerClient([
    {
      match: (sql) => sql.includes('FROM public.mortgage_agent_compensation_entries') && sql.includes('pay_period'),
      result: (_params, sql) => {
        seen.push(sql);
        return {
          rows: [{
            agent_user_id: AGENT,
            full_name: 'Agent A',
            email: 'a@example.com',
            initial_count: 1,
            additional_count: 1,
            files_worked: 2,
            gross_owed_cents: 1500,
            paid_cents: 0,
            balance_cents: 1500,
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
  assert.equal(result.totals.initial_count, 1);
  assert.equal(result.totals.additional_count, 1);
  assert.equal(result.totals.files_worked, 2);
  assert.equal(result.totals.gross_owed_cents, 1500);
  assert.equal(result.totals.paid_cents, 0);
  assert.equal(result.totals.balance_cents, 1500);
  assert.match(seen[0], /classification = 'initial'/);
  assert.match(seen[0], /classification = 'additional'/);
  assert.doesNotMatch(seen[0], /homeowner_name/);
});

test('entries return homeowner_name only for the matching compensation row', async () => {
  let entriesSql = '';
  const client = ownerClient([
    {
      match: (sql) => sql.includes('FROM public.mortgage_agent_compensation_entries e') && sql.includes('r.homeowner_name'),
      result: (_params, sql) => {
        entriesSql = sql;
        return {
          rows: [
            {
              id: '00000000-0000-4000-8000-0000000000e1',
              agent_user_id: AGENT,
              homeowner_name: 'Ada Lovelace',
              claim_number: 'CL-ADA',
              claim_id: '00000000-0000-4000-8000-0000000000c1',
              check_intake_item_id: '00000000-0000-4000-8000-000000000011',
              amount_cents: 1000,
              classification: 'initial',
              status: 'earned',
            },
            {
              id: '00000000-0000-4000-8000-0000000000e2',
              agent_user_id: AGENT,
              homeowner_name: 'Grace Hopper',
              claim_number: 'CL-GRACE',
              claim_id: '00000000-0000-4000-8000-0000000000c2',
              check_intake_item_id: '00000000-0000-4000-8000-000000000012',
              amount_cents: 500,
              classification: 'additional',
              status: 'earned',
            },
          ],
        };
      },
    },
  ]);
  const result = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: OWNER },
    body: { action: 'entries', period: '2026-10' },
    spoof: {},
  });
  assert.equal(result.ok, true);
  assert.match(entriesSql, /r\.homeowner_name/);
  assert.match(entriesSql, /LEFT JOIN public\.mortgage_handling_requests r ON r\.id = e\.mortgage_request_id/);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].homeowner_name, 'Ada Lovelace');
  assert.equal(result.entries[1].homeowner_name, 'Grace Hopper');
  assert.notEqual(result.entries[0].homeowner_name, result.entries[1].homeowner_name);
  assert.equal(result.entries[0].claim_number, 'CL-ADA');
  assert.equal(result.entries[1].claim_number, 'CL-GRACE');
});

test('approve and mark_paid stay bookkeeping RPC calls', async () => {
  const seen = [];
  const client = ownerClient([
    {
      match: (sql) => sql.includes('approve_mortgage_agent_compensation') || sql.includes('mark_mortgage_agent_compensation_paid'),
      result: (_params, sql) => {
        seen.push(sql);
        return { rows: [{ n: 2 }] };
      },
    },
  ]);
  const approved = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: OWNER },
    body: { action: 'approve', entry_ids: ['00000000-0000-4000-8000-0000000000e1'] },
    spoof: {},
  });
  const paid = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: OWNER },
    body: {
      action: 'mark_paid',
      entry_ids: ['00000000-0000-4000-8000-0000000000e1'],
      payment_date: '2026-10-03',
      payment_reference: 'CHK-15',
      note: 'bookkeeping only',
    },
    spoof: {},
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.updated, 2);
  assert.equal(paid.ok, true);
  assert.equal(paid.updated, 2);
  assert.match(seen[0], /approve_mortgage_agent_compensation/);
  assert.match(seen[1], /mark_mortgage_agent_compensation_paid/);
  assert.doesNotMatch(seen.join('\n'), /moov_|stripe_|ach_/i);
});
