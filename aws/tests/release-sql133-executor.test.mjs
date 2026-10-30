/**
 * SQL 133 (aws/workflows/sql/133_financial_totp_admin_reset_enrollment.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-132 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 133 included); this
 * file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the production pin (pending
 *     too); the pinned commit authored the bytes; no predecessor; nothing supersedes or names it;
 *   - the file and spec: one new function, financial_totp_admin_reset_enrollment(uuid, uuid): plpgsql,
 *     VOLATILE, SECURITY DEFINER, search_path public, pg_temp, the TABLE result, the caller check, the
 *     self, teammate and platform-owner gates (the API's own SQL), the one DELETE, no secret returned;
 *     the prerequisite DO block, then REVOKE ALL FROM PUBLIC and GRANT EXECUTE TO checksops, nothing
 *     else; the spec's prerequisites, the four definer relations; the pre- and post-conditions;
 *   - on PostgreSQL 16 (the proposed file loaded on the release fixture): the inspect reads the
 *     pre-state both databases have (the function absent) as derived here; refused while the
 *     enrollment table is missing or any of the four relations is under FORCE ROW LEVEL SECURITY; a
 *     pending pin cannot apply; an unexpected pre-state is refused (DEPLOYMENT_COLLISION); one apply
 *     through the executor reaches the intended fingerprint (EXECUTE for checksops and the owner),
 *     then a second apply is refused (UNRELATED_MUTATION: already in place).
 * The behavior (the gates, the deletion, PUBLIC denied) is
 * aws/tests/sql133-financial-totp-admin-reset-pg.test.mjs.
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
  AUTHORIZED_SQL133_FINANCIAL_TOTP_ADMIN_RESET_ENROLLMENT,
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-30T12:00:00.000Z';
const KEY = 'sql133';
const IDENTITY = 'public.financial_totp_admin_reset_enrollment(uuid, uuid)';
const TABLE = 'public.financial_totp_enrollments';
const READ_TABLES = Object.freeze(['public.tenant_users', 'public.identity_accounts', 'public.profiles']);
const RELATIONS = Object.freeze([TABLE, ...READ_TABLES]);
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const PROPOSED_REL = 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql';
const REVOKE = `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`;
const GRANT = `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, PROPOSED_REL), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases have: the function absent (everything else present). */
const ABSENT_PRE = releaseStateHash(KEY, { functions: { [IDENTITY]: { exists: false } } });

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
    expiry: '2026-10-30T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql133-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 133 pending, code-derived, selectable, packed, in step with the production pin; no predecessor; nothing names it', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL133_FINANCIAL_TOTP_ADMIN_RESET_ENROLLMENT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/133_financial_totp_admin_reset_enrollment.sql');
  assert.equal(pin.migration_id, '133_financial_totp_admin_reset_enrollment');
  assert.equal(spec.choice, 'sql133-financial-totp-admin-reset-enrollment');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // The pre-state (the function absent) has a fingerprint of its own, and renders as absent.
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.equal(ABSENT_PRE, releaseStateHash(KEY, {}));
  assert.deepEqual(releaseStateText(KEY, { functions: { [IDENTITY]: { exists: false } } }).split('\n'), ['release sql133 v1', `function ${IDENTITY}: absent`]);
  // The runbook and the production pin name the expected pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-133-apply.md'), 'utf8');
  assert.ok(runbook.includes(ABSENT_PRE));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.ok(runbook.includes(pin.source_sha256));
  assert.ok(runbook.includes(sha(releaseFunctionDefinitions(TEXT).financial_totp_admin_reset_enrollment.prosrc)));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql133-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [IDENTITY]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  // No predecessor (SQL 133 calls none of SQL 130, 131 or 132's functions); nothing supersedes, refuses after or depends on it.
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['runs_before', 'supersedes', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces, drops or re-grants the function.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...other.functions.map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.ok(!touched.includes(IDENTITY), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(ABSENT_PRE));
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

test('reviewed file and spec: one new DEFINER function that re-checks the API gate and deletes the row; the prerequisite block, REVOKE ALL FROM PUBLIC and GRANT EXECUTE TO checksops, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['financial_totp_admin_reset_enrollment']);
  const def = defs.financial_totp_admin_reset_enrollment;
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'table');
  assert.deepEqual(def.config, ['search_path=public, pg_temp']);
  assert.match(def.prosrc, /IF p_actor_user_id IS NULL OR p_target_user_id IS NULL THEN\s+RAISE EXCEPTION 'invalid_reset'\s+USING ERRCODE = '22023'/);
  assert.match(def.prosrc, /IF p_actor_user_id IS DISTINCT FROM auth\.uid\(\) THEN\s+RAISE EXCEPTION 'enrollment_caller_mismatch'\s+USING ERRCODE = '42501'/);
  assert.match(def.prosrc, /IF p_actor_user_id = p_target_user_id THEN\s+RAISE EXCEPTION 'cannot_reset_own_totp'\s+USING ERRCODE = '42501'/);
  // The API's RESET_TOTP_TEAMMATE_SQL (the tenant_users self-join, the role column not read) and
  // RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL (identity or profile email), as the database's own gate.
  assert.match(def.prosrc, /FROM public\.tenant_users mine\s+JOIN public\.tenant_users theirs ON theirs\.tenant_id = mine\.tenant_id\s+WHERE mine\.user_id = p_actor_user_id\s+AND theirs\.user_id = p_target_user_id/);
  assert.match(def.prosrc, /RAISE EXCEPTION 'reset_target_not_teammate'\s+USING ERRCODE = '42501'/);
  assert.doesNotMatch(def.prosrc.replace(/--[^\n]*/g, ''), /\brole\b/, 'the stored role is not read (comments aside)');
  assert.match(def.prosrc, /FROM public\.identity_accounts ia\s+WHERE ia\.application_user_id = p_target_user_id\s+AND lower\(ia\.email\) = 'checksopsadmin@gmail\.com'/);
  assert.match(def.prosrc, /FROM public\.profiles p\s+WHERE p\.id = p_target_user_id\s+AND lower\(p\.email\) = 'checksopsadmin@gmail\.com'/);
  assert.match(def.prosrc, /RAISE EXCEPTION 'platform_owner_protected'\s+USING ERRCODE = '42501'/);
  assert.equal([...def.prosrc.matchAll(/\bDELETE\b/g)].length, 1, 'one DELETE: the target row');
  assert.match(def.prosrc, /DELETE FROM public\.financial_totp_enrollments AS e\s+WHERE e\.application_user_id = p_target_user_id;/);
  assert.doesNotMatch(def.prosrc, /ciphertext|nonce|key_id|last_used_timestep|verified_at|enrolled_at|failed_attempts|locked_until/, 'never reads or returns the secret, a counter or a timestamp');
  assert.doesNotMatch(def.prosrc, /\b(INSERT|UPDATE|TRUNCATE)\b/);
  // The API calls the function this way, and checks for it first.
  const call = 'SELECT cleared FROM public.financial_totp_admin_reset_enrollment($1::uuid, $2::uuid)';
  const presentCall = 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present';
  const api = fs.readFileSync(path.join(ROOT, 'aws/functions/api/admin-reset-totp.mjs'), 'utf8');
  assert.ok(api.includes(call));
  assert.ok(api.includes(presentCall));
  assert.ok(api.includes(`'${IDENTITY}'`));

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{
    identity: IDENTITY, result: 'TABLE(cleared boolean)', acl: [...ACL], revokes: ['PUBLIC EXECUTE'],
  }]);
  assert.deepEqual(spec.prerequisites, [
    ...RELATIONS, 'auth.uid()', 'role checksops',
    `column ${TABLE}.application_user_id`,
    'column public.tenant_users.tenant_id', 'column public.tenant_users.user_id',
    'column public.identity_accounts.application_user_id', 'column public.identity_accounts.email',
    'column public.profiles.id', 'column public.profiles.email',
  ]);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, one CREATE OR REPLACE FUNCTION, then exactly the REVOKE and the GRANT on it.
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.equal([...code.matchAll(/\bDO\s+\$sql133_prereq\$/g)].length, 1);
  assert.match(code, /sql133_prerequisite_missing/);
  assert.match(code, /sql133_definer_cannot_reach/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  const tail = code.slice(code.indexOf('$$;') + 3).trim().split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(tail, [REVOKE, GRANT]);
  assert.equal([...code.matchAll(/\bREVOKE\b/g)].length, 1);
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 1);
  assert.equal([...code.matchAll(/\bDELETE\s+FROM\b/g)].length, 1, 'the function body\'s DELETE is the only one');
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bBEGIN\s*;/i, /\bCOMMIT\b/,
    /financial_totp_(upsert_enrollment|get_enrollment|mark_verified|status|count_code_check)\b/, /consume_financial_totp_rate_limit/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [IDENTITY]);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql133 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=TABLE(cleared boolean) config=search_path=public, pg_temp prosrc=${sha(def.prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: the function absent passes; any of the four relations unreachable or missing refuses;
  // an existing function owned by another role, with another grant or another result refuses; PUBLIC is revocable.
  const definer = Object.fromEntries(RELATIONS.map((table) => [table, true]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {}, definer };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (acl, over = {}) => ({ functions: { [IDENTITY]: { ...releaseIntendedState(KEY, TEXT).functions[IDENTITY], owner_is_login: true, acl: [...acl], ...over } } });
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ functions: { [IDENTITY]: { exists: false } } }), []);
  for (const table of RELATIONS) {
    assert.deepEqual(pre({ definer: { ...definer, [table]: false } }), ['definer_can_write_relations'], table);
    assert.ok(pre({ prerequisites_missing: [table] }).includes('prerequisites_present'), table);
  }
  assert.deepEqual(pre(fn(ACL)), []);
  assert.deepEqual(pre(fn(['PUBLIC EXECUTE', ...ACL])), []);
  assert.deepEqual(pre(fn([...ACL, 'authenticated EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(ACL, { result: 'boolean' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: ABSENT_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 133 through the executor: the pre-state as derived; refused while the enrollment table is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql133-exec-', 60350);
  const { connectAs } = fx;
  try {
    // The proposed file as both databases have it (owned by checksops_admin); tenant_users, identity_accounts
    // and profiles are the fixture's, owned by checksops_admin like everything else in schema public.
    await fx.admin.query(PROPOSED);
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
    const present = async () => (await fx.admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;
    const executeAcl = async () => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    const allOk = RELATIONS.map((table) => ({ name: table.replace(/^public\./, ''), ok: true }));

    // The pre-state both databases have: the function absent, every prerequisite present, every relation reachable.
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, {});
    assert.deepEqual(pre.release_sql_inspect.definer_writes, allOk);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, ABSENT_PRE);
    assert.equal(await present(), false);

    // Any of the four relations under FORCE ROW LEVEL SECURITY (the DEFINER owner could not reach it): refused, nothing applied.
    for (const table of RELATIONS) {
      await fx.admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      const forced = await inspect();
      assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
      assert.deepEqual(forced.release_sql_inspect.definer_writes, allOk.map((row) => (row.name === table.replace(/^public\./, '') ? { ...row, ok: false } : row)), table);
      assert.equal((await apply(ABSENT_PRE)).code, CODES.DEPLOYMENT_COLLISION, table);
      assert.equal(await present(), false, table);
      await fx.admin.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    }
    assert.deepEqual((await inspect()).precondition_failures, []);

    // The enrollment table missing: refused, nothing applied.
    await fx.admin.query(`ALTER TABLE ${TABLE} RENAME TO financial_totp_enrollments_moved`);
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes(TABLE), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(`ALTER TABLE public.financial_totp_enrollments_moved RENAME TO financial_totp_enrollments`);
    assert.deepEqual((await inspect()).precondition_failures, []);
    assert.equal(await present(), false);

    // A pending pin cannot apply (the committed pin is pending; pend a copy with the pre-state recorded).
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT_PRE });
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }));
    assert.equal(pending.ok, false);
    assert.equal(await present(), false);

    // An unexpected pre-state: a pin recording the intended state as the pre-state is not a valid
    // authorization package (the two hashes must differ); a pin recording a hash the database does not
    // show refuses on the live state (DEPLOYMENT_COLLISION). Nothing applied either way.
    const onIntended = await apply(PINS[KEY].intended_replacement_sha256);
    assert.equal(onIntended.ok, false, JSON.stringify(onIntended));
    assert.equal(onIntended.code, CODES.INVALID_MANIFEST);
    assert.equal(await present(), false);
    const unknown = await apply('f'.repeat(64));
    assert.equal(unknown.ok, false, JSON.stringify(unknown));
    assert.equal(unknown.code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await present(), false);
    assert.equal((await inspect()).live_definition_sha256, ABSENT_PRE);

    // One apply on the intended fingerprint: the function exists, owned by the login, EXECUTE for checksops and the owner.
    const applied = await apply(ABSENT_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((fn) => fn.state), ['intended']);
    assert.deepEqual(after.release_sql_inspect.function_acl, [{ name: 'financial_totp_admin_reset_enrollment(uuid, uuid)', acl: [...ACL] }]);
    assert.equal(await present(), true);
    assert.deepEqual(await executeAcl(), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(ABSENT_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
