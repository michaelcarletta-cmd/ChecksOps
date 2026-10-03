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

test('platform owner monthly totals stay bookkeeping-only', async () => {
  const client = sqlClient([
    {
      match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'),
      result: () => ({ rows: [{ is_master: true, is_platform: true }] }),
    },
    {
      match: (sql) => sql.includes('FROM public.user_roles'),
      result: () => ({ rows: [{ role: 'admin' }] }),
    },
    {
      match: (sql) => sql.includes('FROM public.mortgage_agent_compensation_entries') && sql.includes('pay_period'),
      result: () => ({
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
      }),
    },
  ]);
  const result = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: OWNER },
    body: { action: 'monthly', period: '2026-10' },
    spoof: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.totals.files_worked, 2);
  assert.equal(result.totals.gross_owed_cents, 1500);
  assert.equal(result.totals.balance_cents, 1500);
});

test('platform owner entries include homeowner, claim number, and payment bookkeeping', async () => {
  const client = sqlClient([
    {
      match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'),
      result: () => ({ rows: [{ is_master: true, is_platform: true }] }),
    },
    {
      match: (sql) => sql.includes('FROM public.user_roles'),
      result: () => ({ rows: [{ role: 'admin' }] }),
    },
    {
      match: (sql) => sql.includes('r.homeowner_name') && sql.includes('c.claim_number'),
      result: () => ({
        rows: [{
          id: '00000000-0000-4000-8000-0000000000e1',
          agent_user_id: AGENT,
          full_name: 'Agent A',
          email: 'a@example.com',
          homeowner_name: 'Ada Lovelace',
          claim_id: '00000000-0000-4000-8000-0000000000c1',
          claim_number: 'CL-100',
          check_intake_item_id: '00000000-0000-4000-8000-000000000011',
          accepted_at: '2026-10-01T12:00:00.000Z',
          completed_at: '2026-10-02T12:00:00.000Z',
          payment_date: '2026-10-03',
          payment_reference: 'CHK-9',
          payment_note: 'bookkeeping only',
          status: 'paid',
        }],
      }),
    },
  ]);
  const result = await runMortgageAgentCompensation({
    client,
    mapping: { application_user_id: OWNER },
    body: { action: 'entries', period: '2026-10' },
    spoof: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].homeowner_name, 'Ada Lovelace');
  assert.equal(result.entries[0].claim_number, 'CL-100');
  assert.equal(result.entries[0].payment_reference, 'CHK-9');
});
