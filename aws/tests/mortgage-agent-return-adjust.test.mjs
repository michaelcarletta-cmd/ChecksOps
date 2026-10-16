/**
 * Server side of Return to Queue and Adjust (main's
 * aws/functions/api/mortgage-agent-compensation.mjs): platform owner only, and
 * the calls match the SQL 84/85 function signatures.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WRITE_ACTIONS,
  isCompensationAdmin,
  runMortgageAgentCompensation,
} from '../functions/api/mortgage-agent-compensation.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const GLOBAL_ADMIN = '00000000-0000-4000-8000-0000000000ab';
const TENANT_ADMIN = '00000000-0000-4000-8000-0000000000ac';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const AGENT_B = '00000000-0000-4000-8000-0000000000a2';
const REQ = '00000000-0000-4000-8000-000000000021';
const ENTRY = '00000000-0000-4000-8000-0000000000e1';

const RPC = /return_mortgage_handling_request_to_queue|adjust_mortgage_agent_compensation/;

const client = ({ owner = false, roles = [], rpc } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      calls.push({ sql: compact, params });
      if (compact.includes('is_platform_owner')) {
        return { rows: [{ is_master: owner, is_platform: owner }] };
      }
      if (compact.includes('FROM public.user_roles')) return { rows: roles.map((role) => ({ role })) };
      if (RPC.test(compact) && rpc) return rpc(compact, params);
      return { rows: [], rowCount: 0 };
    },
  };
};

const call = (c, user, body) => runMortgageAgentCompensation({
  client: c, mapping: { application_user_id: user }, body, spoof: {},
});

const RETURN_BODY = { action: 'return_to_queue', request_id: REQ, reason: 'Agent unavailable' };
const ADJUST_BODY = { action: 'adjust', parent_entry_id: ENTRY, amount_cents: 250, reason: 'underpayment' };

test('the production-accepted server bytes are unchanged (c3898615)', () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'aws/functions/api/mortgage-agent-compensation.mjs'));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'c38986152765e1d43443c82a779627bd55f96b3c2c246988f4697a3565166512',
  );
});

test('return_to_queue and adjust are write actions; only the platform owner is an admin', () => {
  assert.deepEqual(WRITE_ACTIONS, ['approve', 'mark_paid', 'set_status', 'return_to_queue', 'adjust']);
  assert.equal(isCompensationAdmin({ is_master: false, is_platform: false }, ['admin']), false);
  assert.equal(isCompensationAdmin({ is_master: false, is_platform: false }, ['mortgage_agent']), false);
  assert.equal(isCompensationAdmin({ is_master: false, is_platform: true }, []), true);
});

test('global admin, tenant admin and Mortgage Agent are refused before any RPC', async () => {
  for (const [user, roles] of [
    [GLOBAL_ADMIN, ['admin', 'staff']],
    [TENANT_ADMIN, []],
    [AGENT, ['mortgage_agent']],
  ]) {
    for (const body of [RETURN_BODY, ADJUST_BODY]) {
      const c = client({ owner: false, roles, rpc: () => { throw new Error('rpc must not run'); } });
      const result = await call(c, user, body);
      assert.equal(result.statusCode, 403, `${user} ${body.action}`);
      assert.equal(result.error, 'not_authorized');
      assert.equal(c.calls.some((q) => RPC.test(q.sql)), false);
    }
  }
});

test('a reason is required before the RPC runs', async () => {
  for (const body of [
    { ...RETURN_BODY, reason: '   ' },
    { ...RETURN_BODY, reason: undefined },
    { ...RETURN_BODY, request_id: 'not-a-uuid' },
    { ...ADJUST_BODY, reason: '' },
    { ...ADJUST_BODY, amount_cents: 0 },
    { ...ADJUST_BODY, amount_cents: 1.5 },
  ]) {
    const c = client({ owner: true, rpc: () => { throw new Error('rpc must not run'); } });
    const result = await call(c, OWNER, body);
    assert.equal(result.statusCode, 400, JSON.stringify(body));
    assert.equal(c.calls.some((q) => RPC.test(q.sql)), false);
  }
});

test('the platform owner calls the SQL 84/85 functions with their signatures', async () => {
  const c = client({
    owner: true,
    rpc: (sql) => ({
      rows: sql.includes('return_mortgage')
        ? [{ id: REQ, status: 'requested', accepted_at: '2026-10-03T00:00:00Z' }]
        : [{ adjustment: { paired: true } }],
    }),
  });
  const returned = await call(c, OWNER, { ...RETURN_BODY, reason: '  Agent unavailable  ' });
  assert.equal(returned.ok, true);
  assert.equal(returned.request.status, 'requested');
  assert.equal(returned.request.accepted_at, '2026-10-03T00:00:00Z');
  const adjusted = await call(c, OWNER, {
    ...ADJUST_BODY, amount_cents: -1000, counterparty_agent_id: AGENT_B, pay_period: '2026-10', idempotency_key: ' adjust-k1 ',
  });
  assert.equal(adjusted.ok, true);
  assert.deepEqual(adjusted.adjustment, { paired: true });

  const [ret, adj] = c.calls.filter((q) => RPC.test(q.sql));
  assert.equal(ret.sql, 'SELECT * FROM public.return_mortgage_handling_request_to_queue($1::uuid, $2)');
  assert.deepEqual(ret.params, [REQ, 'Agent unavailable']);
  // Five arguments: SQL 85's sixth (p_idempotency_key) defaults to NULL, so
  // c3898615 keeps working against SQL 85. The SPA's idempotency_key is not
  // forwarded until the server passes it as $6 (a planned, separate change).
  assert.equal(adj.sql, 'SELECT public.adjust_mortgage_agent_compensation($1::uuid, $2::int, $3, $4::uuid, $5) AS adjustment');
  assert.deepEqual(adj.params, [ENTRY, -1000, 'underpayment', AGENT_B, '2026-10']);
  assert.doesNotMatch(c.calls.map((q) => q.sql).join('\n'), /check_billing_events|moov_|stripe_|ach_|mortgage_agent_compensation_rates/i);

  // The SQL files declare exactly these signatures.
  const sql84 = read('aws/workflows/sql/84_mortgage_return_to_queue.sql');
  const sql85 = read('aws/workflows/sql/85_mortgage_compensation_adjust.sql');
  assert.match(sql84, /CREATE OR REPLACE FUNCTION public\.return_mortgage_handling_request_to_queue\(\s*p_request_id uuid,\s*p_reason text\s*\) RETURNS public\.mortgage_handling_requests/);
  assert.match(sql85, /CREATE OR REPLACE FUNCTION public\.adjust_mortgage_agent_compensation\(\s*p_parent_entry_id uuid,\s*p_amount_cents integer,\s*p_reason text,\s*p_counterparty_agent_id uuid DEFAULT NULL,\s*p_pay_period text DEFAULT NULL,\s*p_idempotency_key text DEFAULT NULL\s*\) RETURNS jsonb/);
  assert.match(sql85, /DROP FUNCTION IF EXISTS public\.adjust_mortgage_agent_compensation\(uuid, integer, text, uuid, text\);/);
});

test('SQL refusals map to client errors', async () => {
  const cases = [
    [{ code: '42501', message: 'not_authorized' }, 403],
    [{ code: '42501', message: 'request_excluded' }, 403],
    [{ code: '22023', message: 'invalid_reason' }, 400],
    [{ code: '22023', message: 'invalid_pay_period' }, 400],
    [{ code: '22023', message: 'parent_must_be_root' }, 400],
    [{ code: 'P0002', message: 'request_not_found' }, 404],
    [{ code: 'P0001', message: 'request_not_returnable' }, 409],
    [{ code: 'P0001', message: 'compensation_already_exists' }, 409],
    [{ code: 'P0001', message: 'parent_not_adjustable' }, 409],
    [{ code: '22023', message: 'adjustment_exceeds_parent' }, 400],
    [{ code: '22023', message: 'adjustment_exceeds_net' }, 400],
    [{ code: '22023', message: 'invalid_idempotency_key' }, 400],
    [{ code: 'P0001', message: 'idempotency_key_conflict' }, 409],
  ];
  for (const [error, statusCode] of cases) {
    for (const body of [RETURN_BODY, ADJUST_BODY]) {
      const c = client({ owner: true, rpc: () => { throw Object.assign(new Error(error.message), { code: error.code }); } });
      const result = await call(c, OWNER, body);
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, statusCode, `${error.message} ${body.action}`);
      assert.equal(result.error, error.message);
    }
  }
});
