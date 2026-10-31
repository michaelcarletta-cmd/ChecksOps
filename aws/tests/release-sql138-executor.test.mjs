/**
 * SQL 138 (aws/workflows/sql/138_payee_setup_link_closed_after_verification.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-135 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 138 included); this file
 * covers what is new:
 *
 *   - the pin: pending (no read-live yet), code-derived, selectable, packed, in step with the pending
 *     production pin; the pinned commit authored the bytes; predecessor and supersedes SQL 113 (as SQL 101
 *     for SQL 90), with superseded_intended_sha256.sql113 derived from both files;
 *   - the file and spec: SQL 113's aws_public_payee_record(text, text, jsonb) only, with the same
 *     attributes, result and ACL and SQL 113's body plus the one verified_at check; the prerequisite DO
 *     block, then the REVOKE from PUBLIC, the GRANT to checksops and the COMMENT, nothing else; the expected
 *     pre-state (the function as SQL 113 left it) derived from SQL 113's bytes; the pre- and post-conditions;
 *   - on PostgreSQL 16 (the payee tables, SQL 113 applied as the owner): the read-live reads the derived
 *     pre-state; refused before SQL 113 and under FORCE ROW LEVEL SECURITY; a pending pin cannot apply;
 *     drift refuses; one apply through the executor reaches the intended fingerprint, then is refused as
 *     already in place; SQL 113 still reads applied through SQL 138 (supersedes), and only while its other
 *     objects match.
 * The behavior (a verified payee's link refused for every write, reads unchanged, unverified setup and
 * reissue unchanged) is aws/tests/sql138-payee-setup-link-closed-pg.test.mjs.
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
  AUTHORIZED_SQL138_PAYEE_SETUP_LINK_CLOSED_AFTER_VERIFICATION,
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
  releaseSupersededIntendedHash,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { PAYEE_SCHEMA, RECIPIENTS } from './helpers/sql113-payee-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-31T12:00:00.000Z';
const KEY = 'sql138';
const IDENTITY = 'public.aws_public_payee_record(text, text, jsonb)';
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKE = `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`;
const GRANT = `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`;
const CHECK = "IF rec.verified_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_verified'); END IF;";
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL113 = fs.readFileSync(path.join(ROOT, PINS.sql113.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases are expected to have: the function as SQL 113 left it. */
const SQL113_FN = releaseIntendedState('sql113', SQL113).functions[IDENTITY];
const PRE = releaseStateHash(KEY, { functions: { [IDENTITY]: SQL113_FN } });
const PRE_EXPECTED = 'ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c';

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const key = overrides.key || KEY;
  const pin = overrides.pin || PINS[key];
  const rest = { ...overrides };
  delete rest.pin;
  delete rest.key;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[key].choice}`,
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
    one_use_id: `${key}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-10-31T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key = KEY) => releaseEvent({ key, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql138-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 138 pending, code-derived, selectable, packed, in step with the pending production pin; predecessor and supersedes SQL 113', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL138_PAYEE_SETUP_LINK_CLOSED_AFTER_VERIFICATION, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/138_payee_setup_link_closed_after_verification.sql');
  assert.equal(pin.migration_id, '138_payee_setup_link_closed_after_verification');
  assert.equal(spec.choice, 'sql138-payee-setup-link-closed-after-verification');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '9acaf809824101d8ef62098e6440ca5d06cda1bec4117118c53931130efadf48');
  // The expected pre-state: SQL 113's function, derived from SQL 113's bytes (read back on PostgreSQL 16 below).
  assert.equal(PRE, PRE_EXPECTED);
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  // SQL 113 after SQL 138: every SQL 113 object, with the record function as SQL 138 renders it.
  assert.deepEqual(Object.keys(pin.superseded_intended_sha256), ['sql113']);
  assert.equal(releaseSupersededIntendedHash('sql113', SQL113, KEY, TEXT), pin.superseded_intended_sha256.sql113);
  assert.equal(pin.superseded_intended_sha256.sql113, 'b4e3cf0c6dec304d3121a45b964537abdc364391e279486046b48fe9e88464fa');
  assert.notEqual(pin.superseded_intended_sha256.sql113, releaseIntendedHash('sql113', SQL113));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql138-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [IDENTITY]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, ['sql113']);
  assert.deepEqual(spec.supersedes, ['sql113']);
  for (const absent of ['runs_before', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  // Only SQL 138 supersedes SQL 113; nothing supersedes, refuses after or depends on SQL 138.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql113')), [KEY]);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration but SQL 113 creates, replaces, drops or re-grants the function.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY && k !== 'sql113')) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...other.functions.map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.ok(!touched.includes(IDENTITY), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [IDENTITY]);
  assert.deepEqual(prod.predecessors, ['sql113']);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(PRE));
  assert.ok(prod.order_note.includes(PRE));
  // The runbook names the pre-state, the intended fingerprint, the source and both bodies.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-138-apply.md'), 'utf8');
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256, pin.superseded_intended_sha256.sql113,
    sha(releaseFunctionDefinitions(TEXT).aws_public_payee_record.prosrc), sha(releaseFunctionDefinitions(SQL113).aws_public_payee_record.prosrc)]) {
    assert.ok(runbook.includes(value), value);
  }
  // SQL 113's pins are as applied and retired; this change does not touch them.
  assert.equal(PINS.sql113.execute, true, 'the staging SQL 113 pin as committed');
  const sql113 = JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS.sql113.production_pin_rel), 'utf8'));
  assert.equal(sql113.execute, false);
  assert.equal(sql113.applied.result, 'applied');
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

test('reviewed file and spec: SQL 113\'s record function only, same attributes and ACL, SQL 113\'s body plus the verified_at check; the prerequisite block, REVOKE, GRANT and COMMENT, nothing else; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_public_payee_record']);
  const ours = releaseIntendedState(KEY, TEXT).functions[IDENTITY];
  const { prosrc_sha256: newBody, ...newAttrs } = ours;
  const { prosrc_sha256: oldBody, ...oldAttrs } = SQL113_FN;
  assert.deepEqual(newAttrs, oldAttrs);
  assert.notEqual(newBody, oldBody);
  assert.equal(ours.security_definer, true);
  assert.equal(ours.volatility, 'v');
  assert.equal(ours.result, 'jsonb');
  assert.deepEqual(ours.config, ['search_path=public']);
  assert.deepEqual(ours.acl, [...ACL]);
  // SQL 113's body plus exactly one line (and its comment), placed after the disconnected check and
  // before the expiry check, the rate limit and the first write.
  const body = defs.aws_public_payee_record.prosrc;
  const old = releaseFunctionDefinitions(SQL113).aws_public_payee_record.prosrc;
  const added = body.split('\n').filter((line) => !old.split('\n').includes(line)).map((line) => line.trim());
  assert.deepEqual(added, ["-- SQL 138: a verified payee's link records nothing (no bank swap, no other step, no counter).", CHECK]);
  assert.equal(body.split('\n').filter((line) => !added.includes(line.trim())).join('\n'), old);
  const at = body.indexOf(CHECK);
  assert.ok(body.indexOf('FOR UPDATE') < at);
  assert.ok(body.indexOf("RETURN jsonb_build_object('error', 'disconnected')") < at);
  for (const later of ["RETURN jsonb_build_object('error', 'expired')", "'rate_limited'", 'SET setup_attempts = setup_attempts + 1', "IF v_event = 'tos_accepted'", 'UPDATE public.payment_provider_methods']) {
    assert.ok(at < body.indexOf(later), later);
  }
  assert.equal([...body.matchAll(/already_verified/g)].length, 1);
  assert.doesNotMatch(body, /token_used_at/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: IDENTITY, acl: [...ACL] }]);
  assert.deepEqual(spec.prerequisites.slice(0, 5), [
    'public.external_payment_recipients', 'public.payment_provider_methods', IDENTITY, 'public.aws_public_payee_by_token(text)', 'role checksops',
  ]);
  // Every column the file's prerequisite block requires is a spec prerequisite, and nothing else.
  const fileColumns = [...TEXT.matchAll(/\('(external_payment_recipients|payment_provider_methods)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.equal(fileColumns.length, 36);
  assert.deepEqual(spec.prerequisites.slice(5), fileColumns);
  assert.deepEqual(spec.predecessors, ['sql113']);
  assert.deepEqual(spec.supersedes, ['sql113']);
  assert.deepEqual(spec.definer_writes, ['public.external_payment_recipients', 'public.payment_provider_methods']);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers', 'constraints']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, one CREATE OR REPLACE FUNCTION, then exactly the REVOKE, the GRANT and the COMMENT on it.
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.equal([...code.matchAll(/\bDO\s+\$sql138_prereq\$/g)].length, 1);
  for (const name of ['sql138_prerequisite_missing', 'sql138_definer_cannot_write', 'sql138_function_not_owned']) assert.match(code, new RegExp(name));
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  const tail = code.slice(code.lastIndexOf('$$;') + 3).trim().split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(tail.slice(0, 3), [REVOKE, GRANT, `COMMENT ON FUNCTION ${IDENTITY} IS`]);
  assert.equal(tail.length, 4);
  assert.match(tail[3], /^'SQL 113, SQL 138: .*already_verified.*checksops only\.';$/);
  assert.equal([...code.matchAll(/\bREVOKE\b/g)].length, 1);
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 1);
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/,
    /aws_payee_(create|reissue_link|disconnect|apply_status)\b/, /FUNCTION public\.aws_public_payee_by_token/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [IDENTITY]);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql138 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=${sha(body)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);
  assert.deepEqual(releaseStateText(KEY, { functions: { [IDENTITY]: SQL113_FN } }).split('\n'), [
    'release sql138 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=${sha(old)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: SQL 113's function passes; SQL 113 not applied, the tables unwritable or missing refuse;
  // the function owned by another role, with another grant or another result refuses; PUBLIC is revocable.
  const definer = { 'public.external_payment_recipients': true, 'public.payment_provider_methods': true };
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, definer };
  const fn = (acl, over = {}) => ({ functions: { [IDENTITY]: { ...SQL113_FN, owner_is_login: true, acl: [...acl], ...over } } });
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...fn(ACL), ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ predecessors_applied: false }), ['predecessors_applied']);
  assert.deepEqual(pre({ definer: { ...definer, 'public.payment_provider_methods': false } }), ['definer_can_write_relations']);
  assert.ok(pre({ prerequisites_missing: [IDENTITY] }).includes('prerequisites_present'));
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
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 138 through the executor: the pre-state as derived; refused before SQL 113 and under FORCE ROW LEVEL SECURITY; a pending pin and drift cannot apply; one apply on the intended fingerprint, then refused; SQL 113 still applied through SQL 138', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql138-exec-', 61380, { extra: [PAYEE_SCHEMA] });
  const { admin, connectAs } = fx;
  try {
    const asOwner = async (sql) => {
      const owner = await connectAs('checksops_admin');
      try { await owner.query(sql); } finally { await owner.end(); }
    };
    const seen = [];
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const inspect = async (key = KEY) => {
      seen.length = 0;
      const result = await handlerFor(connect)(inspectEvent(key));
      assert.equal(result.ok, true, `${key}: ${JSON.stringify(result)}`);
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      return result.details.receipt;
    };
    const apply = async (live) => {
      const pin = Object.freeze({ ...PINS[KEY], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
      return handlerFor(connect, { pins: { [KEY]: pin } })(releaseEvent({ pin }));
    };
    const body = async () => (await admin.query('SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1)', [IDENTITY])).rows[0]?.prosrc ?? null;
    const procAcl = async () => (await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    const sql113Body = releaseFunctionDefinitions(SQL113).aws_public_payee_record.prosrc;

    // Before SQL 113: refused on the predecessor and on its own prerequisites (the functions it needs).
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.predecessors, { sql113: false });
    assert.ok(early.precondition_failures.includes('predecessors_applied'));
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await body(), null);

    // SQL 113 as the owner: the pre-state both databases are expected to have.
    await asOwner(SQL113);
    assert.equal((await inspect('sql113')).already_applied, true);
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, { sql113: true });
    assert.deepEqual(pre.release_sql_inspect.definer_writes, [
      { name: 'external_payment_recipients', ok: true }, { name: 'payment_provider_methods', ok: true },
    ]);
    assert.equal(pre.already_applied, false);
    assert.deepEqual(pre.release_sql_inspect.functions.map((row) => row.state), ['different']);
    assert.equal(pre.live_definition_sha256, PRE, 'the live pre-state equals the one derived from SQL 113\'s bytes');
    assert.equal(await body(), sql113Body);

    // A table under FORCE ROW LEVEL SECURITY (the DEFINER owner could not write it): refused, nothing applied.
    await admin.query('ALTER TABLE public.payment_provider_methods FORCE ROW LEVEL SECURITY');
    const forced = await inspect();
    assert.ok(forced.precondition_failures.includes('definer_can_write_relations'), JSON.stringify(forced.precondition_failures));
    assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await body(), sql113Body);
    await admin.query('ALTER TABLE public.payment_provider_methods NO FORCE ROW LEVEL SECURITY');
    assert.deepEqual((await inspect()).precondition_failures, []);

    // A pending pin cannot apply.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    assert.equal(await body(), sql113Body);
    // Drift between the recorded pre-state and the apply refuses (an extra EXECUTE grant), as does a pin
    // recording the intended state or an unknown hash as the pre-state.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO PUBLIC`);
    assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${IDENTITY} FROM PUBLIC`);
    assert.equal((await apply(PINS[KEY].intended_replacement_sha256)).code, CODES.INVALID_MANIFEST);
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await body(), sql113Body);
    assert.equal((await inspect()).live_definition_sha256, PRE);

    // One apply on the intended fingerprint: SQL 138's body, same owner, attributes and ACL.
    const aclBefore = await procAcl();
    assert.deepEqual(aclBefore, { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public'], provolatile: 'v', execute: ['checksops', 'checksops_admin'] });
    const applied = await apply(PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((row) => row.state), ['intended']);
    assert.deepEqual(await procAcl(), aclBefore);
    assert.equal(await body(), releaseFunctionDefinitions(TEXT).aws_public_payee_record.prosrc);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${RECIPIENTS}`)).rows[0].n, 0, 'no row written');
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);

    // SQL 113's own fingerprint has moved on (its record function is SQL 138's now), but SQL 113 still
    // counts as applied through SQL 138 (supersedes)...
    assert.equal((await inspect('sql113')).already_applied, false);
    assert.deepEqual((await inspect()).release_sql_inspect.predecessors, { sql113: true });
    // ...only while every other SQL 113 object still matches: a drifted SQL 113 grant is not SQL 113 applied.
    await admin.query('REVOKE EXECUTE ON FUNCTION public.aws_payee_disconnect(uuid) FROM checksops');
    try {
      const drifted = await inspect();
      assert.equal(drifted.already_applied, true);
      assert.deepEqual(drifted.release_sql_inspect.predecessors, { sql113: false });
    } finally {
      await admin.query('GRANT EXECUTE ON FUNCTION public.aws_payee_disconnect(uuid) TO checksops');
    }
    assert.deepEqual((await inspect()).release_sql_inspect.predecessors, { sql113: true });
  } finally {
    await fx.close();
  }
});
