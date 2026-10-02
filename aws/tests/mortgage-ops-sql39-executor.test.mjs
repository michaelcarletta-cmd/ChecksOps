import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { hashSqlDefinition } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import {
  AUTHORIZED_MEMBERSHIP_ONLY,
  AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE,
  authorizationFingerprint,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';

const EXECUTOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../write-path/guarded-sql-executor');
const GUARD_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/deployment-guard/lib');
fs.mkdirSync(path.join(EXECUTOR_DIR, 'lib'), { recursive: true });
for (const name of ['errors.mjs', 'identity.mjs', 'sql-apply.mjs', 'sql-executor-auth.mjs', 'function-def-lookup.mjs']) {
  fs.copyFileSync(path.join(GUARD_LIB, name), path.join(EXECUTOR_DIR, 'lib', name));
}
const { createHandler } = await import('../write-path/guarded-sql-executor/index.mjs');
const {
  hashMortgageOpsLiveSnapshot,
  mortgageOpsAlreadyExact,
  sql39TextIsNarrow,
} = await import('../write-path/guarded-sql-executor/mortgage-ops-sql39.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL39 = path.join(ROOT, AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.filename);
const SQL39_TEXT = fs.readFileSync(SQL39, 'utf8');
const MEMBERSHIP_SQL = path.join(ROOT, AUTHORIZED_MEMBERSHIP_ONLY.filename);
const MOVE_AFTER = `CREATE OR REPLACE FUNCTION public.user_can_move_tenant_checks(_user_id uuid, _tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.user_belongs_to_tenant(_user_id, _tenant_id)
$function$;`;
const OVERRIDE_LIVE = `CREATE OR REPLACE FUNCTION public.admin_override_check_status(_check_id uuid, _status text, _actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object('ok', true);
$function$;`;
const AGENT_FN = `CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.aws_is_authenticated()
     AND public.has_role(auth.uid(), 'mortgage_agent'::public.app_role);
$function$;`;

function mortgageAuthEvent(overrides = {}) {
  const liveHash = overrides.expected_live_definition_sha256 || '1'.repeat(64);
  const oneUse = overrides.one_use_id || `mops-sql39-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    action: 'apply',
    workstream_id: 'mortgage-ops-repair-ad99',
    branch: 'cursor/mortgage-ops-repair-ad99',
    commit: AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.filename],
    filename: AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.filename,
    migration_id: AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.migration_id,
    source_sha256: AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.source_sha256,
    intended_replacement_sha256: AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.intended_replacement_sha256,
    expected_live_definition_sha256: liveHash,
    one_use_id: oneUse,
    expiry: '2026-10-03T02:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: '2026-10-02T23:00:00.000Z',
    preflight_live_fingerprint: authorizationFingerprint({
      ...AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE,
      expected_live_definition_sha256: liveHash,
      one_use_id: oneUse,
    }),
    ...overrides,
  };
}

function emptySnapshot(overrides = {}) {
  return {
    policies: [],
    column_update_grants: [],
    table_grants: [],
    force_rls: [
      { table_name: 'mortgage_handling_requests', rls: true, force_rls: false },
      { table_name: 'check_billing_events', rls: true, force_rls: false },
    ],
    aws_is_mortgage_ops_agent: null,
    user_can_move_tenant_checks_sha256: hashSqlDefinition(MOVE_AFTER),
    admin_override_check_status_sha256: hashSqlDefinition(OVERRIDE_LIVE),
    ...overrides,
  };
}

function exactSnapshot() {
  return emptySnapshot({
    policies: [
      { table_name: 'mortgage_handling_requests', policy_name: 'aws_select_mortgage_ops_agent_queue', command: 'r', using_expr: 'agent', with_check: null },
      { table_name: 'mortgage_handling_requests', policy_name: 'aws_update_mortgage_ops_accept_complete', command: 'w', using_expr: 'agent', with_check: 'self' },
      { table_name: 'check_billing_events', policy_name: 'aws_insert_mortgage_ops_usage_events', command: 'a', using_expr: null, with_check: 'usage' },
    ],
    column_update_grants: ['assigned_employee_id', 'accepted_at', 'completed_at'].flatMap((column_name) => (
      ['checksops', 'authenticated'].map((grantee) => ({
        table_name: 'mortgage_handling_requests',
        column_name,
        grantee,
        privilege_type: 'UPDATE',
      }))
    )),
    table_grants: [
      { table_name: 'check_billing_events', grantee: 'checksops', privilege_type: 'INSERT' },
      { table_name: 'check_billing_events', grantee: 'authenticated', privilege_type: 'INSERT' },
    ],
    aws_is_mortgage_ops_agent: AGENT_FN,
  });
}

function mockMortgageConnect({
  before = emptySnapshot(),
  after = exactSnapshot(),
} = {}) {
  let applied = false;
  const client = {
    applied() { return applied; },
    async query(sql) {
      const text = String(sql);
      if (text.includes('current_database')) return { rows: [{ d: 'checksops' }] };
      if (text.includes('CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent')
        || text.includes('DROP POLICY IF EXISTS aws_update_mortgage_handling_requests')) {
        applied = true;
        return { rows: [] };
      }
      const snap = applied ? after : before;
      if (text.includes('mops-sql39-policies')) return { rows: snap.policies };
      if (text.includes('mops-sql39-column-grants')) return { rows: snap.column_update_grants };
      if (text.includes('mops-sql39-table-grants')) return { rows: snap.table_grants };
      if (text.includes('mops-sql39-force-rls')) return { rows: snap.force_rls };
      if (text.includes('FROM pg_proc') || text.includes('pg_get_functiondef')) {
        if (text.includes('::regprocedure')) throw new Error('must not use regprocedure');
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 160)}`);
    },
    async end() {},
  };
  // readFunctionDef uses params; mock above returns empty. Override by intercepting name via a richer mock.
  client.query = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('current_database')) return { rows: [{ d: 'checksops' }] };
    if (text.includes('CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent')
      || text.includes('GRANT UPDATE')
      || text.includes('DROP POLICY IF EXISTS aws_update_mortgage_handling_requests')) {
      applied = true;
      return { rows: [] };
    }
    const snap = applied ? after : before;
    if (text.includes('mops-sql39-policies')) return { rows: snap.policies };
    if (text.includes('mops-sql39-column-grants')) return { rows: snap.column_update_grants };
    if (text.includes('mops-sql39-table-grants')) return { rows: snap.table_grants };
    if (text.includes('mops-sql39-force-rls')) return { rows: snap.force_rls };
    if (text.includes('FROM pg_proc') || text.includes('pg_get_functiondef')) {
      const name = String(params?.[1] || '');
      if (name.includes('aws_is_mortgage_ops_agent')) {
        return { rows: snap.aws_is_mortgage_ops_agent ? [{ def: snap.aws_is_mortgage_ops_agent }] : [] };
      }
      if (name.includes('user_can_move_tenant_checks')) {
        return { rows: [{ def: MOVE_AFTER }] };
      }
      if (name.includes('admin_override_check_status')) {
        return { rows: [{ def: OVERRIDE_LIVE }] };
      }
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${text.slice(0, 160)}`);
  };
  return async () => client;
}

function handlerFor(connect) {
  const consumed = path.join(os.tmpdir(), `sql-exec-mops-${process.pid}-${Date.now()}.json`);
  process.env.SQL_EXECUTOR_CONSUMED_PATH = consumed;
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => Date.parse('2026-10-02T23:00:00.000Z'),
    sqlFile39: SQL39,
    sqlFileMembership: MEMBERSHIP_SQL,
  });
}

test('SQL 39 text is accepted as a narrow overlay and refuses table-level UPDATE / FORCE RLS / #601 edits', () => {
  assert.equal(sql39TextIsNarrow(SQL39_TEXT).ok, true);
  assert.equal(sql39TextIsNarrow(`${SQL39_TEXT}\nGRANT UPDATE ON TABLE public.mortgage_handling_requests TO authenticated;`).ok, false);
  assert.equal(sql39TextIsNarrow(`${SQL39_TEXT}\nALTER TABLE public.mortgage_handling_requests FORCE ROW LEVEL SECURITY;`).ok, false);
  assert.equal(sql39TextIsNarrow(`${SQL39_TEXT}\n-- user_can_move_tenant_checks`).ok, false);
});

test('SQL 39 inspect reports #601 hashes and no table-level UPDATE without applying', async () => {
  const before = emptySnapshot();
  const connect = mockMortgageConnect({ before });
  const handler = handlerFor(connect);
  const probe = await handler(mortgageAuthEvent({
    action: 'inspect',
    expected_live_definition_sha256: 'd'.repeat(64),
  }));
  assert.equal(probe.ok, false);
  const inspect = await handler(mortgageAuthEvent({
    action: 'inspect',
    expected_live_definition_sha256: probe.details.live_definition_sha256,
  }));
  assert.equal(inspect.ok, true, inspect.message);
  assert.equal(inspect.details.receipt.result, 'inspect');
  assert.equal(inspect.details.receipt.no_table_level_update, true);
  assert.equal(
    inspect.details.receipt.membership_601.user_can_move_tenant_checks_sha256,
    hashSqlDefinition(MOVE_AFTER),
  );
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('SQL 39 apply is idempotent when the live snapshot is already exact', async () => {
  const before = exactSnapshot();
  const connect = mockMortgageConnect({ before, after: before });
  const handler = handlerFor(connect);
  const inspect = await handler(mortgageAuthEvent({
    action: 'inspect',
    expected_live_definition_sha256: 'a'.repeat(64),
  }));
  assert.equal(inspect.ok, false);
  const liveHashProbe = await handler(mortgageAuthEvent({
    action: 'inspect',
    expected_live_definition_sha256: hashMortgageOpsLiveSnapshot(before),
  }));
  // The handler hashes the snapshot it builds, which includes sorted rows and computed 601 hashes.
  if (!liveHashProbe.ok) {
    const liveHash = liveHashProbe.details?.live_definition_sha256;
    const retry = await handler(mortgageAuthEvent({
      action: 'apply',
      expected_live_definition_sha256: liveHash,
    }));
    assert.equal(retry.ok, true, retry.message);
    assert.equal(retry.details.receipt.result, 'idempotent');
    const client = await connect();
    assert.equal(client.applied(), false);
    return;
  }
  assert.equal(liveHashProbe.ok, true, liveHashProbe.message);
  const apply = await handler(mortgageAuthEvent({
    action: 'apply',
    expected_live_definition_sha256: liveHashProbe.details.receipt.before_hash,
  }));
  assert.equal(apply.ok, true, apply.message);
  assert.equal(apply.details.receipt.result, 'idempotent');
  assert.equal(apply.details.receipt.membership_601_unchanged, true);
});

test('SQL 39 apply succeeds from an empty snapshot and preserves #601 hashes', async () => {
  const before = emptySnapshot();
  const after = exactSnapshot();
  const connect = mockMortgageConnect({ before, after });
  const handler = handlerFor(connect);
  const probe = await handler(mortgageAuthEvent({
    action: 'inspect',
    expected_live_definition_sha256: 'b'.repeat(64),
  }));
  assert.equal(probe.ok, false);
  const liveHash = probe.details.live_definition_sha256;
  const result = await handler(mortgageAuthEvent({
    action: 'apply',
    expected_live_definition_sha256: liveHash,
  }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
  assert.equal(result.details.receipt.no_table_level_update, true);
  assert.equal(result.details.receipt.force_rls_unchanged, true);
  assert.equal(result.details.receipt.membership_601_unchanged, true);
  assert.equal(
    result.details.receipt.after.membership_601.user_can_move_tenant_checks_sha256,
    hashSqlDefinition(MOVE_AFTER),
  );
  const client = await connect();
  assert.equal(client.applied(), true);
});

test('SQL 39 apply stops if FORCE RLS or #601 hashes change', async () => {
  const before = emptySnapshot();
  const after = exactSnapshot();
  after.force_rls = [
    { table_name: 'mortgage_handling_requests', rls: true, force_rls: true },
    { table_name: 'check_billing_events', rls: true, force_rls: false },
  ];
  const connect = mockMortgageConnect({ before, after });
  const handler = handlerFor(connect);
  const probe = await handler(mortgageAuthEvent({
    action: 'inspect',
    expected_live_definition_sha256: 'c'.repeat(64),
  }));
  const result = await handler(mortgageAuthEvent({
    action: 'apply',
    expected_live_definition_sha256: probe.details.live_definition_sha256,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
});

test('already-exact helper requires the three column grants and no table UPDATE', () => {
  assert.equal(mortgageOpsAlreadyExact(exactSnapshot(), AGENT_FN.replaceAll('$function$', '$$')), false);
  const intended = `CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.aws_is_authenticated()
     AND public.has_role(auth.uid(), 'mortgage_agent'::public.app_role);
$$;`;
  assert.equal(mortgageOpsAlreadyExact(exactSnapshot(), intended), true);
  const withTableUpdate = exactSnapshot();
  withTableUpdate.table_grants.push({
    table_name: 'mortgage_handling_requests',
    grantee: 'authenticated',
    privilege_type: 'UPDATE',
  });
  assert.equal(mortgageOpsAlreadyExact(withTableUpdate, intended), false);
});
