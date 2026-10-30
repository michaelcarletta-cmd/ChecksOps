/**
 * SQL 129 (aws/workflows/sql/129_financial_totp_rate_limit_code_check.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-128 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 129 included); this
 * file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: consume_financial_totp_rate_limit(uuid, text, integer, integer) replaced,
 *     its body the proposed financial TOTP file's (the live definition) with only the action
 *     allow-list changed; plpgsql, VOLATILE, SECURITY DEFINER, search_path public, pg_temp, the
 *     TABLE result; EXECUTE as production has it (PUBLIC, checksops, the owner) and nothing
 *     revoked or granted; no other statement; the ownership, result and ACL pre-conditions refuse;
 *   - on PostgreSQL 16 (the proposed file loaded, EXECUTE for PUBLIC as in production): the
 *     inspect reads the pre-state derived here from the proposed file's bytes; refused while the
 *     function is missing, owned by another role or granted to another role; without the PUBLIC
 *     grant the apply misses the intended fingerprint and rolls back; a pending pin cannot apply;
 *     one apply through the executor reaches the intended fingerprint, then is refused as already
 *     in place.
 * The behavior (code_check accepted and limited per user and action) is
 * aws/tests/sql129-financial-totp-rate-limit-pg.test.mjs.
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
  AUTHORIZED_SQL129_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK,
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
import { assertStagingPinState } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-30T12:00:00.000Z';
const KEY = 'sql129';
const IDENTITY = 'public.consume_financial_totp_rate_limit(uuid, text, integer, integer)';
const PRODUCTION_ACL = Object.freeze(['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
const PROPOSED_REL = 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql';
const OLD_ALLOW_LIST = "NOT IN ('enroll_start', 'enroll_confirm', 'step_up')";
const NEW_ALLOW_LIST = "NOT IN ('enroll_start', 'enroll_confirm', 'step_up', 'code_check')";
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, PROPOSED_REL), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const proposedBody = () => releaseFunctionDefinitions(PROPOSED).consume_financial_totp_rate_limit.prosrc;

/**
 * The state the inspect reads where the proposed file's function is live with production's EXECUTE
 * ACL (read-only production inspect 2026-10-30, SSM cfee4512: prosrc equal to the proposed file's;
 * EXECUTE for PUBLIC, checksops and the owner). Derived from the proposed file's bytes.
 */
const liveState = () => releaseIntendedState(KEY, PROPOSED);

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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql129-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 129 pending, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL129_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/129_financial_totp_rate_limit_code_check.sql');
  assert.equal(pin.migration_id, '129_financial_totp_rate_limit_code_check');
  assert.equal(spec.choice, 'sql129-financial-totp-rate-limit-code-check');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent, and the live (proposed-file) state, each have a fingerprint of their own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, liveState()), pin.intended_replacement_sha256);
  // The live state's body is the one the production inspect read (prosrc equal to the proposed file's).
  assert.equal(liveState().functions[IDENTITY].prosrc_sha256, sha(proposedBody()));
  // The runbook and the production pin name the expected pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-129-apply.md'), 'utf8');
  assert.ok(runbook.includes(releaseStateHash(KEY, liveState())));
  assert.ok(runbook.includes(sha(proposedBody())));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.ok(runbook.includes(pin.source_sha256));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql129-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [IDENTITY]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
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
  assert.ok(JSON.stringify(prod.production_inspect).includes(releaseStateHash(KEY, liveState())));
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

test('reviewed file and spec: the live body with only the allow-list changed; same header; EXECUTE as production has it, nothing granted or revoked; no other statement; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['consume_financial_totp_rate_limit']);
  const def = defs.consume_financial_totp_rate_limit;
  const live = releaseFunctionDefinitions(PROPOSED).consume_financial_totp_rate_limit;
  // The body: exactly the proposed file's with the allow-list edit (matching once).
  assert.equal(proposedBody().split(OLD_ALLOW_LIST).length, 2);
  assert.equal(def.prosrc, proposedBody().replace(OLD_ALLOW_LIST, NEW_ALLOW_LIST));
  assert.notEqual(def.prosrc, proposedBody());
  for (const field of ['language', 'volatility', 'parallel', 'security_definer', 'result', 'config']) assert.deepEqual(def[field], live[field], field);
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  // The parser reads the TABLE result as 'table'; the spec states it (function_results_match).
  assert.equal(def.result, 'table');
  assert.deepEqual(def.config, ['search_path=public, pg_temp']);
  // The caller check, the bounds and the per-user, per-action counter are the live ones.
  assert.match(def.prosrc, /IF p_user_id IS DISTINCT FROM auth\.uid\(\) THEN/);
  assert.match(def.prosrc, /ON CONFLICT \(user_id, action\)/);
  assert.match(def.prosrc, /p_limit < 1 OR p_limit > 100/);
  assert.match(def.prosrc, /p_window_seconds < 1 OR p_window_seconds > 3600/);
  // The API's action is the one added.
  const api = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8');
  assert.match(api, /export const TOTP_CODE_CHECK_RATE_ACTION = 'code_check';/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{
    identity: IDENTITY, result: 'TABLE(allowed boolean, count integer, retry_after_seconds integer)', acl: [...PRODUCTION_ACL], revokes: [],
  }]);
  // One CREATE OR REPLACE FUNCTION, nothing else.
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  for (const forbidden of [/\bGRANT\b/i, /\bREVOKE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bCOMMENT\b/i, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /\bDO\s+\$/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.deepEqual(spec.prerequisites, [
    IDENTITY, 'public.financial_totp_rate_limits', 'role checksops',
    ...['user_id', 'action', 'window_started_at', 'request_count'].map((c) => `column public.financial_totp_rate_limits.${c}`),
  ]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'definer_writes', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [IDENTITY]);
  assert.deepEqual(scope.skip_relations, []);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql129 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=TABLE(allowed boolean, count integer, retry_after_seconds integer) config=search_path=public, pg_temp prosrc=${sha(def.prosrc)} acl=PUBLIC EXECUTE;checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: the function's owner, its result, an EXECUTE grant outside PUBLIC, checksops and the owner.
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {} };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (over = {}) => ({ functions: { [IDENTITY]: { ...liveState().functions[IDENTITY], owner_is_login: true, ...over } } });
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre(fn()), []);
  assert.deepEqual(pre({ prerequisites_missing: ['public.financial_totp_rate_limits'] }), ['prerequisites_present']);
  assert.deepEqual(pre(fn({ acl: [...PRODUCTION_ACL, 'reporting EXECUTE'] })), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn({ owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn({ result: 'boolean' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const after = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after({ live_definition_sha256: 'f'.repeat(64) }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 129 through the executor: the live state as derived; refused while the function is missing, owned by another role or granted to another role; without PUBLIC the apply rolls back; a pending pin cannot apply; one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql129-exec-', 59795);
  const { connectAs } = fx;
  try {
    // The proposed file as production has it: owned by checksops_admin, EXECUTE also for PUBLIC.
    await fx.admin.query(PROPOSED);
    await fx.admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO PUBLIC`);
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
    const body = async () => (await fx.admin.query(`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS h
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0]?.h;
    const liveBody = sha(proposedBody());

    // The live state: the proposed body, EXECUTE for PUBLIC, checksops and the owner; the
    // inspect's fingerprint is the one derived from the proposed file's bytes.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, releaseStateHash(KEY, liveState()));
    assert.equal(await body(), liveBody);

    // The function missing: refused, nothing applied.
    await fx.admin.query(`ALTER FUNCTION ${IDENTITY} RENAME TO consume_financial_totp_rate_limit_moved`);
    const missing = await inspect();
    assert.deepEqual(missing.release_sql_inspect.prerequisites_missing, [IDENTITY]);
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER FUNCTION public.consume_financial_totp_rate_limit_moved(uuid, text, integer, integer) RENAME TO consume_financial_totp_rate_limit');

    // Owned by another role: refused, nothing applied.
    await fx.admin.query(`ALTER FUNCTION ${IDENTITY} OWNER TO ubuntu`);
    const foreign = await inspect();
    assert.deepEqual(foreign.precondition_failures, ['functions_owned_by_login'], JSON.stringify(foreign.release_sql_inspect));
    assert.equal((await apply(foreign.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(`ALTER FUNCTION ${IDENTITY} OWNER TO checksops_admin`);

    // EXECUTE for another role: refused, nothing applied.
    await fx.admin.query(`CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION ${IDENTITY} TO reporting`);
    const granted = await inspect();
    assert.deepEqual(granted.precondition_failures, ['function_acl_replaceable'], JSON.stringify(granted.release_sql_inspect));
    assert.equal((await apply(granted.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(`REVOKE EXECUTE ON FUNCTION ${IDENTITY} FROM reporting; DROP ROLE reporting`);

    // Without PUBLIC EXECUTE (a database where it was revoked): the inspect passes, but the file
    // keeps the ACL, so the apply misses the intended fingerprint and rolls back.
    await fx.admin.query(`REVOKE EXECUTE ON FUNCTION ${IDENTITY} FROM PUBLIC`);
    const narrower = await inspect();
    assert.deepEqual(narrower.precondition_failures, [], JSON.stringify(narrower.release_sql_inspect));
    assert.notEqual(narrower.live_definition_sha256, r.live_definition_sha256);
    const missed = await apply(narrower.live_definition_sha256);
    assert.equal(missed.ok, false, JSON.stringify(missed));
    assert.equal(await body(), liveBody);
    assert.equal((await inspect()).live_definition_sha256, narrower.live_definition_sha256);
    await fx.admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO PUBLIC`);
    assert.equal((await inspect()).live_definition_sha256, r.live_definition_sha256);

    // A pending pin cannot apply.
    const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.equal(await body(), liveBody);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(await body(), sha(proposedBody().replace(OLD_ALLOW_LIST, NEW_ALLOW_LIST)));
    const acl = (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    assert.deepEqual(acl, { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['PUBLIC', 'checksops', 'checksops_admin'] });
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
