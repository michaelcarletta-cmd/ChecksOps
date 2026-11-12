/**
 * SQL 161 (aws/workflows/sql/161_tg_mortgage_handling_billing_checksops_execute.sql) in the staging guarded executor, on
 * the release engine shared with SQL 90-160 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-12: "A new
 * SQL 161 that gives staging that one permission, then SQL 160". release-sql90-97-executor.test.mjs runs what every release
 * key shares (SQL 161 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 52) from staging read-live run 43315046187, code-derived, selectable, packed, in step with the pending
 *     production pin; the pinned commit authored the bytes; no predecessor; nothing names SQL 161; SQL 160's spec is
 *     unchanged and its ACL for the function is SQL 161's intended ACL without grantors;
 *   - the spec's one acl_functions entry (SQL 161 creates or replaces no function): the fingerprint is the function's
 *     EXECUTE ACL with grantors, PUBLIC, checksops and the owner; revokes []; staging's expected pre-state (PUBLIC and
 *     the owner, SQL 160's staging read-live run 43307779123) and production's (the intended state: the observed ACL in
 *     billing-trigger-inspect.json) derived here; the unrelated snapshot skips the function and the post-conditions
 *     require the rest of it unchanged;
 *   - the file: one guard block, then one GRANT to checksops, nothing else;
 *   - on PostgreSQL 16 (a stub with the live attributes and staging's ACL): the inspect reads staging's pre-state as
 *     derived; an extra grantee or an entry from another grantor refuses; a pending pin cannot apply; an unexpected
 *     pre-state is refused (DEPLOYMENT_COLLISION); one apply through the executor reaches the intended fingerprint with the
 *     body, owner and attributes unchanged; then the database is in production's expected state: read-live reports
 *     already_applied true, a second apply is refused (UNRELATED_MUTATION), a pin recording the intended state as its
 *     pre-state cannot be bound (INVALID_MANIFEST) and the file itself is a no-op.
 * The grant itself is aws/tests/sql161-tg-mortgage-handling-billing-checksops-execute-pg.test.mjs.
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
  AUTHORIZED_SQL161_TG_MORTGAGE_HANDLING_BILLING_CHECKSOPS_EXECUTE,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  RELEASE_STAGING_SQL_KEYS,
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
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-12T18:00:00.000Z';
const KEY = 'sql161';
const FN = 'public.tg_record_mortgage_handling_billing()';
const INTENDED_ACL = Object.freeze(['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner']);
const STAGING_ACL = Object.freeze(['PUBLIC EXECUTE grantor=owner', 'owner EXECUTE grantor=owner']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The state the inspect reads where the function exists with `acl` (derived from the spec). */
const preState = (acl) => {
  const state = releaseIntendedState(KEY, TEXT);
  state.acl_functions[FN].acl = [...acl];
  return state;
};
/** Staging (SQL 160's read-live, run 43307779123): PUBLIC and the owner. Production (observed): PUBLIC, checksops and the owner. */
const STAGING_PRE = releaseStateHash(KEY, preState(STAGING_ACL));
const PRODUCTION_PRE = releaseStateHash(KEY, preState(INTENDED_ACL));

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
    expiry: '2026-11-12T19:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql161-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 161 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor; nothing names it; SQL 160 unchanged', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL161_TG_MORTGAGE_HANDLING_BILLING_CHECKSOPS_EXECUTE, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/161_tg_mortgage_handling_billing_checksops_execute.sql');
  assert.equal(pin.migration_id, '161_tg_mortgage_handling_billing_checksops_execute');
  assert.equal(spec.choice, 'sql161-tg-mortgage-handling-billing-checksops-execute');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-12) from staging read-live run 43315046187: already_applied false,
  // precondition_failures []. It read the derived staging pre-state (PUBLIC and the owner, grantor the owner).
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-12: staging apply (wave 52) from staging read-live run 43315046187');
  assert.equal(pin.expected_live_definition_sha256, STAGING_PRE);
  assert.equal(pin.expected_live_definition_sha256, '72031400264a910912cecd832ac0bf8486da7b67acfd036bc66aff6820258448');
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-161-apply.md'), 'utf8'), /\*\*Status:\*\* staging pin execute-authorized \(wave 52\); not applied anywhere\. The production pin is pending\./);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-161-apply.md'), 'utf8'), /read-live \(2026-11-12\)\.\*\* Run 43315046187/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Production's expected state is the intended one; staging's differs by checksops EXECUTE; everything absent is a third.
  assert.equal(PRODUCTION_PRE, pin.intended_replacement_sha256);
  assert.notEqual(STAGING_PRE, pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, {}), STAGING_PRE);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the staging pre-state and intended fingerprint (derived here), the source and the wave.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-161-apply.md'), 'utf8');
  for (const value of [STAGING_PRE, pin.intended_replacement_sha256, pin.source_sha256, 'wave 52', '43307779123']) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, preState(STAGING_ACL))}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql161-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [FN]);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.acl_functions.map((fn) => fn.identity), [FN]);
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['runs_before', 'supersedes', 'refuse_after', 'production_only', 'production_noop', 'attributes']) assert.equal(spec[absent], undefined, absent);
  // Nothing in the release refuses after SQL 161, supersedes it or needs it as a predecessor (SQL 160 included).
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // Of the other release migrations only SQL 160 names the function (CREATE OR REPLACE, its ACL kept): SQL 160's ACL
  // for it is SQL 161's intended ACL without grantors, the one production holds.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...other.functions.map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.ok(!touched.includes(FN) || key === 'sql160', key);
  }
  const sql160 = RELEASE_SQL_SPECS.sql160.functions.find((fn) => fn.identity === FN);
  assert.deepEqual(sql160.acl, INTENDED_ACL.map((line) => line.replace(/ grantor=owner$/, '')));
  assert.deepEqual(sql160.revokes, []);
  assert.deepEqual(RELEASE_SQL_SPECS.sql160.predecessors, []);
  const observed = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/billing-trigger-inspect.json'), 'utf8')).production_inspect.observed_functions[FN];
  assert.equal(observed.owner, 'checksops_admin');
  assert.deepEqual(observed.execute_acl.map((line) => `${line.replace(/^checksops_admin /, 'owner ')} grantor=owner`), [...INTENDED_ACL]);
  assert.match(observed.execute_acl_detail, /grantor checksops_admin/);
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [FN]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'GRANT_CHECKSOPS_EXECUTE_ON_MORTGAGE_HANDLING_TRIGGER_FUNCTION');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
  for (const note of [prod.production_inspect.note, prod.order_note]) {
    assert.ok(note.includes(PRODUCTION_PRE));
    assert.ok(note.includes(STAGING_PRE));
  }
  assert.ok(prod.staging_acceptance.basis.includes(STAGING_PRE));
  assert.ok(prod.intended_post_state.note.includes(pin.intended_replacement_sha256));
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

test('reviewed file and spec: one guard and one GRANT to checksops, nothing else; the fingerprint is the ACL with grantors (PUBLIC, checksops and the owner); the rest of the function must not change', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const statements = TEXT.replace(/--[^\n]*/g, '').replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, ['DO $body$', `GRANT EXECUTE ON FUNCTION ${FN} TO checksops`]);
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.match(code, /sql161_function_missing/);
  assert.match(code, /sql161_role_missing/);
  assert.match(code, /USING ERRCODE = '42883'/);
  assert.match(code, /USING ERRCODE = '42704'/);
  assert.equal([...code.matchAll(/\bDO\s+\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 1);
  for (const forbidden of [/\bREVOKE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bCOMMENT\b/i, /\bCREATE\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i,
    /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /\bauthenticated\b/, /\bWITH GRANT OPTION\b/i,
    /record_check_billing_event|accrue_mortgage_ops_billing|earn_mortgage_agent_compensation/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.acl_functions, [{ identity: FN, acl: [...INTENDED_ACL], revokes: [] }]);
  assert.deepEqual(spec.render, { grantors: true });
  assert.deepEqual(spec.prerequisites, [FN, 'role checksops']);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'production_noop', 'added_columns', 'altered_relations', 'definer_writes', 'dropped_triggers', 'extra_preconditions']) {
    assert.equal(spec[absent], undefined, absent);
  }
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.functions, {});
  assert.deepEqual(intended.acl_functions, { [FN]: { exists: true, acl: [...INTENDED_ACL] } });
  assert.deepEqual(releaseStateText(KEY, intended).split('\n'), [
    'release sql161 v1',
    `function_acl ${FN}: acl=PUBLIC EXECUTE grantor=owner;checksops EXECUTE grantor=owner;owner EXECUTE grantor=owner`,
  ]);
  assert.deepEqual(releaseStateText(KEY, {}).split('\n'), ['release sql161 v1', `function_acl ${FN}: absent`]);
  assert.deepEqual(releaseStateText(KEY, preState(STAGING_ACL)).split('\n'), [
    'release sql161 v1',
    `function_acl ${FN}: acl=PUBLIC EXECUTE grantor=owner;owner EXECUTE grantor=owner`,
  ]);
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [FN]);
  for (const field of ['skip_relations', 'acl_relations', 'skip_columns', 'skip_constraints', 'skip_policies', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }

  // Pre-conditions: staging's and production's ACLs pass (each a subset of the kept ACL); a missing or foreign-owned
  // function, another grantee, an entry from another grantor or with grant option, and lines without grantors refuse.
  const fnState = (over = {}) => ({ exists: true, owner_is_login: true, language: 'plpgsql', volatility: 'v', parallel: 'u', security_definer: true, result: 'trigger', config: ['search_path=public'], prosrc_sha256: 'a'.repeat(64), acl: [...INTENDED_ACL], ...over });
  const base = { prerequisites_missing: [], predecessors: {}, predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {} };
  const pre = (row, over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over, acl_functions: { [FN]: row } }, TEXT);
  assert.deepEqual(pre(fnState({ acl: [...STAGING_ACL] })), []);
  assert.deepEqual(pre(fnState()), []);
  assert.deepEqual(pre(fnState({ acl: ['owner EXECUTE grantor=owner'] })), []);
  assert.deepEqual(pre({ exists: false }), ['acl_functions_present']);
  assert.deepEqual(pre(fnState(), { prerequisites_missing: [FN] }), ['prerequisites_present']);
  assert.deepEqual(pre(fnState({ owner_is_login: false })), ['acl_functions_owned_by_login']);
  assert.deepEqual(pre(fnState({ acl: ['authenticated EXECUTE grantor=owner', ...STAGING_ACL] })), ['acl_functions_acl_replaceable']);
  assert.deepEqual(pre(fnState({ acl: ['PUBLIC EXECUTE grantor=checksops', 'owner EXECUTE grantor=owner'] })), ['acl_functions_acl_replaceable']);
  assert.deepEqual(pre(fnState({ acl: ['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE with grant option grantor=owner', 'owner EXECUTE grantor=owner'] })), ['acl_functions_acl_replaceable']);
  assert.deepEqual(pre(fnState({ acl: ['PUBLIC EXECUTE', 'owner EXECUTE'] })), ['acl_functions_acl_replaceable'], 'lines without grantors are not this spec\'s');
  // Post-conditions: the intended fingerprint with everything but the ACL as before; a body, owner or attribute change refuses.
  const pin = PINS[KEY];
  const st = (row) => ({ live_definition_sha256: pin.intended_replacement_sha256, acl_functions: { [FN]: row } });
  const before = st(fnState({ acl: [...STAGING_ACL] }));
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState()), pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState({ prosrc_sha256: 'b'.repeat(64) })), pin), ['acl_functions_otherwise_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState({ owner_is_login: false })), pin), ['acl_functions_otherwise_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState({ security_definer: false })), pin), ['acl_functions_otherwise_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, { ...st(fnState()), live_definition_sha256: STAGING_PRE }, pin), ['intended_state']);
});

/** The function's owner, attributes, body hash and EXECUTE grantees. */
async function functionState(admin) {
  const { rows } = await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile,
      pg_catalog.pg_get_function_result(p.oid) AS result, pg_catalog.md5(p.prosrc) AS body,
      ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
              FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1) AS execute
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1)`, [FN]);
  return rows[0];
}

test('PostgreSQL 16: SQL 161 through the executor from staging\'s ACL: the pre-state as derived; another grantee or grantor refused; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint with the rest unchanged; then already in place (production\'s expected state)', { timeout: 600000 }, async (t) => {
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
  // The live attributes with staging's explicit ACL (PUBLIC and the owner); the fixture then hands it to checksops_admin.
  const fx = await releaseFixture(pg, 'pg-sql161-exec-', 59461, {
    extra: [`CREATE FUNCTION ${FN} RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$ BEGIN RETURN NEW; END $f$;
REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC;`],
  });
  const { admin, connectAs } = fx;
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

    // Staging's pre-state: PUBLIC and the owner, each granted by the owner.
    const states0 = await functionState(admin);
    assert.deepEqual(states0.execute, ['PUBLIC', 'checksops_admin']);
    const stg = await inspect();
    assert.deepEqual(stg.precondition_failures, [], JSON.stringify(stg.release_sql_inspect));
    assert.deepEqual(stg.release_sql_inspect.prerequisites_missing, []);
    assert.equal(stg.already_applied, false);
    // The committed staging pin is authorized on exactly this pre-state (wave 52, read-live run 43315046187).
    assert.equal(stg.pin_executable, true);
    assert.equal(stg.live_definition_sha256, STAGING_PRE);
    assert.deepEqual(stg.release_sql_inspect.functions, []);
    assert.deepEqual(stg.release_sql_inspect.acl_functions, [{ name: FN.replace('public.', ''), state: 'different', acl: [...STAGING_ACL] }]);

    // EXECUTE for another role (the file would neither keep nor revoke it).
    await admin.query(`CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION ${FN} TO reporting`);
    const granted = await inspect();
    assert.deepEqual(granted.precondition_failures, ['acl_functions_acl_replaceable'], JSON.stringify(granted.release_sql_inspect));
    assert.equal((await apply(granted.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM reporting; DROP ROLE reporting`);
    // An entry granted by another role is not the owner's.
    await admin.query('BEGIN');
    try {
      await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO checksops WITH GRANT OPTION`);
      await admin.query('SET LOCAL ROLE checksops');
      await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO authenticated`);
      await admin.query('RESET ROLE');
      const state = (await readReleaseSqlState(admin, KEY)).details;
      assert.ok(releaseSharedPreconditionFailures(KEY, state, TEXT).includes('acl_functions_acl_replaceable'));
    } finally {
      await admin.query('ROLLBACK');
    }
    assert.equal((await inspect()).live_definition_sha256, STAGING_PRE);

    // A pending pin cannot apply: a pending copy of the committed pin (no recorded pre-state, not executable).
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: STAGING_PRE });
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }));
    assert.equal(pending.ok, false);
    assert.equal(pending.code, CODES.GUARD_APPLY_FORBIDDEN);
    // An unexpected pre-state (the owner as the only grantee, derived here) refuses on staging's, nothing applied.
    const OWNER_ONLY_PRE = releaseStateHash(KEY, preState(['owner EXECUTE grantor=owner']));
    assert.notEqual(OWNER_ONLY_PRE, STAGING_PRE);
    const unexpected = await apply(OWNER_ONLY_PRE);
    assert.equal(unexpected.ok, false, JSON.stringify(unexpected));
    assert.equal(unexpected.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(await functionState(admin), states0);

    // From staging's pre-state: one apply on the intended fingerprint; checksops added, nothing else changed.
    const applied = await apply(STAGING_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, STAGING_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(applied.details.receipt.release_sql_inspect.acl_functions, [{ name: FN.replace('public.', ''), state: 'intended', acl: [...INTENDED_ACL] }]);
    const states1 = await functionState(admin);
    assert.deepEqual(states1.execute, ['PUBLIC', 'checksops', 'checksops_admin']);
    assert.deepEqual({ ...states1, execute: null }, { ...states0, execute: null });

    // Now the database is in production's expected state: read-live says already applied, an apply is refused before
    // the file runs, a pin recording the intended state as its pre-state cannot be bound, and the file is a no-op.
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.apply_preconditions_met, false);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PRODUCTION_PRE);
    assert.equal((await apply(STAGING_PRE)).code, CODES.UNRELATED_MUTATION);
    const asIntended = await apply(PRODUCTION_PRE);
    assert.equal(asIntended.code, CODES.INVALID_MANIFEST);
    assert.match(asIntended.message, /intended replacement hash must differ from the expected live definition hash/);
    const owner = await connectAs('checksops_admin');
    try { await owner.query(TEXT); } finally { await owner.end(); }
    assert.deepEqual(await functionState(admin), states1);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
