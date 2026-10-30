/**
 * SQL 131 (aws/workflows/sql/131_financial_totp_functions_no_public.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-130 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 131 included); this
 * file covers what is new:
 *
 *   - the pin: pending (execute false, no recorded pre-state: staging read as already in the intended
 *     state, run 41107844336, so no staging apply), code-derived, selectable, packed, in step with the
 *     production pin (execute true on production's own pre-state, derived from the spec); the pinned
 *     commit authored the bytes; predecessor SQL 130 (applied to both databases); nothing names SQL 131;
 *   - the spec's four acl_functions entries (SQL 131 creates or replaces no function): the
 *     fingerprint is the four EXECUTE ACLs with grantors, checksops and the owner on each; the
 *     unrelated snapshot skips the four and the post-conditions require the rest of each unchanged;
 *   - the file: one guard block, then one REVOKE from PUBLIC and one GRANT to checksops per
 *     function, nothing else; it never names consume_financial_totp_rate_limit;
 *   - on PostgreSQL 16 (the proposed financial TOTP file loaded, SQL 130 applied as the owner,
 *     EXECUTE also for PUBLIC as production has it): refused until SQL 130 is in place; the inspect
 *     reads the production pre-state derived here; the file refuses a missing function (55000) and a
 *     login that does not own them (42501); the engine refuses a missing, foreign-owned or
 *     otherwise-granted function and an entry from another grantor; a pending pin cannot apply; an
 *     unexpected pre-state is refused (DEPLOYMENT_COLLISION); one apply through the executor
 *     reaches the intended fingerprint with bodies, owners and the fifth function unchanged; then
 *     the database is in staging's expected state: read-live reports already_applied true, a second
 *     apply is refused (UNRELATED_MUTATION: already in place) and the file itself is a no-op.
 * The behavior (right people can, wrong people can't) is aws/tests/sql131-financial-totp-functions-pg.test.mjs.
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
  AUTHORIZED_SQL131_FINANCIAL_TOTP_FUNCTIONS_NO_PUBLIC,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  readReleaseSqlState,
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
const NOW = '2026-10-30T18:00:00.000Z';
const KEY = 'sql131';
const IDENTITIES = Object.freeze([
  'public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)',
  'public.financial_totp_get_enrollment(uuid)',
  'public.financial_totp_mark_verified(uuid, bigint)',
  'public.financial_totp_status(uuid)',
]);
const CONSUME = 'public.consume_financial_totp_rate_limit(uuid, text, integer, integer)';
const INTENDED_ACL = Object.freeze(['checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner']);
const PRODUCTION_ACL = Object.freeze(['PUBLIC EXECUTE grantor=owner', ...INTENDED_ACL]);
const PROPOSED_REL = 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, PROPOSED_REL), 'utf8');
const SQL130 = fs.readFileSync(path.join(ROOT, PINS.sql130.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/**
 * The state the inspect reads where the four functions exist with `acl` each (derived from the
 * spec). Production (read-only financial TOTP live inspect 2026-10-30, SSM cfee4512): PUBLIC,
 * checksops and the owner. Staging (expected: the proposed-file load revoked PUBLIC): checksops and
 * the owner, which is the intended state.
 */
const preState = (acl) => {
  const state = releaseIntendedState(KEY, TEXT);
  for (const identity of IDENTITIES) state.acl_functions[identity].acl = [...acl];
  return state;
};
const PRODUCTION_PRE = releaseStateHash(KEY, preState(PRODUCTION_ACL));
const STAGING_PRE = releaseStateHash(KEY, preState(INTENDED_ACL));

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
    expiry: '2026-10-30T19:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql131-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 131 pending, code-derived, selectable, packed, in step with the production pin; predecessor SQL 130 (applied in both databases); nothing names it', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL131_FINANCIAL_TOTP_FUNCTIONS_NO_PUBLIC, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/131_financial_totp_functions_no_public.sql');
  assert.equal(pin.migration_id, '131_financial_totp_functions_no_public');
  assert.equal(spec.choice, 'sql131-financial-totp-functions-no-public');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  // Staging's expected state is the intended one; production's differs by PUBLIC on each function;
  // everything absent is a third.
  assert.equal(STAGING_PRE, pin.intended_replacement_sha256);
  assert.notEqual(PRODUCTION_PRE, pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, {}), PRODUCTION_PRE);
  // The runbook and the production pin name the expected production pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-131-apply.md'), 'utf8');
  assert.ok(runbook.includes(PRODUCTION_PRE));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.ok(runbook.includes(pin.source_sha256));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql131-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...IDENTITIES]);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.acl_functions.map((fn) => fn.identity), [...IDENTITIES]);
  // Predecessor SQL 130: applied to staging (wave 28) and production (2026-10-30), so predecessors_applied is true in both.
  assert.deepEqual(spec.predecessors, ['sql130']);
  assert.equal(PINS.sql130.execute, true);
  assert.match(PINS.sql130.authorization, /^Owner approved 2026-10-30: staging apply \(wave 28\)/);
  const prod130 = JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS.sql130.production_pin_rel), 'utf8'));
  assert.equal(prod130.applied.result, 'applied');
  assert.equal(prod130.applied.receipt.after_hash, PINS.sql130.intended_replacement_sha256);
  for (const absent of ['runs_before', 'supersedes', 'refuse_after', 'attributes']) assert.equal(spec[absent], undefined, absent);
  // Nothing in the release refuses after SQL 131, supersedes it or needs it as a predecessor.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces, drops or re-grants the four functions; SQL 131 never touches the fifth.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...other.functions.map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const identity of IDENTITIES) assert.ok(!touched.includes(identity), `${key} ${identity}`);
  }
  assert.ok(!IDENTITIES.includes(CONSUME));
  assert.deepEqual(RELEASE_SQL_SPECS.sql130.functions.map((fn) => fn.identity), [CONSUME]);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, ['sql130']);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-30) on the staging read-live
  // (already in the intended state there: the staging pin above stays pending). Its pre-state is production's
  // own (read-only inspect SSM be25e88a): the four with EXECUTE also for PUBLIC, derived here from the spec.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-30 /);
  assert.equal(prod.expected_live_definition_sha256, '99d9e8e925ca8c5b56e11409f145e2d75de2759c27d8fd1b476494ffc62e2eaa');
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(prod.expected_live_definition_sha256, STAGING_PRE);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.match(prod.staging_acceptance.reference, /\/actions\/runs\/41107844336$/);
  assert.equal(prod.applied, undefined);
  assert.ok(prod.production_inspect.note.includes(PRODUCTION_PRE));
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

test('reviewed file and spec: one guard, one REVOKE and one GRANT per function, nothing else; the fingerprint is the four ACLs with grantors (checksops and the owner); the rest of each function must not change', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const statements = TEXT.replace(/--[^\n]*/g, '').replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, [
    'DO $body$',
    ...IDENTITIES.flatMap((identity) => [`REVOKE EXECUTE ON FUNCTION ${identity} FROM PUBLIC`, `GRANT EXECUTE ON FUNCTION ${identity} TO checksops`]),
  ]);
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.match(code, /sql131_prerequisite_missing/);
  assert.match(code, /sql131_not_function_owner/);
  assert.match(code, /USING ERRCODE = '55000'/);
  assert.match(code, /USING ERRCODE = '42501'/);
  assert.equal([...code.matchAll(/\bDO\s+\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bREVOKE\b/g)].length, 4);
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 4);
  for (const forbidden of [/\bDROP\b/i, /\bALTER\b/i, /\bCOMMENT\b/i, /\bCREATE\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i,
    /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /consume_financial_totp_rate_limit/, /\bauthenticated\b/, /\bREVOKE ALL\b/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.acl_functions, IDENTITIES.map((identity) => ({ identity, acl: [...INTENDED_ACL], revokes: ['PUBLIC EXECUTE grantor=owner'] })));
  assert.deepEqual(spec.render, { grantors: true });
  assert.deepEqual(spec.prerequisites, [...IDENTITIES, 'role checksops']);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'production_noop', 'added_columns', 'altered_relations', 'definer_writes', 'dropped_triggers', 'extra_preconditions']) {
    assert.equal(spec[absent], undefined, absent);
  }
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.functions, {});
  assert.deepEqual(intended.acl_functions, Object.fromEntries(IDENTITIES.map((identity) => [identity, { exists: true, acl: [...INTENDED_ACL] }])));
  assert.deepEqual(releaseStateText(KEY, intended).split('\n'), [
    'release sql131 v1',
    ...IDENTITIES.map((identity) => `function_acl ${identity}: acl=checksops EXECUTE grantor=owner;owner EXECUTE grantor=owner`),
  ]);
  assert.deepEqual(releaseStateText(KEY, {}).split('\n'), ['release sql131 v1', ...IDENTITIES.map((identity) => `function_acl ${identity}: absent`)]);
  assert.deepEqual(releaseStateText(KEY, preState(PRODUCTION_ACL)).split('\n'), [
    'release sql131 v1',
    ...IDENTITIES.map((identity) => `function_acl ${identity}: acl=PUBLIC EXECUTE grantor=owner;checksops EXECUTE grantor=owner;owner EXECUTE grantor=owner`),
  ]);
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [...IDENTITIES]);
  for (const field of ['skip_relations', 'acl_relations', 'skip_columns', 'skip_constraints', 'skip_policies', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }

  // Pre-conditions: production's ACL and the intended ACL pass; a missing, foreign-owned or otherwise-granted
  // function, an entry from another grantor or with grant option, and SQL 130 not in place refuse.
  const fnState = (over = {}) => ({ exists: true, owner_is_login: true, language: 'plpgsql', volatility: 'v', parallel: 'u', security_definer: true, result: 'void', config: ['search_path=public, pg_temp'], prosrc_sha256: 'a'.repeat(64), acl: [...INTENDED_ACL], ...over });
  const all = (fn) => Object.fromEntries(IDENTITIES.map((identity) => [identity, typeof fn === 'function' ? fn(identity) : fn]));
  const base = { prerequisites_missing: [], predecessors: { sql130: true }, predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {} };
  const pre = (aclFunctions, over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over, acl_functions: aclFunctions }, TEXT);
  assert.deepEqual(pre(all(fnState({ acl: [...PRODUCTION_ACL] }))), []);
  assert.deepEqual(pre(all(fnState())), []);
  assert.deepEqual(pre(all(fnState({ acl: ['owner EXECUTE grantor=owner'] }))), []);
  // One function at production's ACL, the others already intended: still accepted (each converges).
  assert.deepEqual(pre(all((identity) => fnState({ acl: identity === IDENTITIES[0] ? [...PRODUCTION_ACL] : [...INTENDED_ACL] }))), []);
  assert.deepEqual(pre(all((identity) => (identity === IDENTITIES[2] ? { exists: false } : fnState()))), ['acl_functions_present']);
  assert.deepEqual(pre(all(fnState()), { prerequisites_missing: [IDENTITIES[1]] }), ['prerequisites_present']);
  assert.deepEqual(pre(all((identity) => fnState({ owner_is_login: identity !== IDENTITIES[3] }))), ['acl_functions_owned_by_login']);
  assert.deepEqual(pre(all(fnState({ acl: ['authenticated EXECUTE grantor=owner', ...INTENDED_ACL] }))), ['acl_functions_acl_replaceable']);
  assert.deepEqual(pre(all(fnState({ acl: ['PUBLIC EXECUTE grantor=checksops', ...INTENDED_ACL] }))), ['acl_functions_acl_replaceable']);
  assert.deepEqual(pre(all(fnState({ acl: ['checksops EXECUTE with grant option grantor=owner', 'owner EXECUTE grantor=owner'] }))), ['acl_functions_acl_replaceable']);
  assert.deepEqual(pre(all(fnState({ acl: ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'] }))), ['acl_functions_acl_replaceable'], 'lines without grantors are not this spec\'s');
  assert.deepEqual(pre(all(fnState({ acl: [...PRODUCTION_ACL] })), { predecessors: { sql130: false }, predecessors_applied: false }), ['predecessors_applied']);
  // Post-conditions: the intended fingerprint with everything but the ACL as before; a body or owner change is refused.
  const pin = PINS[KEY];
  const st = (fn) => ({ live_definition_sha256: pin.intended_replacement_sha256, acl_functions: all(fn) });
  const before = st(fnState({ acl: [...PRODUCTION_ACL] }));
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState()), pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st((identity) => fnState({ prosrc_sha256: identity === IDENTITIES[1] ? 'b'.repeat(64) : 'a'.repeat(64) })), pin), ['acl_functions_otherwise_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState({ owner_is_login: false })), pin), ['acl_functions_otherwise_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState({ security_definer: false })), pin), ['acl_functions_otherwise_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, { ...st(fnState()), live_definition_sha256: PRODUCTION_PRE }, pin), ['intended_state']);
});

/** Each of the four functions' owner, SECURITY DEFINER, config, body hash and EXECUTE grantees, plus the fifth function whole. */
async function functionStates(admin) {
  const rows = (await admin.query(`SELECT p.oid::regprocedure::text AS f, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile,
      pg_catalog.pg_get_function_result(p.oid) AS result, pg_catalog.md5(p.prosrc) AS body,
      (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
         FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE '%financial_totp%' ORDER BY 1`)).rows;
  return Object.fromEntries(rows.map((r) => [r.f, r]));
}
const withoutAcl = (states) => Object.fromEntries(Object.entries(states).map(([f, r]) => [f, { ...r, execute: null }]));

test('PostgreSQL 16: SQL 131 through the executor: refused until SQL 130 is in place; production\'s pre-state as derived and as recorded; the file\'s own refusals; a missing, foreign-owned, otherwise-granted or foreign-granted function refused; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint with bodies and the fifth function unchanged; then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql131-exec-', 60150);
  const { admin, connectAs } = fx;
  try {
    // The proposed file as production has it (owned by checksops_admin), with EXECUTE also for PUBLIC on the four.
    await admin.query(PROPOSED);
    for (const identity of IDENTITIES) await admin.query(`GRANT EXECUTE ON FUNCTION ${identity} TO PUBLIC`);
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
    const asOwner = async (sql) => {
      const owner = await connectAs('checksops_admin');
      try {
        await owner.query(sql);
      } finally {
        await owner.end();
      }
    };

    // Before SQL 130 (the proposed rate-limit body, PUBLIC granted on it too): the predecessor is not in place, so SQL 131 is refused.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${CONSUME} TO PUBLIC`);
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.predecessors, { sql130: false });
    assert.deepEqual(early.precondition_failures, ['predecessors_applied']);
    assert.equal(early.live_definition_sha256, PRODUCTION_PRE);
    assert.equal((await apply(PRODUCTION_PRE)).code, CODES.DEPLOYMENT_COLLISION);
    // SQL 130 applied as the owner (as both databases have it since 2026-10-30).
    await asOwner(SQL130);
    const states0 = await functionStates(admin);
    assert.deepEqual(states0[CONSUME.replace('public.', '').replace(/, /g, ',')].execute, ['checksops', 'checksops_admin']);

    // Production's pre-state: the four with EXECUTE for PUBLIC, checksops and the owner, each granted by the owner.
    const prod = await inspect();
    assert.deepEqual(prod.precondition_failures, [], JSON.stringify(prod.release_sql_inspect));
    assert.deepEqual(prod.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(prod.release_sql_inspect.predecessors, { sql130: true });
    assert.equal(prod.already_applied, false);
    assert.equal(prod.pin_executable, false);
    assert.equal(prod.live_definition_sha256, PRODUCTION_PRE);
    assert.deepEqual(prod.release_sql_inspect.functions, []);
    assert.deepEqual(prod.release_sql_inspect.acl_functions, IDENTITIES.map((identity) => ({ name: identity.replace('public.', ''), state: 'different', acl: [...PRODUCTION_ACL] })));
    // The production pin's recorded pre-state (read-only inspect of 2026-10-30, SSM be25e88a) is this value,
    // which its earlier note named before any run read it.
    assert.ok(productionPin().production_inspect.note.includes(prod.live_definition_sha256));
    assert.equal(productionPin().expected_live_definition_sha256, prod.live_definition_sha256);
    assert.equal(productionPin().production_inspect.live_definition_sha256, prod.live_definition_sha256);

    // The file refuses a login that does not own the functions (the superuser here) ...
    await admin.query('BEGIN');
    try {
      await assert.rejects(admin.query(TEXT), (e) => e.code === '42501' && /sql131_not_function_owner/.test(e.message));
    } finally {
      await admin.query('ROLLBACK');
    }
    // ... and a missing function.
    await admin.query('BEGIN');
    try {
      await admin.query(`DROP FUNCTION ${IDENTITIES[3]}`);
      await assert.rejects(admin.query(TEXT), (e) => e.code === '55000' && /sql131_prerequisite_missing: missing public\.financial_totp_status\(uuid\)/.test(e.message));
    } finally {
      await admin.query('ROLLBACK');
    }
    const unchangedAfterRefusals = await functionStates(admin);
    assert.deepEqual(unchangedAfterRefusals, states0);

    // The engine: a missing function (the file would refuse too).
    await admin.query(`ALTER FUNCTION ${IDENTITIES[1]} RENAME TO financial_totp_get_enrollment_moved`);
    const missing = await inspect();
    assert.deepEqual(missing.release_sql_inspect.prerequisites_missing, [IDENTITIES[1]]);
    assert.deepEqual(missing.precondition_failures, ['prerequisites_present', 'acl_functions_present']);
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('ALTER FUNCTION public.financial_totp_get_enrollment_moved(uuid) RENAME TO financial_totp_get_enrollment');
    // Owned by another role.
    await admin.query(`ALTER FUNCTION ${IDENTITIES[2]} OWNER TO ubuntu`);
    const foreign = await inspect();
    assert.deepEqual(foreign.precondition_failures, ['acl_functions_owned_by_login'], JSON.stringify(foreign.release_sql_inspect));
    assert.equal((await apply(foreign.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`ALTER FUNCTION ${IDENTITIES[2]} OWNER TO checksops_admin`);
    // EXECUTE for another role (the file would neither keep nor revoke it).
    await admin.query(`CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION ${IDENTITIES[0]} TO reporting`);
    const granted = await inspect();
    assert.deepEqual(granted.precondition_failures, ['acl_functions_acl_replaceable'], JSON.stringify(granted.release_sql_inspect));
    assert.equal((await apply(granted.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${IDENTITIES[0]} FROM reporting; DROP ROLE reporting`);
    // An entry granted by another role is not the owner's to revoke.
    await admin.query('BEGIN');
    try {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${IDENTITIES[3]} FROM checksops`);
      await admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITIES[3]} TO checksops WITH GRANT OPTION`);
      await admin.query('SET LOCAL ROLE checksops');
      await admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITIES[3]} TO PUBLIC`);
      await admin.query('RESET ROLE');
      const state = (await readReleaseSqlState(admin, KEY)).details;
      assert.ok(releaseSharedPreconditionFailures(KEY, state, TEXT).includes('acl_functions_acl_replaceable'));
      assert.notEqual(state.live_definition_sha256, PRODUCTION_PRE);
    } finally {
      await admin.query('ROLLBACK');
    }
    assert.equal((await inspect()).live_definition_sha256, PRODUCTION_PRE);

    // A pending pin cannot apply: the committed pin has no recorded pre-state.
    const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: PRODUCTION_PRE }));
    assert.equal(pending.ok, false);
    assert.equal(pending.code, CODES.SQL_COLLISION);
    assert.deepEqual(await functionStates(admin), states0);
    // An unexpected pre-state: a pin recording another accepted state (the owner as the only grantee, derived
    // here) refuses on production's, nothing applied.
    const OWNER_ONLY_PRE = releaseStateHash(KEY, preState(['owner EXECUTE grantor=owner']));
    assert.notEqual(OWNER_ONLY_PRE, PRODUCTION_PRE);
    const unexpected = await apply(OWNER_ONLY_PRE);
    assert.equal(unexpected.ok, false, JSON.stringify(unexpected));
    assert.equal(unexpected.code, CODES.DEPLOYMENT_COLLISION);
    // A pin recording the intended state (staging's expected state) as its pre-state is refused before
    // connecting: the executor requires the expected live hash to differ from the intended one
    // (sql-executor-auth.mjs: "intended replacement hash must differ from the expected live definition hash").
    const asIntended = await apply(STAGING_PRE);
    assert.equal(asIntended.ok, false, JSON.stringify(asIntended));
    assert.equal(asIntended.code, CODES.INVALID_MANIFEST);
    assert.match(asIntended.message, /intended replacement hash must differ from the expected live definition hash/);
    assert.deepEqual(await functionStates(admin), states0);

    // From production's pre-state: one apply on the intended fingerprint; PUBLIC gone from the four, nothing else changed.
    const applied = await apply(PRODUCTION_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRODUCTION_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(applied.details.receipt.release_sql_inspect.acl_functions, IDENTITIES.map((identity) => ({ name: identity.replace('public.', ''), state: 'intended', acl: [...INTENDED_ACL] })));
    const states1 = await functionStates(admin);
    assert.deepEqual(withoutAcl(states1), withoutAcl(states0), 'owner, SECURITY DEFINER, config, volatility, result and body of every financial_totp function as before');
    for (const identity of IDENTITIES) {
      const f = identity.replace('public.', '').replace(/, /g, ',');
      assert.deepEqual(states0[f].execute, ['PUBLIC', 'checksops', 'checksops_admin'], f);
      assert.deepEqual(states1[f].execute, ['checksops', 'checksops_admin'], f);
      assert.equal(states1[f].owner, 'checksops_admin', f);
      assert.equal(states1[f].prosecdef, true, f);
    }
    const consume = CONSUME.replace('public.', '').replace(/, /g, ',');
    assert.deepEqual(states1[consume], states0[consume], 'the fifth function (SQL 130) is untouched');

    // Now the database is in staging's expected state: read-live says already applied, an apply is refused
    // before the file runs, and the file itself is a no-op.
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.apply_preconditions_met, false);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.equal(after.live_definition_sha256, STAGING_PRE);
    assert.equal((await apply(PRODUCTION_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(OWNER_ONLY_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(STAGING_PRE)).code, CODES.INVALID_MANIFEST);
    await asOwner(TEXT);
    assert.deepEqual(await functionStates(admin), states1);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
