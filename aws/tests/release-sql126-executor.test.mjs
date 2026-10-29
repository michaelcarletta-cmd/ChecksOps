/**
 * SQL 126 (aws/workflows/sql/126_definer_reads_caller_gates.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-125 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 126 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 25), code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: thirteen Supabase-era SECURITY DEFINER functions replaced, each body the
 *     supabase migration's with only SQL 126's gate or scoping edits (helpers/sql126-definer-reads-
 *     schema.mjs), search_path public, the four TABLE (...) results as PostgreSQL renders them;
 *     EXECUTE for checksops and the owner (PUBLIC, anon, authenticated and service_role revoked); no
 *     table, column, view, policy, table grant or trigger; the prerequisites are the file's own; the
 *     ownership, result and ACL pre-conditions refuse;
 *   - on PostgreSQL 16 (the functions restored from their supabase migrations): the inspect reports
 *     the restored state (derived here from the supabase bytes and the default ACL); refused while a
 *     function is missing, owned by another role or granted to a role the file does not revoke;
 *     a pending pin cannot apply; one apply through the executor reaches the intended fingerprint,
 *     then is refused as already in place.
 * The behavior (who can and cannot read what) is aws/tests/sql126-definer-reads-caller-gates-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL126_DEFINER_READS_CALLER_GATES,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPostconditionFailures,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import {
  SQL126_FUNCTIONS,
  SQL126_IDENTITIES,
  definerReadsSchema,
  sql126Body,
  supabaseFunctionBody,
  supabaseFunctionStatement,
} from './helpers/sql126-definer-reads-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-29T12:00:00.000Z';
const KEY = 'sql126';
const NAMES = SQL126_FUNCTIONS.map((fn) => fn.name);
const FOR_CHECKSOPS = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const RESTORED_ACL = Object.freeze(['PUBLIC EXECUTE', 'owner EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/**
 * The state the inspect reads on a database restored from the supabase migrations (pg_dump
 * --no-acl, aws/db-copy/FIRST_COPY_PROCEDURE.md): every attribute as SQL 126 leaves it except the
 * body (the supabase one) and EXECUTE (PUBLIC and the owner, the default). Derived from bytes.
 */
const restoredState = () => {
  const want = releaseIntendedState(KEY, TEXT);
  return {
    functions: Object.fromEntries(SQL126_FUNCTIONS.map((fn) => [fn.identity, {
      ...want.functions[fn.identity], prosrc_sha256: sha(supabaseFunctionBody(fn.name)), acl: [...RESTORED_ACL],
    }])),
  };
};

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const pin = overrides.pin || PINS[KEY];
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[KEY].choice}`,
    branch: 'main',
    commit: pin.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256 || READ_LIVE_EXPECTED_SENTINEL,
    one_use_id: `${KEY}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-10-29T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql126-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 126 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL126_DEFINER_READS_CALLER_GATES, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/126_definer_reads_caller_gates.sql');
  assert.equal(pin.migration_id, '126_definer_reads_caller_gates');
  assert.equal(spec.choice, 'sql126-definer-reads-caller-gates');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-29) from staging read-live run 40917478177: the
  // thirteen functions with their supabase bodies and EXECUTE PUBLIC and the owner, so not yet applied.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-29: staging apply (wave 25) from staging read-live run 40917478177');
  assert.equal(pin.expected_live_definition_sha256, '04106521263eeeb423ac2c0dfbf5e1f1af5a52c89501b63ac742d6b25c5e1612');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // That pre-state is the restored supabase state with the default ACL, derived on the engine.
  assert.equal(releaseStateHash(KEY, restoredState()), pin.expected_live_definition_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent, and the restored supabase state, each have a fingerprint of their own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, restoredState()), pin.intended_replacement_sha256);
  // The runbook names that restored pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-126-apply.md'), 'utf8');
  assert.ok(runbook.includes(releaseStateHash(KEY, restoredState())));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql126-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], SQL126_IDENTITIES);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces or drops one of the thirteen.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...other.functions.map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.deepEqual(touched.filter((identity) => SQL126_IDENTITIES.includes(identity)), [], key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-29) on the staging apply. Its
  // pre-state is production's own (read-only inspect SSM a98a1794): the supabase bodies, as on staging, with
  // EXECUTE for PUBLIC, checksops and the owner (staging's restore had PUBLIC and the owner only).
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-29 /);
  assert.equal(prod.expected_live_definition_sha256, '9ebc7455de1e0e467eabf59e697899bc64dc360efb8c34a3e00106e68b7754ed');
  assert.notEqual(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
  const productionRestored = restoredState();
  for (const fn of Object.values(productionRestored.functions)) fn.acl = ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'];
  assert.equal(releaseStateHash(KEY, productionRestored), prod.expected_live_definition_sha256);
  let bytes = null;
  if (/^[0-9a-f]{40}$/.test(pin.commit)) {
    try {
      bytes = execFileSync('git', ['-C', ROOT, 'show', `${pin.commit}:${pin.filename}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      bytes = null;
    }
  }
  if (bytes !== null) assert.equal(sha(bytes), pin.source_sha256, 'the pinned commit carries the pinned bytes');
});

test('reviewed file and spec: thirteen definer functions, each the supabase body with only its gate changed; EXECUTE for checksops and the owner; no table, view, policy, table grant or trigger; the file\'s prerequisites; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), NAMES);
  const plpgsql = ['get_all_checks_safety_net', 'get_stuck_checks', 'get_deposit_ops_kpis', 'get_deposit_exception_kpis', 'get_deposit_aging_summary',
    'get_check_dashboard_counts_for_tenant', 'get_loss_draft_dashboard_counts_for_tenant', 'get_tenant_check_usage', 'get_check_claim_settlement', 'has_permission'];
  // The two supabase functions without a volatility keyword stay VOLATILE.
  const volatile = ['get_all_checks_safety_net', 'get_stuck_checks'];
  for (const fn of SQL126_FUNCTIONS) {
    const def = defs[fn.name];
    // The body: exactly the supabase migration's with SQL 126's edits (each matching once), and
    // every edit adds the gate or the scoping, nothing else.
    assert.equal(def.prosrc, sql126Body(fn.name), fn.name);
    assert.notEqual(def.prosrc, supabaseFunctionBody(fn.name), fn.name);
    assert.ok(fn.edits.length >= 1 && fn.edits.length <= 3, fn.name);
    assert.ok(fn.edits.every(([, to]) => /SQL 126|v_owner|aws_user_tenant_ids|is_platform_owner/.test(to)), fn.name);
    assert.equal(def.security_definer, true, fn.name);
    assert.equal(def.language, plpgsql.includes(fn.name) ? 'plpgsql' : 'sql', fn.name);
    assert.equal(def.volatility, volatile.includes(fn.name) ? 'v' : 's', fn.name);
    assert.equal(def.parallel, 'u', fn.name);
    assert.deepEqual(def.config, ['search_path=public'], fn.name);
    // The supabase header says the same (search_path public, SECURITY DEFINER, the language).
    const original = supabaseFunctionStatement(fn.name);
    const header = original.slice(0, original.search(/\bAS\s+\$/));
    assert.match(header, /SECURITY DEFINER/, fn.name);
    assert.match(header, /SET search_path (TO 'public'|= public)/, fn.name);
    assert.match(header, new RegExp(`LANGUAGE ${def.language}\\b`, 'i'), fn.name);
    assert.equal(/\bSTABLE\b/.test(header), !volatile.includes(fn.name), fn.name);
    assert.doesNotMatch(def.prosrc, /row_security|SET\s+ROLE|\bGRANT\b|\bREVOKE\b/i, fn.name);
  }
  // The gates, by kind.
  const gate = (kind) => SQL126_FUNCTIONS.filter((fn) => fn.gate === kind).map((fn) => fn.name);
  assert.deepEqual(gate('owner'), ['get_all_checks_safety_net', 'get_deposit_ops_kpis', 'get_deposit_exception_kpis', 'get_deposit_aging_summary']);
  for (const name of gate('owner')) {
    assert.match(defs[name].prosrc, /IF NOT COALESCE\(public\.is_platform_owner\(\), false\) THEN\s+RAISE EXCEPTION '[Nn]ot authorized' USING ERRCODE = '42501';/, name);
    assert.doesNotMatch(defs[name].prosrc, /has_role/, name);
  }
  assert.deepEqual(gate('tenant'), ['get_check_dashboard_counts_for_tenant', 'get_loss_draft_dashboard_counts_for_tenant', 'get_tenant_check_usage',
    'get_tenant_users_with_profiles', 'is_checkalt_enabled_for_tenant']);
  for (const name of gate('tenant')) {
    assert.match(defs[name].prosrc, /COALESCE\(public\.aws_can_access_tenant\(_tenant_id\), false\)/, name);
    assert.doesNotMatch(defs[name].prosrc, /has_role|is_tenant_member/, name);
  }
  for (const name of ['get_check_dashboard_counts_for_tenant', 'get_loss_draft_dashboard_counts_for_tenant', 'get_tenant_check_usage']) {
    assert.match(defs[name].prosrc, /IF NOT COALESCE\(public\.aws_can_access_tenant\(_tenant_id\), false\) THEN\s+RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';/, name);
  }
  const settlement = defs.get_check_claim_settlement.prosrc;
  assert.match(settlement, /IF user_belongs_to_tenant\(v_user, v_check\.tenant_id\) THEN/);
  assert.match(settlement, /AND user_belongs_to_tenant\(v_user, sc\.target_tenant_id\)/);
  assert.match(settlement, /ELSIF COALESCE\(public\.is_platform_owner\(\), false\) THEN/);
  assert.doesNotMatch(settlement, /has_role/);
  assert.match(defs.has_permission.prosrc, /IF _user_id IS DISTINCT FROM auth\.uid\(\) AND NOT COALESCE\(public\.is_platform_owner\(\), false\) THEN\s+RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';/);
  const stuck = defs.get_stuck_checks.prosrc;
  assert.match(stuck, /v_owner := COALESCE\(public\.is_platform_owner\(\), false\);/);
  assert.match(stuck, /WHERE v_owner OR c\.tenant_id IN \(SELECT public\.aws_user_tenant_ids\(\)\)/);
  assert.match(defs.get_check_unread_counts.prosrc, /HAVING COALESCE\(public\.aws_can_access_check\(m\.check_id\), false\);/);
  // Reads only: no function writes a table.
  for (const name of NAMES) assert.doesNotMatch(defs[name].prosrc, /\b(UPDATE|INSERT INTO|DELETE FROM)\s+(public\.)?[a-z_]+/, name);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, SQL126_FUNCTIONS.map((fn) => ({
    identity: fn.identity, acl: [...FOR_CHECKSOPS], revokes: [...REVOKES], ...(fn.result ? { result: fn.result } : {}),
  })));
  // The TABLE (...) results are stated; the file's RETURNS clause gives only TABLE.
  for (const fn of SQL126_FUNCTIONS) assert.equal(defs[fn.name].result === 'table', Boolean(fn.result), fn.name);
  // The file's ACL statements: PUBLIC revoked from all thirteen, anon / authenticated / service_role
  // where they exist, checksops granted on all thirteen, nothing else.
  const code = TEXT.replace(/--[^\n]*/g, '');
  for (const identity of SQL126_IDENTITIES) {
    assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`), identity);
    assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION ${identity} TO checksops;`), identity);
    assert.ok(code.includes(`        '${identity}'`), identity);
  }
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, SQL126_IDENTITIES.length);
  assert.match(code, /FOREACH grantee IN ARRAY ARRAY\['anon', 'authenticated', 'service_role'\] LOOP\s+IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = grantee\) THEN/);
  assert.match(code, /EXECUTE format\('REVOKE ALL ON FUNCTION %s FROM %I', fn, grantee\);/);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bALTER\s+(TABLE|VIEW|FUNCTION)\b/i,
    /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  // Every object the file's own prerequisite block names is a spec prerequisite, then role checksops.
  const prereqBlock = TEXT.slice(TEXT.indexOf('DO $sql126_prereq$'), TEXT.indexOf('$sql126_prereq$;'));
  const fileObjects = [...prereqBlock.matchAll(/\('([^']+)', to_reg/g)].map((m) => m[1]);
  assert.equal(fileObjects.length, 40);
  assert.deepEqual(fileObjects.slice(0, SQL126_IDENTITIES.length), SQL126_IDENTITIES);
  assert.match(prereqBlock, /WHERE rolname = 'checksops'/);
  assert.deepEqual(spec.prerequisites, [...fileObjects, 'role checksops']);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'dropped_functions', 'whole_tables', 'counts',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'definer_writes']) {
    assert.equal(spec[absent], undefined, absent);
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, SQL126_IDENTITIES);
  assert.deepEqual(scope.skip_relations, []);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.equal(text.split('\n')[0], 'release sql126 v1');
  assert.equal(text.split('\n').length, 1 + SQL126_IDENTITIES.length);
  assert.match(text, /\nfunction public\.get_stuck_checks\(\): lang=plpgsql vol=v parallel=u secdef=true result=TABLE\(id uuid, claim_id uuid, status text, amount numeric, carrier_name text, payee_line text, created_at timestamp with time zone, updated_at timestamp with time zone, hours_in_status numeric, sla_hours integer, is_overdue boolean\) config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(text, /\nfunction public\.get_tenant_check_usage\(uuid, timestamp with time zone, timestamp with time zone\): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(text, /\nfunction public\.get_check_unread_counts\(\): lang=sql vol=s parallel=u secdef=true result=TABLE\(check_id uuid, unread_count bigint, last_message_at timestamp with time zone\) config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE$/);

  // Pre-conditions: the function's owner, its result, an EXECUTE grant the file would not revoke.
  const restored = restoredState();
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], functions: {} };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const live = (identity, over = {}) => ({ ...restored.functions[identity], owner_is_login: true, ...over });
  const all = (over = {}) => Object.fromEntries(SQL126_IDENTITIES.map((identity) => [identity, live(identity, over)]));
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ functions: all() }), []);
  assert.deepEqual(pre({ prerequisites_missing: ['public.has_permission(uuid, text)'] }), ['prerequisites_present']);
  const KPIS = 'public.get_deposit_ops_kpis()';
  const USERS = 'public.get_tenant_users_with_profiles(uuid)';
  assert.deepEqual(pre({ functions: { ...all(), [KPIS]: live(KPIS, { acl: [...REVOKES, 'checksops EXECUTE', 'owner EXECUTE'] }) } }), []);
  assert.deepEqual(pre({ functions: { ...all(), [KPIS]: live(KPIS, { acl: ['owner EXECUTE', 'reporting EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { ...all(), [KPIS]: live(KPIS, { acl: ['PUBLIC EXECUTE with grant option', 'owner EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { ...all(), [USERS]: live(USERS, { owner_is_login: false }) } }), ['functions_owned_by_login']);
  assert.deepEqual(pre({ functions: { ...all(), [USERS]: live(USERS, { result: 'SETOF record' }) } }), ['function_results_match']);
  // Post-conditions: the intended fingerprint with every function owned by the login.
  const after = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: Object.fromEntries(SQL126_IDENTITIES.map((identity) => [identity, { exists: true, owner_is_login: true }])),
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after({ live_definition_sha256: 'f'.repeat(64) }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 126 through the executor: the restored state as derived; refused while a function is missing, owned by another role or granted beyond the revoked roles; a pending pin cannot apply; one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, 'pg-sql126-exec-', 59680, { extra: definerReadsSchema() });
  const { connectAs } = fx;
  try {
    const seen = [];
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const inspect = async () => {
      seen.length = 0;
      const result = await handlerFor(connect)(inspectEvent());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      return result.details.receipt;
    };
    const apply = async (live) => {
      const pin = Object.freeze({ ...PINS[KEY], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
      return handlerFor(connect, { pins: { [KEY]: pin } })(releaseEvent({ pin }));
    };
    const bodies = async () => (await fx.admin.query(`SELECT p.proname, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS h
      FROM pg_catalog.pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`, [SQL126_IDENTITIES])).rows;
    const restoredBodies = SQL126_FUNCTIONS.map((fn) => ({ proname: fn.name, h: sha(supabaseFunctionBody(fn.name)) })).sort((a, b) => a.proname.localeCompare(b.proname));

    // The restored state: the supabase bodies, EXECUTE PUBLIC and the owner; the inspect's
    // fingerprint is the one derived from those bytes.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, releaseStateHash(KEY, restoredState()));
    assert.deepEqual(r.release_sql_inspect.functions.map((f) => f.state), SQL126_IDENTITIES.map(() => 'different'));
    assert.deepEqual(r.release_sql_inspect.function_acl.map((f) => f.acl), SQL126_IDENTITIES.map(() => [...RESTORED_ACL]));
    assert.deepEqual(await bodies(), restoredBodies);

    // A function missing: refused, nothing applied.
    await fx.admin.query('ALTER FUNCTION public.has_permission(uuid, text) RENAME TO has_permission_moved');
    const missing = await inspect();
    assert.deepEqual(missing.release_sql_inspect.prerequisites_missing, ['public.has_permission(uuid, text)']);
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER FUNCTION public.has_permission_moved(uuid, text) RENAME TO has_permission');

    // A function owned by another role: refused, nothing applied.
    await fx.admin.query('ALTER FUNCTION public.get_check_claim_settlement(uuid) OWNER TO ubuntu');
    const foreign = await inspect();
    assert.deepEqual(foreign.precondition_failures, ['functions_owned_by_login'], JSON.stringify(foreign.release_sql_inspect));
    assert.equal((await apply(foreign.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER FUNCTION public.get_check_claim_settlement(uuid) OWNER TO checksops_admin');

    // EXECUTE for a role the file does not revoke: refused (it would survive), nothing applied.
    await fx.admin.query('CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION public.get_deposit_ops_kpis() TO reporting');
    const granted = await inspect();
    assert.deepEqual(granted.precondition_failures, ['function_acl_replaceable'], JSON.stringify(granted.release_sql_inspect));
    assert.equal((await apply(granted.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('REVOKE EXECUTE ON FUNCTION public.get_deposit_ops_kpis() FROM reporting; DROP ROLE reporting');
    assert.deepEqual(await bodies(), restoredBodies);

    // EXECUTE for authenticated, anon and checksops (the roles the file revokes or keeps): allowed.
    await fx.admin.query(`GRANT EXECUTE ON FUNCTION public.get_check_unread_counts() TO authenticated, anon;
      GRANT EXECUTE ON FUNCTION public.get_tenant_users_with_profiles(uuid) TO checksops`);
    const wider = await inspect();
    assert.deepEqual(wider.precondition_failures, [], JSON.stringify(wider.release_sql_inspect));
    assert.notEqual(wider.live_definition_sha256, r.live_definition_sha256);
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: wider.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.deepEqual(await bodies(), restoredBodies);

    const applied = await apply(wider.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, wider.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(await bodies(), SQL126_FUNCTIONS.map((fn) => ({ proname: fn.name, h: sha(sql126Body(fn.name)) }))
      .sort((a, b) => a.proname.localeCompare(b.proname)));
    // The results PostgreSQL renders are the ones the spec states.
    const rendered = (await fx.admin.query(`SELECT p.proname, pg_catalog.pg_get_function_result(p.oid) AS result
      FROM pg_catalog.pg_proc p WHERE p.oid = ANY($1::regprocedure[])`, [SQL126_IDENTITIES])).rows;
    for (const fn of SQL126_FUNCTIONS.filter((f) => f.result)) {
      assert.equal(rendered.find((row) => row.proname === fn.name).result, fn.result, fn.name);
    }
    const acl = (await fx.admin.query(`SELECT p.proname, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
        has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
      FROM pg_catalog.pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`, [SQL126_IDENTITIES])).rows;
    for (const row of acl) assert.deepEqual([row.owner, row.prosecdef, row.checksops, row.authenticated, row.anon], ['checksops_admin', true, true, false, false], row.proname);
    assert.equal((await apply(wider.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
