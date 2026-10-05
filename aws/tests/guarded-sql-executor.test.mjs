import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { FUNCTION_DEF_LOOKUP_SQL } from '../../scripts/deployment-guard/lib/function-def-lookup.mjs';
import { hashSqlDefinition } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import {
  AUTHORIZED_SQL39,
  AUTHORIZED_SQL40,
  AUTHORIZED_SQL44,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  authorizationFingerprint,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  AUTHORIZED_PRESENT_FIXTURE_SHA256,
  EMPTY_FIXTURE_SHA256,
  authorizedPresentSnapshot,
  hashFixtureSnapshot,
} from '../../scripts/deployment-guard/lib/collection-v2-synthetic-uat-cleanup.mjs';
import {
  INSPECTED_JOB,
  INSPECTED_WRITE,
  hashTmpRlsCatalog,
} from '../../scripts/deployment-guard/lib/tmp-rls-catalog.mjs';
const EXECUTOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../write-path/guarded-sql-executor');
const GUARD_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/deployment-guard/lib');
fs.mkdirSync(path.join(EXECUTOR_DIR, 'lib'), { recursive: true });
for (const name of ['errors.mjs', 'identity.mjs', 'sql-apply.mjs', 'sql-executor-auth.mjs', 'function-def-lookup.mjs', 'tmp-rls-catalog.mjs', 'collection-v2-synthetic-uat-cleanup.mjs']) {
  fs.copyFileSync(path.join(GUARD_LIB, name), path.join(EXECUTOR_DIR, 'lib', name));
}
const {
  createHandler,
  extractPinnedFunctionSql,
  hashTenantPermissionLiveDefs,
  isExactKnownPredecessor,
  readFunctionDef,
  tenantPermissionDefsAreExact,
  tenantPermissionMarkersMatch,
} = await import('../write-path/guarded-sql-executor/index.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL_FILE = path.join(ROOT, AUTHORIZED_SQL44.filename);
const NOW = '2026-09-29T18:00:00.000Z';
const EXPECTED_LIVE = 'af784b78408b77ed928d1c815309e8da3459e9ebd3f4f6068321b9f33dd2a078';
const BEFORE_DEF = `CREATE FUNCTION public.claim_ledger_link_or_create() BEFORE ${EXPECTED_LIVE}`;
const AFTER_DEF = `CREATE FUNCTION public.claim_ledger_link_or_create()
  same_tenant_detected_count
  same_tenant_unlinked_count
  same_tenant_already_linked_count
  ocr_claim_number_key
  AFTER`;
const SQL43_DEF = 'CREATE FUNCTION public.review_save_detected_claim_number() UNCHANGED';

function authEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql44-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const expectedLive = overrides.expected_live_definition_sha256 || hashSqlDefinition(BEFORE_DEF);
  const base = {
    action: 'apply',
    workstream_id: 'claim-ledger',
    branch: 'cursor/ledger-guarded-main-a2a4',
    commit: AUTHORIZED_SQL44.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_SQL44.filename],
    filename: AUTHORIZED_SQL44.filename,
    migration_id: AUTHORIZED_SQL44.migration_id,
    source_sha256: AUTHORIZED_SQL44.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL44.intended_replacement_sha256,
    expected_live_definition_sha256: expectedLive,
    one_use_id: oneUse,
    expiry: '2026-09-29T19:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    preflight_live_fingerprint: authorizationFingerprint({
      ...AUTHORIZED_SQL44,
      expected_live_definition_sha256: expectedLive,
      one_use_id: oneUse,
    }),
  };
  return { ...base, ...overrides, one_use_id: oneUse, preflight_live_fingerprint: overrides.preflight_live_fingerprint || base.preflight_live_fingerprint };
}

function mockConnect({
  beforeDef = BEFORE_DEF,
  afterDef = AFTER_DEF,
  sql43Def = SQL43_DEF,
  mutateDataOnApply = false,
} = {}) {
  const checks = [
    { id: '66174175-ccd3-4d15-a0e2-49aeeb074fc5', tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', claim_id: null, amount: '6145.73', deposited_at: null, check_stage: 'review', detected_claim_number: '695064-GQ' },
    { id: '00062a57-13b5-493d-a996-cf6e72d5cc89', tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', claim_id: null, amount: '7040.80', deposited_at: null, check_stage: 'endorsing', detected_claim_number: '695064-GQ' },
    { id: '3ebc2f0f-1cf7-47b5-9b0b-ac9ce6bdace9', tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', claim_id: null, amount: '7677.39', deposited_at: null, check_stage: 'endorsing', detected_claim_number: '695064-GQ' },
    { id: '6238a632-84f1-4eea-a352-2cf639ebe4b4', tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', claim_id: null, amount: '1531.66', deposited_at: null, check_stage: 'review', detected_claim_number: '695064-GQ' },
  ];
  let applied = false;
  let invoked = false;
  const client = {
    invoked() { return invoked; },
    applied() { return applied; },
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('CREATE OR REPLACE FUNCTION public.claim_ledger_link_or_create')) {
        applied = true;
        return { rows: [] };
      }
      if (text.includes('current_database')) return { rows: [{ d: 'checksops' }] };
      if (text.includes('FROM pg_proc') || text.includes('pg_get_functiondef')) {
        if (text.includes('::regprocedure')) {
          throw new Error('function definition lookup must not cast through regprocedure');
        }
        const name = String(params?.[1] || params?.[0] || '');
        if (name.includes('claim_ledger')) {
          return { rows: [{ def: applied ? afterDef : beforeDef }] };
        }
        return { rows: [{ def: sql43Def }] };
      }
      if (text.includes('routine_privileges')) {
        return { rows: [{ grantee: 'checksops', privilege_type: 'EXECUTE' }] };
      }
      if (text.includes('role_table_grants') || text.includes('column_privileges')) {
        return { rows: [] };
      }
      if (text.includes('FROM public.claims')) return { rows: [] };
      if (text.includes('FROM public.check_intake_items')) {
        const rows = mutateDataOnApply && applied
          ? checks.map((row, idx) => (idx === 0 ? { ...row, claim_id: 'mutated' } : row))
          : checks;
        return { rows };
      }
      if (text.includes('FROM public.claim_payments') || text.includes('FROM public.claim_checks')) {
        return { rows: [] };
      }
      if (text.includes('FROM public.claim_disbursements')) return { rows: [] };
      if (text.includes('claim_ledger_link_or_create($1')) {
        invoked = true;
        return { rows: [{ result: { ok: true, code: 'no_match', same_tenant_detected_count: 4 } }] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    },
    async end() {},
  };
  return async () => client;
}

function handlerFor(connect, extra = {}) {
  const consumed = path.join(os.tmpdir(), `sql-exec-consumed-${process.pid}-${Date.now()}.json`);
  process.env.SQL_EXECUTOR_CONSUMED_PATH = consumed;
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => Date.parse(NOW),
    sqlFile: SQL_FILE,
    expectedSql43Hash: hashSqlDefinition(SQL43_DEF),
    ...extra,
  });
}

test('apply refuses SQL_COLLISION when live hash does not match expected', async () => {
  const handler = handlerFor(mockConnect({
    beforeDef: 'CREATE FUNCTION unexpected live definition',
  }));
  const result = await handler(authEvent());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
});

test('apply does not invoke the function and returns a machine-readable receipt', async () => {
  const connect = mockConnect();
  const handler = handlerFor(connect);
  const event = authEvent();
  event.preflight_live_fingerprint.one_use_id = event.one_use_id;
  const result = await handler(event);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
  assert.equal(result.details.receipt.before_hash, hashSqlDefinition(BEFORE_DEF));
  assert.equal(result.details.receipt.after_hash, hashSqlDefinition(AFTER_DEF));
  assert.equal(result.details.receipt.sql43_hash, hashSqlDefinition(SQL43_DEF));
  assert.equal(result.details.receipt.workstream, 'claim-ledger');
  assert.equal(result.details.receipt.commit, AUTHORIZED_SQL44.commit);
  assert.equal(result.details.receipt.executor_identity, 'checksops-staging-guarded-sql-executor');
  assert.equal(result.details.receipt.data_before.claims_rows, 0);
  assert.equal(result.details.receipt.data_before.same_tenant_unlinked_count, 4);
  const client = await connect();
  assert.equal(client.invoked(), false);
  assert.equal(client.applied(), true);
});

test('replay of the same one_use_id is refused', async () => {
  const handler = handlerFor(mockConnect());
  const event = authEvent({ one_use_id: 'sql44-replay-test-1' });
  event.preflight_live_fingerprint.one_use_id = event.one_use_id;
  const first = await handler(event);
  assert.equal(first.ok, true, first.message);
  const second = await handler(event);
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.SQL_COLLISION);
});

test('inspect is refused until the applied definition hash is verified', async () => {
  const handler = handlerFor(mockConnect());
  const event = authEvent({
    action: 'inspect',
    applied_after_hash: 'not-the-live-hash',
    inspect: {
      check_id: '66174175-ccd3-4d15-a0e2-49aeeb074fc5',
      tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
      claim_number: '695064-GQ',
    },
  });
  event.preflight_live_fingerprint.one_use_id = event.one_use_id;
  const result = await handler(event);
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
});

test('inspect after verified apply does not mutate data', async () => {
  const connect = mockConnect({ beforeDef: AFTER_DEF });
  const handler = handlerFor(connect);
  const event = authEvent({
    action: 'inspect',
    applied_after_hash: hashSqlDefinition(AFTER_DEF),
    inspect: {
      check_id: '66174175-ccd3-4d15-a0e2-49aeeb074fc5',
      tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
      claim_number: '695064-GQ',
    },
  });
  event.preflight_live_fingerprint.one_use_id = event.one_use_id;
  const result = await handler(event);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'inspect');
  assert.equal(result.details.receipt.inspect.same_tenant_detected_count, 4);
  const client = await connect();
  assert.equal(client.invoked(), true);
});

test('create_new remains forbidden on the executor', async () => {
  const handler = handlerFor(mockConnect());
  const result = await handler(authEvent({ action: 'create_new' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
});

const TENANT_SQL = path.join(ROOT, AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.filename);
const TENANT_SQL_TEXT = fs.readFileSync(TENANT_SQL, 'utf8');
const PREDECESSOR_SQL = path.join(ROOT, 'supabase/migrations/20261001193100_tenant_users_can_override_check_status.sql');
const PREDECESSOR_SQL_TEXT = fs.readFileSync(PREDECESSOR_SQL, 'utf8');
const PINNED_MOVE = extractPinnedFunctionSql(TENANT_SQL_TEXT, 'user_can_move_tenant_checks');
const PINNED_OVERRIDE = extractPinnedFunctionSql(TENANT_SQL_TEXT, 'admin_override_check_status');
const PREDECESSOR_OVERRIDE = extractPinnedFunctionSql(PREDECESSOR_SQL_TEXT, 'admin_override_check_status');
const MARKER_SIMILAR_MOVE = `CREATE OR REPLACE FUNCTION public.user_can_move_tenant_checks(p_check_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT public.user_belongs_to_tenant(p_user_id, '00000000-0000-0000-0000-000000000000')
      OR public.has_role(p_user_id, 'admin');
$function$;`;
const MARKER_SIMILAR_OVERRIDE = `CREATE OR REPLACE FUNCTION public.admin_override_check_status(p_check_id uuid, p_new_status text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_allowed text[] := ARRAY['uploaded','voided'];
BEGIN
  IF NOT public.user_can_move_tenant_checks(p_check_id, p_actor_id) THEN
    RAISE EXCEPTION 'marker-similar but not exact';
  END IF;
  RETURN jsonb_build_object('ok', true, 'adversarial', true);
END
$function$;`;

function tenantAuthEvent(overrides = {}) {
  const live = overrides.liveDefs || { user_can_move_tenant_checks: null, admin_override_check_status: null };
  const expectedLive = overrides.expected_live_definition_sha256 || hashTenantPermissionLiveDefs(live);
  const oneUse = overrides.one_use_id || `tenant-perm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    action: 'apply',
    workstream_id: 'tenant-permissions',
    branch: 'cursor/staging-guard-writers-ad6f',
    commit: AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.filename],
    filename: AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.filename,
    migration_id: AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.migration_id,
    source_sha256: AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.source_sha256,
    intended_replacement_sha256: AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.intended_replacement_sha256,
    expected_live_definition_sha256: expectedLive,
    one_use_id: oneUse,
    expiry: '2026-10-02T02:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: '2026-10-02T00:00:00.000Z',
    preflight_live_fingerprint: authorizationFingerprint({
      ...AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
      expected_live_definition_sha256: expectedLive,
      one_use_id: oneUse,
    }),
    ...overrides,
  };
}

const LIVE_SHAPED_MOVE = `CREATE OR REPLACE FUNCTION public.user_can_move_tenant_checks(_user_id uuid, _tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    public.has_role(_user_id, 'admin'::app_role)
    OR public.user_belongs_to_tenant(_user_id, _tenant_id)
$function$`;
const LIVE_SHAPED_OVERRIDE = PINNED_OVERRIDE.replace(/;\s*$/, '');

function mockTenantConnect({
  moveDef = null,
  overrideDef = null,
  afterApplyMove = PINNED_MOVE,
  afterApplyOverride = PINNED_OVERRIDE,
  lookupError = null,
  duplicateFor = null,
} = {}) {
  let applied = false;
  const lookups = [];
  const client = {
    applied() { return applied; },
    lookups() { return lookups; },
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('current_database')) return { rows: [{ d: 'checksops' }] };
      if (text.includes('CREATE OR REPLACE FUNCTION public.user_can_move_tenant_checks')) {
        applied = true;
        return { rows: [] };
      }
      if (text.includes('FROM pg_proc') || text.includes('pg_get_functiondef')) {
        if (text.includes('::regprocedure')) {
          throw new Error('function definition lookup must not cast through regprocedure');
        }
        const name = String(params?.[1] || '');
        lookups.push({ schema: params?.[0], name, args: params?.[2], sql: text });
        if (lookupError) throw new Error(lookupError);
        if (duplicateFor && name.includes(duplicateFor)) {
          return { rows: [{ def: 'CREATE FUNCTION duplicate A' }, { def: 'CREATE FUNCTION duplicate B' }] };
        }
        if (name.includes('user_can_move_tenant_checks')) {
          const def = applied ? afterApplyMove : moveDef;
          return { rows: def ? [{ def }] : [] };
        }
        if (name.includes('admin_override_check_status')) {
          const def = applied ? afterApplyOverride : overrideDef;
          return { rows: def ? [{ def }] : [] };
        }
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    },
    async end() {},
  };
  return async () => client;
}

function tenantHandler(connect, extra = {}) {
  const consumed = path.join(os.tmpdir(), `sql-exec-tenant-${process.pid}-${Date.now()}.json`);
  process.env.SQL_EXECUTOR_CONSUMED_PATH = consumed;
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => Date.parse('2026-10-02T00:00:00.000Z'),
    sqlFile601: TENANT_SQL,
    sqlFile601Predecessor: PREDECESSOR_SQL,
    ...extra,
  });
}

test('#601 absent definitions are eligible to apply from the pinned file', async () => {
  assert.ok(PINNED_MOVE && PINNED_OVERRIDE);
  const connect = mockTenantConnect();
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent());
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
  const client = await connect();
  assert.equal(client.applied(), true);
});

test('#601 apply accepts live pg_get_functiondef text that matches the pinned body', async () => {
  assert.equal(tenantPermissionDefsAreExact({
    user_can_move_tenant_checks: LIVE_SHAPED_MOVE,
    admin_override_check_status: LIVE_SHAPED_OVERRIDE,
  }, TENANT_SQL_TEXT), true);
  const connect = mockTenantConnect({
    afterApplyMove: LIVE_SHAPED_MOVE,
    afterApplyOverride: LIVE_SHAPED_OVERRIDE,
  });
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent());
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
});

test('#601 exact existing definition is idempotent and does not rewrite', async () => {
  const live = {
    user_can_move_tenant_checks: PINNED_MOVE,
    admin_override_check_status: PINNED_OVERRIDE,
  };
  const connect = mockTenantConnect({ moveDef: PINNED_MOVE, overrideDef: PINNED_OVERRIDE });
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent({ liveDefs: live }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'idempotent');
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('#601 conflicting live definition fails closed with SQL_COLLISION', async () => {
  const live = {
    user_can_move_tenant_checks: 'CREATE FUNCTION public.user_can_move_tenant_checks() OLD',
    admin_override_check_status: 'CREATE FUNCTION public.admin_override_check_status() OLD',
  };
  const connect = mockTenantConnect({
    moveDef: live.user_can_move_tenant_checks,
    overrideDef: live.admin_override_check_status,
  });
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent({ liveDefs: live }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('#601 one-absent one-present live definitions are SQL_COLLISION', async () => {
  const live = {
    user_can_move_tenant_checks: PINNED_MOVE,
    admin_override_check_status: null,
  };
  const connect = mockTenantConnect({ moveDef: PINNED_MOVE, overrideDef: null });
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent({ liveDefs: live }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('#601 marker-similar but definition-different body is SQL_COLLISION, not idempotent', async () => {
  const live = {
    user_can_move_tenant_checks: MARKER_SIMILAR_MOVE,
    admin_override_check_status: MARKER_SIMILAR_OVERRIDE,
  };
  assert.equal(tenantPermissionMarkersMatch(live), true);
  assert.equal(tenantPermissionDefsAreExact(live, TENANT_SQL_TEXT), false);
  const connect = mockTenantConnect({
    moveDef: MARKER_SIMILAR_MOVE,
    overrideDef: MARKER_SIMILAR_OVERRIDE,
  });
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent({ liveDefs: live }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  assert.equal(result.details.marker_similar, true);
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('#601 exact known predecessor 20261001193100 is eligible to apply', async () => {
  assert.ok(PREDECESSOR_OVERRIDE);
  const live = {
    user_can_move_tenant_checks: null,
    admin_override_check_status: PREDECESSOR_OVERRIDE,
  };
  assert.equal(isExactKnownPredecessor(live, PREDECESSOR_OVERRIDE), true);
  assert.equal(tenantPermissionDefsAreExact(live, TENANT_SQL_TEXT), false);
  const connect = mockTenantConnect({
    moveDef: null,
    overrideDef: PREDECESSOR_OVERRIDE,
  });
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent({ liveDefs: live }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
  const client = await connect();
  assert.equal(client.applied(), true);
});

test('#601 predecessor-shaped but hash-different override remains SQL_COLLISION', async () => {
  const almost = `${PREDECESSOR_OVERRIDE}\n-- extra comment changes the hash\n`;
  const live = {
    user_can_move_tenant_checks: null,
    admin_override_check_status: almost,
  };
  assert.equal(isExactKnownPredecessor(live, PREDECESSOR_OVERRIDE), false);
  const connect = mockTenantConnect({ moveDef: null, overrideDef: almost });
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent({ liveDefs: live }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('#601 inspect of both-absent functions is an explicit absent state and does not create them', async () => {
  const connect = mockTenantConnect();
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent({ action: 'inspect' }));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.details.receipt.live_functions, {
    user_can_move_tenant_checks: false,
    admin_override_check_status: false,
  });
  assert.equal(result.details.receipt.exact, false);
  assert.equal(result.details.receipt.known_predecessor, false);
  const client = await connect();
  assert.equal(client.applied(), false);
  assert.equal(client.lookups().every((row) => !row.sql.includes('::regprocedure')), true);
});

test('#601 one exact and one modified definition is SQL_COLLISION', async () => {
  const live = {
    user_can_move_tenant_checks: PINNED_MOVE,
    admin_override_check_status: MARKER_SIMILAR_OVERRIDE,
  };
  const connect = mockTenantConnect({
    moveDef: PINNED_MOVE,
    overrideDef: MARKER_SIMILAR_OVERRIDE,
  });
  const handler = tenantHandler(connect);
  const result = await handler(tenantAuthEvent({ liveDefs: live }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('readFunctionDef returns exists:false only for a true zero-row catalog miss', async () => {
  assert.equal(FUNCTION_DEF_LOOKUP_SQL.includes('::regprocedure'), false);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /pg_proc/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /unnest\(p\.proargtypes::oid\[\]\)/);
  assert.equal(/p\.proargtypes::oid\[\]\s*=/.test(FUNCTION_DEF_LOOKUP_SQL), false);
  assert.equal(/AS\s+oidvector/i.test(FUNCTION_DEF_LOOKUP_SQL), false);
  assert.equal(FUNCTION_DEF_LOOKUP_SQL.includes('pg_get_function_identity_arguments'), false);
  const client = {
    async query(sql, params) {
      assert.equal(sql.includes('::regprocedure'), false);
      assert.match(sql, /p\.proargtypes/);
      assert.equal(params[0], 'public');
      assert.equal(params[1], 'user_can_move_tenant_checks');
      assert.deepEqual(params[2], ['uuid', 'uuid']);
      return { rows: [] };
    },
  };
  const result = await readFunctionDef(client, 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(result.ok, true);
  assert.deepEqual(result.details, { exists: false });
});

test('readFunctionDef returns the exact definition for an existing function', async () => {
  const client = {
    async query() {
      return { rows: [{ def: PINNED_MOVE }] };
    },
  };
  const result = await readFunctionDef(client, 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(result.ok, true);
  assert.deepEqual(result.details, { exists: true, definition: PINNED_MOVE });
});

test('readFunctionDef fails closed on lookup/database error and does not report absent', async () => {
  const client = {
    async query() {
      throw new Error('permission denied for table pg_proc');
    },
  };
  const result = await readFunctionDef(client, 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
  assert.equal(result.details.exists, undefined);
  const connect = mockTenantConnect({ lookupError: 'permission denied for table pg_proc' });
  const handler = tenantHandler(connect);
  const applied = await handler(tenantAuthEvent());
  assert.equal(applied.ok, false);
  assert.equal(applied.code, CODES.UNRELATED_MUTATION);
  const live = await connect();
  assert.equal(live.applied(), false);
});

test('readFunctionDef fails closed on unexpected duplicate/ambiguous catalog rows', async () => {
  const client = {
    async query() {
      return { rows: [{ def: 'A' }, { def: 'B' }] };
    },
  };
  const result = await readFunctionDef(client, 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  const connect = mockTenantConnect({ duplicateFor: 'user_can_move_tenant_checks' });
  const handler = tenantHandler(connect);
  const applied = await handler(tenantAuthEvent());
  assert.equal(applied.ok, false);
  assert.equal(applied.code, CODES.SQL_COLLISION);
  const live = await connect();
  assert.equal(live.applied(), false);
});

const SQL39_FILE = path.join(ROOT, AUTHORIZED_SQL39.filename);
const DRIFTED_WRITE = INSPECTED_WRITE;
const INTENDED_WRITE = '(public.aws_can_write_tenant(tenant_id))';
const SELECT_AUTH = '(aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id))';
const SELECT_JOB = 'aws_monthly_billing_job()';

function sql39Catalog({
  writeUsing = DRIFTED_WRITE,
  writeCheck = DRIFTED_WRITE,
  jobUsing = INSPECTED_JOB,
  jobCheck = INSPECTED_JOB,
} = {}) {
  return {
    table: 'tenant_maintenance_payments',
    table_catalog: {
      table: 'tenant_maintenance_payments',
      relrowsecurity: true,
      relforcerowsecurity: false,
    },
    relrowsecurity: true,
    relforcerowsecurity: false,
    policies: [
      {
        name: 'aws_write_tenant_maintenance_payments',
        permissive: 'PERMISSIVE',
        command: 'ALL',
        roles: '{authenticated}',
        using: writeUsing,
        with_check: writeCheck,
      },
      {
        name: 'aws_write_tenant_maintenance_payments_job',
        permissive: 'PERMISSIVE',
        command: 'ALL',
        roles: '{checksops}',
        using: jobUsing,
        with_check: jobCheck,
      },
      {
        name: 'aws_select_tenant_maintenance_payments',
        permissive: 'PERMISSIVE',
        command: 'SELECT',
        roles: '{authenticated}',
        using: SELECT_AUTH,
        with_check: null,
      },
      {
        name: 'aws_select_tenant_maintenance_payments_job',
        permissive: 'PERMISSIVE',
        command: 'SELECT',
        roles: '{checksops}',
        using: SELECT_JOB,
        with_check: null,
      },
    ],
    grants: [
      { grantee: 'authenticated', privilege_type: 'INSERT' },
      { grantee: 'authenticated', privilege_type: 'SELECT' },
      { grantee: 'authenticated', privilege_type: 'UPDATE' },
      { grantee: 'checksops', privilege_type: 'INSERT' },
      { grantee: 'checksops', privilege_type: 'SELECT' },
      { grantee: 'checksops', privilege_type: 'UPDATE' },
    ],
    lambda_role_membership: ['authenticated'],
  };
}

function sql39AuthEvent(overrides = {}) {
  const catalog = overrides.catalog || sql39Catalog();
  const expectedLive = overrides.expected_live_definition_sha256 || hashTmpRlsCatalog(catalog);
  const oneUse = overrides.one_use_id || `sql39-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const base = {
    action: 'apply',
    workstream_id: 'tmp-rls-write-drift-repair-93da',
    branch: 'cursor/tmp-rls-write-drift-repair-93da',
    commit: AUTHORIZED_SQL39.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_SQL39.filename],
    filename: AUTHORIZED_SQL39.filename,
    migration_id: AUTHORIZED_SQL39.migration_id,
    source_sha256: AUTHORIZED_SQL39.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL39.intended_replacement_sha256,
    expected_live_definition_sha256: expectedLive,
    one_use_id: oneUse,
    expiry: '2026-10-05T20:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: '2026-10-05T18:00:00.000Z',
    preflight_live_fingerprint: authorizationFingerprint({
      ...AUTHORIZED_SQL39,
      expected_live_definition_sha256: expectedLive,
      one_use_id: oneUse,
    }),
  };
  return {
    ...base,
    ...overrides,
    one_use_id: oneUse,
    expected_live_definition_sha256: expectedLive,
    preflight_live_fingerprint: overrides.preflight_live_fingerprint || base.preflight_live_fingerprint,
  };
}

function mockSql39Connect({
  before = sql39Catalog(),
  after = sql39Catalog({ writeUsing: INTENDED_WRITE, writeCheck: INTENDED_WRITE }),
  mutateJobOnApply = false,
  mutateFrozenOnApply = false,
} = {}) {
  let applied = false;
  const client = {
    applied() { return applied; },
    async query(sql) {
      const text = String(sql);
      if (text.includes('current_database')) return { rows: [{ d: 'checksops' }] };
      if (text.includes('DROP POLICY IF EXISTS aws_write_tenant_maintenance_payments')) {
        applied = true;
        return { rows: [] };
      }
      if (text.includes('tmp_rls_catalog_rls')) {
        const catalog = applied ? after : before;
        return {
          rows: [{
            table: catalog.table,
            relrowsecurity: catalog.relrowsecurity,
            relforcerowsecurity: catalog.relforcerowsecurity,
          }],
        };
      }
      if (text.includes('tmp_rls_catalog_policies')) {
        const catalog = applied ? after : before;
        const policies = mutateJobOnApply && applied
          ? catalog.policies.map((policy) => (
            policy.name === 'aws_write_tenant_maintenance_payments_job'
              ? { ...policy, using: 'true', with_check: 'true' }
              : policy
          ))
          : catalog.policies;
        return { rows: policies };
      }
      if (text.includes('tmp_rls_catalog_grants')) {
        return { rows: (applied ? after : before).grants };
      }
      if (text.includes('tmp_rls_catalog_membership')) {
        return { rows: (applied ? after : before).lambda_role_membership.map((rolname) => ({ rolname })) };
      }
      if (text.includes('tmp_rls_frozen_functions')) {
        return {
          rows: [{
            schema: 'public',
            name: 'aws_can_write_tenant',
            identity_arguments: '_tenant_id uuid',
            definition: mutateFrozenOnApply && applied ? 'CHANGED' : 'CREATE FUNCTION public.aws_can_write_tenant',
          }],
        };
      }
      if (text.includes('tmp_rls_frozen_triggers')) {
        return {
          rows: [{
            name: 'tenant_maintenance_payments_set_updated_at',
            definition: 'CREATE TRIGGER tenant_maintenance_payments_set_updated_at',
          }],
        };
      }
      throw new Error(`unexpected query: ${text.slice(0, 160)}`);
    },
    async end() {},
  };
  return async () => client;
}

function sql39Handler(connect, extra = {}) {
  const consumed = path.join(os.tmpdir(), `sql-exec-39-${process.pid}-${Date.now()}.json`);
  process.env.SQL_EXECUTOR_CONSUMED_PATH = consumed;
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => Date.parse('2026-10-05T18:00:00.000Z'),
    sqlFile39: SQL39_FILE,
    ...extra,
  });
}

test('SQL 39 apply reconciles only the authenticated write policy', async () => {
  const before = sql39Catalog();
  const after = sql39Catalog({ writeUsing: INTENDED_WRITE, writeCheck: INTENDED_WRITE });
  const connect = mockSql39Connect({ before, after });
  const handler = sql39Handler(connect);
  const result = await handler(sql39AuthEvent({ catalog: before }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
  assert.equal(result.details.receipt.job_policy_intact, true);
  assert.equal(result.details.receipt.before_hash, hashTmpRlsCatalog(before));
  assert.equal(result.details.receipt.after_hash, hashTmpRlsCatalog(after));
  const client = await connect();
  assert.equal(client.applied(), true);
});

test('SQL 39 authorize reads the catalog and does not apply', async () => {
  const connect = mockSql39Connect();
  const handler = sql39Handler(connect);
  const result = await handler(sql39AuthEvent({ action: 'authorize' }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'authorize');
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('SQL 39 refuses apply when live catalog hash differs', async () => {
  const connect = mockSql39Connect();
  const handler = sql39Handler(connect);
  const result = await handler(sql39AuthEvent({
    expected_live_definition_sha256: '1'.repeat(64),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('SQL 39 refuses apply when the job policy would change', async () => {
  const connect = mockSql39Connect({ mutateJobOnApply: true });
  const handler = sql39Handler(connect);
  const result = await handler(sql39AuthEvent());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  const client = await connect();
  assert.equal(client.applied(), true);
});

test('SQL 39 refuses apply when helper functions change', async () => {
  const connect = mockSql39Connect({ mutateFrozenOnApply: true });
  const handler = sql39Handler(connect);
  const result = await handler(sql39AuthEvent());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
});

const SQL40_FILE = path.join(ROOT, AUTHORIZED_SQL40.filename);

function presentSql40Fixture() {
  return authorizedPresentSnapshot();
}

function sql40AuthEvent(overrides = {}) {
  const expectedLive = overrides.expected_live_definition_sha256 || AUTHORIZED_PRESENT_FIXTURE_SHA256;
  const oneUse = overrides.one_use_id || `sql40-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const base = {
    action: 'apply',
    workstream_id: 'collection-v2-uat-cleanup-sql-93da',
    branch: 'cursor/collection-v2-uat-cleanup-sql-93da',
    commit: AUTHORIZED_SQL40.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_SQL40.filename],
    filename: AUTHORIZED_SQL40.filename,
    migration_id: AUTHORIZED_SQL40.migration_id,
    source_sha256: AUTHORIZED_SQL40.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL40.intended_replacement_sha256,
    expected_live_definition_sha256: expectedLive,
    one_use_id: oneUse,
    expiry: '2026-10-05T22:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: '2026-10-05T19:00:00.000Z',
    preflight_live_fingerprint: authorizationFingerprint({
      ...AUTHORIZED_SQL40,
      expected_live_definition_sha256: expectedLive,
      one_use_id: oneUse,
    }),
  };
  return {
    ...base,
    ...overrides,
    one_use_id: oneUse,
    expected_live_definition_sha256: expectedLive,
    preflight_live_fingerprint: overrides.preflight_live_fingerprint || base.preflight_live_fingerprint,
  };
}

function mockSql40Connect({
  before = presentSql40Fixture(),
  after = { tmp: null, events: [], payment_transfers: 0 },
} = {}) {
  let applied = false;
  const asRows = (snapshot) => ({
    tmp: snapshot.tmp ? [{
      id: snapshot.tmp.id,
      tenant_id: snapshot.tmp.tenant_id,
      provider_transfer_id: snapshot.tmp.provider_transfer_id,
      amount_cents: snapshot.tmp.amount_cents,
      provider_environment: snapshot.tmp.provider_environment,
      status: snapshot.tmp.status,
      notes: `${AUTHORIZED_SQL40.filename.includes('40') ? 'SYNTHETIC_UAT_COLLECTION_V2 harness=9ff1a038-2ea8-4d67-8082-74ffd2e79a7c' : ''}`,
    }] : [],
    events: (snapshot.events || []).map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      provider_transfer_id: row.provider_transfer_id,
      provider_metadata: {
        synthetic_uat_marker: row.synthetic_uat_marker,
        harness_id: row.harness_id,
        checksops_payment_id: row.checksops_payment_id,
      },
    })),
    transfers: [{ n: snapshot.payment_transfers || 0 }],
  });
  const client = {
    applied() { return applied; },
    async query(sql) {
      const text = String(sql);
      if (text.includes('$cleanup$') || text.includes('40_collection_v2_synthetic_uat_cleanup')) {
        applied = true;
        return { rows: [] };
      }
      const snapshot = applied ? after : before;
      const rows = asRows(snapshot);
      if (text.includes('sql40_tmp')) return { rows: rows.tmp };
      if (text.includes('sql40_events')) return { rows: rows.events };
      if (text.includes('sql40_transfers')) return { rows: rows.transfers };
      if (text.includes('sql40_freedom_tmp')) {
        return {
          rows: [{
            id: '72b622f9-b68f-4032-a971-a854dbcfbf57',
            tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
            provider_transfer_id: 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb',
            amount_cents: 13900,
            provider_environment: 'sandbox',
            status: 'settled',
          }],
        };
      }
      if (text.includes('sql40_freedom_xfer')) return { rows: [] };
      if (text.includes('sql40_freedom_tmp_by_xfer')) return { rows: [] };
      if (text.includes('sql40_freedom_events')) return { rows: [{ n: 0 }] };
      if (text.includes('sql40_tmp_grants')) {
        return {
          rows: [
            { grantee: 'authenticated', privilege_type: 'INSERT' },
            { grantee: 'authenticated', privilege_type: 'SELECT' },
            { grantee: 'authenticated', privilege_type: 'UPDATE' },
            { grantee: 'checksops', privilege_type: 'INSERT' },
            { grantee: 'checksops', privilege_type: 'SELECT' },
            { grantee: 'checksops', privilege_type: 'UPDATE' },
          ],
        };
      }
      if (text.includes('sql40_tmp_write_policy')) {
        return {
          rows: [{
            name: 'aws_write_tenant_maintenance_payments',
            using: '(public.aws_can_write_tenant(tenant_id))',
            with_check: '(public.aws_can_write_tenant(tenant_id))',
          }],
        };
      }
      throw new Error(`unexpected query: ${text.slice(0, 160)}`);
    },
    async end() {},
  };
  return async () => client;
}

function sql40Handler(connect, extra = {}) {
  const consumed = path.join(os.tmpdir(), `sql-exec-40-${process.pid}-${Date.now()}.json`);
  process.env.SQL_EXECUTOR_CONSUMED_PATH = consumed;
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => Date.parse('2026-10-05T19:00:00.000Z'),
    sqlFile40: SQL40_FILE,
    ...extra,
  });
}

test('SQL 40 apply deletes only the authorized exact-ID fixture', async () => {
  const before = presentSql40Fixture();
  const connect = mockSql40Connect({ before });
  const handler = sql40Handler(connect);
  const result = await handler(sql40AuthEvent());
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
  assert.equal(result.details.receipt.before_hash, hashFixtureSnapshot(before));
  assert.equal(result.details.receipt.after_hash, EMPTY_FIXTURE_SHA256);
  assert.deepEqual(result.details.receipt.deleted, {
    payment_event_log: 2,
    tenant_maintenance_payments: 1,
    payment_transfers: 0,
  });
  assert.equal(result.details.receipt.application_delete_granted, false);
  const client = await connect();
  assert.equal(client.applied(), true);
});

test('SQL 40 authorize reads the fixture and does not apply', async () => {
  const connect = mockSql40Connect();
  const handler = sql40Handler(connect);
  const result = await handler(sql40AuthEvent({ action: 'authorize' }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'authorize');
  assert.equal(result.details.receipt.before_hash, AUTHORIZED_PRESENT_FIXTURE_SHA256);
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('SQL 40 refuses apply when live fixture hash differs', async () => {
  const connect = mockSql40Connect();
  const handler = sql40Handler(connect);
  const result = await handler(sql40AuthEvent({
    expected_live_definition_sha256: '1'.repeat(64),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  const client = await connect();
  assert.equal(client.applied(), false);
});

test('SQL 40 refuses apply when selected rows reference Freedom IDs', async () => {
  const before = presentSql40Fixture();
  before.tmp.tenant_id = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
  const connect = mockSql40Connect({ before });
  const handler = sql40Handler(connect);
  const result = await handler(sql40AuthEvent({
    expected_live_definition_sha256: hashFixtureSnapshot(before),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
  const client = await connect();
  assert.equal(client.applied(), false);
});
