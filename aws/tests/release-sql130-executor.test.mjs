/**
 * SQL 130 (aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql) in the staging
 * guarded executor, on the release engine shared with SQL 90-129 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 130 included); this
 * file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor; it supersedes the retired SQL 129;
 *   - the file and spec: consume_financial_totp_rate_limit(uuid, text, integer, integer) replaced with
 *     SQL 129's body (the proposed financial TOTP file's with only the action allow-list changed);
 *     plpgsql, VOLATILE, SECURITY DEFINER, search_path public, pg_temp, the TABLE result; EXECUTE
 *     revoked from PUBLIC and granted to checksops, nothing else; the ACL after is checksops and the
 *     owner; both pre-states (production: PUBLIC, checksops, owner; staging: checksops, owner) pass the
 *     pre-conditions and anything else granted refuses;
 *   - on PostgreSQL 16 (the proposed file loaded): the inspect reads the production pre-state (PUBLIC
 *     granted) and the staging pre-state (PUBLIC revoked) as derived here from the proposed file's
 *     bytes; refused while the function is missing, owned by another role or granted to another role;
 *     a pending pin cannot apply; an unexpected pre-state is refused (DEPLOYMENT_COLLISION); from each pre-state one apply
 *     through the executor reaches the same intended fingerprint, then a second apply is refused
 *     (UNRELATED_MUTATION: already in place).
 * The behavior (code_check accepted and limited per user and action; PUBLIC denied) is
 * aws/tests/sql130-financial-totp-rate-limit-pg.test.mjs.
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
  AUTHORIZED_SQL130_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK_NO_PUBLIC,
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
const KEY = 'sql130';
const IDENTITY = 'public.consume_financial_totp_rate_limit(uuid, text, integer, integer)';
const PRODUCTION_ACL = Object.freeze(['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
const STAGING_ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const PROPOSED_REL = 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql';
const SQL129_REL = 'aws/workflows/sql/129_financial_totp_rate_limit_code_check.sql';
const OLD_ALLOW_LIST = "NOT IN ('enroll_start', 'enroll_confirm', 'step_up')";
const NEW_ALLOW_LIST = "NOT IN ('enroll_start', 'enroll_confirm', 'step_up', 'code_check')";
const REVOKE = `REVOKE EXECUTE ON FUNCTION ${IDENTITY} FROM PUBLIC;`;
const GRANT = `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, PROPOSED_REL), 'utf8');
const SQL129 = fs.readFileSync(path.join(ROOT, SQL129_REL), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const proposedBody = () => releaseFunctionDefinitions(PROPOSED).consume_financial_totp_rate_limit.prosrc;

/**
 * The state the inspect reads where the proposed file's function is live with `acl` (derived from
 * the proposed file's bytes). Production (read-only inspect 2026-10-30, SSM cfee4512): PUBLIC,
 * checksops and the owner. Staging (SQL 129's read-live, run 41081764481): checksops and the owner.
 */
const preState = (acl) => {
  const state = releaseIntendedState(KEY, PROPOSED);
  state.functions[IDENTITY].acl = [...acl];
  return state;
};
const PRODUCTION_PRE = releaseStateHash(KEY, preState(PRODUCTION_ACL));
const STAGING_PRE = releaseStateHash(KEY, preState(STAGING_ACL));

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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql130-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 130 pending, code-derived, selectable, packed, in step with the production pin; no predecessor; supersedes the retired SQL 129', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL130_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK_NO_PUBLIC, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql');
  assert.equal(pin.migration_id, '130_financial_totp_rate_limit_code_check_no_public');
  assert.equal(spec.choice, 'sql130-financial-totp-rate-limit-code-check-no-public');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent and both pre-states have fingerprints of their own; the two pre-states differ only in PUBLIC.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.notEqual(PRODUCTION_PRE, pin.intended_replacement_sha256);
  assert.notEqual(STAGING_PRE, pin.intended_replacement_sha256);
  assert.notEqual(PRODUCTION_PRE, STAGING_PRE);
  // The pre-states' body is the one the production inspect read (prosrc equal to the proposed file's).
  assert.equal(preState(PRODUCTION_ACL).functions[IDENTITY].prosrc_sha256, sha(proposedBody()));
  assert.equal(sha(proposedBody()), '0507b4474de7fb03ac843f44c2ad7bd06f603620905ab58b550d3b4e379b4d24');
  // The staging pre-state is the one SQL 129's read-live (run 41081764481) read, under the sql130 key:
  // the same objects give SQL 129's recorded hash under the sql129 key.
  const under129 = releaseIntendedState('sql129', PROPOSED);
  under129.functions[IDENTITY].acl = [...STAGING_ACL];
  assert.equal(releaseStateHash('sql129', under129), '1b805d53c7a00f90bf4341045b21f25893b3ddf2f56dd51b9a48ee2045a04bb7');
  under129.functions[IDENTITY].acl = [...PRODUCTION_ACL];
  assert.equal(releaseStateHash('sql129', under129), '37d945da85fb51e1cf532806171c1477f8d3701e2e41ed3aa259f54c7baf97b2');
  // The runbook and the production pin name both expected pre-states (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-130-apply.md'), 'utf8');
  assert.ok(runbook.includes(PRODUCTION_PRE));
  assert.ok(runbook.includes(STAGING_PRE));
  assert.ok(runbook.includes(sha(proposedBody())));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.ok(runbook.includes(pin.source_sha256));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql130-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [IDENTITY]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  // It supersedes SQL 129 (the same function; retired, never applied, its pins never executable).
  assert.deepEqual(spec.supersedes, ['sql129']);
  assert.equal(PINS.sql129.execute, false);
  assert.match(PINS.sql129.authorization, /^Retired 2026-10-30: superseded by SQL 130/);
  assert.equal(PINS.sql129.expected_live_definition_sha256, null);
  assert.equal(pin.superseded_intended_sha256, undefined);
  for (const absent of ['runs_before', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration but the retired SQL 129 creates, replaces, drops or re-grants the function.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY && k !== 'sql129')) {
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
  assert.ok(JSON.stringify(prod.production_inspect).includes(PRODUCTION_PRE));
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

test('reviewed file and spec: SQL 129\'s body; same header; EXECUTE revoked from PUBLIC and granted to checksops, nothing else; both pre-states accepted; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['consume_financial_totp_rate_limit']);
  const def = defs.consume_financial_totp_rate_limit;
  const live = releaseFunctionDefinitions(PROPOSED).consume_financial_totp_rate_limit;
  const sql129 = releaseFunctionDefinitions(SQL129).consume_financial_totp_rate_limit;
  // The body: exactly SQL 129's, which is the proposed file's with the allow-list edit (matching once).
  assert.deepEqual(def, sql129);
  assert.equal(proposedBody().split(OLD_ALLOW_LIST).length, 2);
  assert.equal(def.prosrc, proposedBody().replace(OLD_ALLOW_LIST, NEW_ALLOW_LIST));
  // The CREATE OR REPLACE statement is byte-for-byte SQL 129's.
  const create = (text) => text.slice(text.indexOf('CREATE OR REPLACE FUNCTION'), text.indexOf('$$;') + 3);
  assert.equal(create(TEXT), create(SQL129));
  for (const field of ['language', 'volatility', 'parallel', 'security_definer', 'result', 'config']) assert.deepEqual(def[field], live[field], field);
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'table');
  assert.deepEqual(def.config, ['search_path=public, pg_temp']);
  assert.match(def.prosrc, /IF p_user_id IS DISTINCT FROM auth\.uid\(\) THEN/);
  assert.match(def.prosrc, /ON CONFLICT \(user_id, action\)/);
  const api = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8');
  assert.match(api, /export const TOTP_CODE_CHECK_RATE_ACTION = 'code_check';/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{
    identity: IDENTITY, result: 'TABLE(allowed boolean, count integer, retry_after_seconds integer)', acl: [...STAGING_ACL], revokes: ['PUBLIC EXECUTE'],
  }]);
  // One CREATE OR REPLACE FUNCTION, then exactly the REVOKE from PUBLIC and the GRANT to checksops on this function.
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  const after = code.slice(code.indexOf('$$;') + 3).trim().split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(after, [REVOKE, GRANT]);
  assert.equal([...code.matchAll(/\bREVOKE\b/g)].length, 1);
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 1);
  for (const forbidden of [/\bDROP\b/i, /\bALTER\b/i, /\bCOMMENT\b/i, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /\bDO\s+\$/, /\bfinancial_totp_(upsert|get|mark|status)/]) {
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
    'release sql130 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=TABLE(allowed boolean, count integer, retry_after_seconds integer) config=search_path=public, pg_temp prosrc=${sha(def.prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);
  // SQL 129's intended state differs only in PUBLIC.
  assert.equal(text.replace('release sql130 v1', '').replace('acl=checksops', 'acl=PUBLIC EXECUTE;checksops'),
    releaseStateText('sql129', releaseIntendedState('sql129', SQL129)).replace('release sql129 v1', ''));

  // Pre-conditions: both environments' ACLs pass; the owner, the result and any other EXECUTE grant refuse.
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {} };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (acl, over = {}) => ({ functions: { [IDENTITY]: { ...preState(acl).functions[IDENTITY], owner_is_login: true, ...over } } });
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre(fn(PRODUCTION_ACL)), []);
  assert.deepEqual(pre(fn(STAGING_ACL)), []);
  assert.deepEqual(pre(fn(['owner EXECUTE'])), []);
  assert.deepEqual(pre({ prerequisites_missing: ['public.financial_totp_rate_limits'] }), ['prerequisites_present']);
  assert.deepEqual(pre(fn([...PRODUCTION_ACL, 'reporting EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn([...STAGING_ACL, 'authenticated EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(STAGING_ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(PRODUCTION_ACL, { result: 'boolean' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: PRODUCTION_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 130 through the executor: both pre-states as derived; refused while the function is missing, owned by another role or granted to another role; a pending pin and an unexpected pre-state cannot apply; from each pre-state one apply on the same intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql130-exec-', 60050);
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
    const executeAcl = async () => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    // Back to the live definition (the proposed body) as the superuser, keeping owner and ACL.
    const restoreLiveBody = async () => {
      const create = TEXT.slice(TEXT.indexOf('CREATE OR REPLACE FUNCTION'), TEXT.indexOf('$$;') + 3);
      await fx.admin.query(create.replace(NEW_ALLOW_LIST, OLD_ALLOW_LIST));
    };
    const liveBody = sha(proposedBody());
    const intendedBody = sha(proposedBody().replace(OLD_ALLOW_LIST, NEW_ALLOW_LIST));

    // Production's pre-state: the proposed body, EXECUTE for PUBLIC, checksops and the owner.
    const prod = await inspect();
    assert.deepEqual(prod.precondition_failures, [], JSON.stringify(prod.release_sql_inspect));
    assert.deepEqual(prod.release_sql_inspect.prerequisites_missing, []);
    assert.equal(prod.already_applied, false);
    assert.equal(prod.live_definition_sha256, PRODUCTION_PRE);
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

    // EXECUTE for another role (the file would neither keep nor revoke it): refused, nothing applied.
    await fx.admin.query(`CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION ${IDENTITY} TO reporting`);
    const granted = await inspect();
    assert.deepEqual(granted.precondition_failures, ['function_acl_replaceable'], JSON.stringify(granted.release_sql_inspect));
    assert.equal((await apply(granted.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(`REVOKE EXECUTE ON FUNCTION ${IDENTITY} FROM reporting; DROP ROLE reporting`);
    assert.equal((await inspect()).live_definition_sha256, PRODUCTION_PRE);

    // A pending pin cannot apply.
    const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: PRODUCTION_PRE }));
    assert.equal(pending.ok, false);
    assert.equal(await body(), liveBody);

    // An unexpected pre-state: a pin recording staging's pre-state refuses on production's, nothing applied.
    const unexpected = await apply(STAGING_PRE);
    assert.equal(unexpected.ok, false, JSON.stringify(unexpected));
    assert.equal(unexpected.code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await body(), liveBody);
    assert.equal((await inspect()).live_definition_sha256, PRODUCTION_PRE);

    // From production's pre-state: one apply on the intended fingerprint; PUBLIC gone.
    const fromProduction = await apply(PRODUCTION_PRE);
    assert.equal(fromProduction.ok, true, JSON.stringify(fromProduction));
    assert.equal(fromProduction.details.receipt.before_hash, PRODUCTION_PRE);
    assert.equal(fromProduction.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const afterProduction = await inspect();
    assert.equal(afterProduction.already_applied, true);
    assert.equal(afterProduction.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(afterProduction.precondition_failures, []);
    assert.equal(await body(), intendedBody);
    assert.deepEqual(await executeAcl(), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(PRODUCTION_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(afterProduction.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);

    // Staging's pre-state: the proposed body, EXECUTE for checksops and the owner (no PUBLIC).
    await restoreLiveBody();
    assert.equal(await body(), liveBody);
    const stag = await inspect();
    assert.deepEqual(stag.precondition_failures, [], JSON.stringify(stag.release_sql_inspect));
    assert.equal(stag.already_applied, false);
    assert.equal(stag.live_definition_sha256, STAGING_PRE);
    assert.deepEqual((await executeAcl()).execute, ['checksops', 'checksops_admin']);
    // A pin recording production's pre-state refuses here, nothing applied.
    assert.equal((await apply(PRODUCTION_PRE)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await body(), liveBody);

    // From staging's pre-state: one apply on the same intended fingerprint.
    const fromStaging = await apply(STAGING_PRE);
    assert.equal(fromStaging.ok, true, JSON.stringify(fromStaging));
    assert.equal(fromStaging.details.receipt.before_hash, STAGING_PRE);
    assert.equal(fromStaging.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const afterStaging = await inspect();
    assert.equal(afterStaging.already_applied, true);
    assert.equal(afterStaging.live_definition_sha256, afterProduction.live_definition_sha256);
    assert.equal(await body(), intendedBody);
    assert.deepEqual(await executeAcl(), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });
    assert.equal((await apply(STAGING_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
