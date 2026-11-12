/**
 * SQL 160 (aws/workflows/sql/160_no_additional_check_mortgage_charge_or_manual_deposit_fee.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-159 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner
 * 2026-11-12: "we are removing the mortgage handling for an additional check if an additional check is on the same
 * request. There will be no more $5 charge", agent pay "Stop paying it", "if a user deposits a check outside of checksops
 * they should NOT be charged $4", "yes make that free too", "start SQL 160 yes".
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 160 included); this file covers what is new:
 *
 *   - the engine reads pg_get_functiondef's SET name TO 'value' (and TO value) as SET name = value;
 *   - the pin: pending, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing;
 *   - the file and spec: four CREATE OR REPLACE of existing live functions, no GRANT or REVOKE; each spec ACL the one the
 *     production billing trigger inspect observed (billing-trigger-inspect.json observed_functions) with revokes [];
 *     the pre-state (the fixture's inspected bodies) and the intended state derived;
 *   - on PostgreSQL 16, from the inspected bodies with the observed grants: the pre-state read back as derived; a pending
 *     pin and drift cannot apply; an extra grant refuses; one apply through the executor reaches the intended
 *     fingerprint with every grant, owner and SET option kept, then is refused as already in place; a drifted grant is
 *     not intended; a re-run of the bytes keeps the fingerprint.
 * The behavior is aws/tests/sql160-billing-additional-check-pg.test.mjs.
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
  AUTHORIZED_SQL160_NO_ADDITIONAL_CHECK_OR_MANUAL_DEPOSIT_FEE,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  RELEASE_STAGING_SQL_KEYS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
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
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-12T12:00:00.000Z';
const KEY = 'sql160';
/** Each function's live EXECUTE ACL and SET options as the 2026-11-12 production inspect observed them (owner read as `owner`). */
const OBSERVED = Object.freeze({
  'public.record_check_billing_event()': { acl: ['checksops EXECUTE', 'owner EXECUTE'], config: ['row_security=off', 'search_path=public'], result: 'trigger' },
  'public.accrue_mortgage_ops_billing(uuid)': { acl: ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'], config: ['search_path=public'], result: 'public.check_billing_events' },
  'public.earn_mortgage_agent_compensation(uuid)': { acl: ['owner EXECUTE'], config: ['row_security=off', 'search_path=public'], result: 'public.mortgage_agent_compensation_entries' },
  'public.tg_record_mortgage_handling_billing()': { acl: ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'], config: ['search_path=public'], result: 'trigger' },
});
const FNS = Object.keys(OBSERVED);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/sql160-live-billing-functions-2026-11-12.sql'), 'utf8');
/** The four functions with the inspected bodies and the observed attributes: the production pre-state. */
const PRE = releaseIntendedHash(KEY, FIXTURE);
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

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
    expiry: '2026-11-12T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key = KEY) => releaseEvent({ key, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql160-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// What the release fixture lacks: the billing tables and columns SQL 160 names (sql98To100Schema plus deposit_items.provider
// and the agent compensation tables), the two price helpers record_check_billing_event calls, and the four inspected live
// definitions, verbatim, with the grants the production inspect observed. Run as the superuser; the fixture then makes
// checksops_admin the owner of everything in public, as in production.
const EXTRA = [
  ...sql98To100Schema(),
  `ALTER TABLE public.deposit_items ADD COLUMN provider public.deposit_provider;
CREATE TABLE public.mortgage_agent_compensation_rates (singleton boolean PRIMARY KEY, initial_cents integer, additional_cents integer);
CREATE TABLE public.mortgage_agent_compensation_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_entry_id uuid,
  mortgage_request_id uuid, status text);
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql AS 'SELECT 300';`,
  FIXTURE,
  `REVOKE EXECUTE ON FUNCTION public.record_check_billing_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_check_billing_event() TO checksops;
GRANT EXECUTE ON FUNCTION public.accrue_mortgage_ops_billing(uuid) TO authenticated, checksops;
REVOKE EXECUTE ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_record_mortgage_handling_billing() TO checksops;`,
];

test('engine: SET name TO \'value\' and SET name TO value read as SET name = value; a list keeps its form', () => {
  const fn = (set) => `CREATE OR REPLACE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER\n${set}\nAS $function$ BEGIN RETURN NEW; END $function$;`;
  const config = (set) => releaseFunctionDefinitions(fn(set)).f.config;
  const want = ['row_security=off', 'search_path=public'];
  assert.deepEqual(config(" SET search_path TO 'public'\n SET row_security TO 'off'"), want);
  assert.deepEqual(config(' SET search_path TO public\n SET row_security TO off'), want);
  assert.deepEqual(config(' SET search_path = public\n SET row_security = off'), want);
  assert.deepEqual(config(" SET search_path to 'public'\n set row_security To off"), want);
  assert.deepEqual(config(' SET search_path TO public, pg_temp'), ['search_path=public, pg_temp']);
  assert.deepEqual(config(" SET search_path TO 'public', 'pg_temp'"), ['search_path=public, pg_temp']);
  assert.deepEqual(config(' SET search_path = public, pg_temp'), ['search_path=public, pg_temp']);
  assert.deepEqual(config(''), []);
  // A SET inside the body is not an attribute.
  const body = "CREATE FUNCTION public.g() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN UPDATE t SET status TO 'x'; END $f$;";
  assert.deepEqual(releaseFunctionDefinitions(body).g.config, []);
});

test('pin: SQL 160 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL160_NO_ADDITIONAL_CHECK_OR_MANUAL_DEPOSIT_FEE, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/160_no_additional_check_mortgage_charge_or_manual_deposit_fee.sql');
  assert.equal(pin.migration_id, '160_no_additional_check_mortgage_charge_or_manual_deposit_fee');
  assert.equal(spec.choice, 'sql160-no-additional-check-or-manual-deposit-fee');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, {}), PRE);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the pre-state and intended states (derived here), the fingerprints and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-160-apply.md'), 'utf8');
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256, 'wave 51']) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, FIXTURE))}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql160-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 160. Of its functions only record_check_billing_event() is in
  // another release spec (SQL 98, which created it); no other release migration touches the other three.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const fn of FNS) assert.ok(!touched.includes(fn) || (key === 'sql98' && fn === 'public.record_check_billing_event()'), `${key} ${fn}`);
  }
  // SQL 98's reviewed ACL for record_check_billing_event() is the one the inspect observed.
  assert.deepEqual(RELEASE_SQL_SPECS.sql98.functions.find((fn) => fn.identity === FNS[0]).acl, OBSERVED[FNS[0]].acl);
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, FNS);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'STOP_ADDITIONAL_CHECK_AND_OUTSIDE_DEPOSIT_CHARGES');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
  assert.ok(prod.production_inspect.note.includes(PRE));
  assert.ok(prod.order_note.includes(PRE));
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

test('reviewed file and spec: four CREATE OR REPLACE of live functions, the observed grants and SET options kept (revokes []), the inspected bodies as pre-state; no other object', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  const live = releaseFunctionDefinitions(FIXTURE);
  const name = (identity) => identity.replace(/^public\.|\(.*$/g, '');
  assert.deepEqual(Object.keys(defs), FNS.map(name));
  assert.deepEqual(Object.keys(live), FNS.map(name));
  for (const identity of FNS) {
    const n = name(identity);
    // Only the body changes: language, volatility, SECURITY DEFINER, result and SET options as the live definition.
    assert.deepEqual({ ...defs[n], prosrc: null }, { ...live[n], prosrc: null }, n);
    assert.notEqual(defs[n].prosrc, live[n].prosrc, n);
    assert.equal(defs[n].security_definer, true, n);
    assert.deepEqual(defs[n].config, OBSERVED[identity].config, n);
    // The file's drift guard names the inspected body hash and its own.
    assert.ok(TEXT.includes(`['${identity}', '${sha(live[n].prosrc)}', '${sha(defs[n].prosrc)}']`), n);
  }
  // The observed grants: billing-trigger-inspect.json records them as the inspect printed them (the owner by name).
  const observed = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/billing-trigger-inspect.json'), 'utf8')).production_inspect.observed_functions;
  const printed = (identity) => Object.entries(observed).find(([k]) => k.replace(/\(p_request_id uuid\)/, '(uuid)') === identity)?.[1];
  for (const identity of FNS) {
    const row = printed(identity);
    assert.ok(row, identity);
    assert.equal(row.owner, 'checksops_admin');
    assert.equal(row.security_definer, true);
    assert.equal(row.prosrc_sha256, sha(live[name(identity)].prosrc), identity);
    assert.deepEqual(row.execute_acl.map((line) => line.replace(/^checksops_admin /, 'owner ')).sort(), [...OBSERVED[identity].acl].sort(), identity);
    assert.deepEqual([...row.config_names].sort(), OBSERVED[identity].config.map((c) => c.split('=')[0]).sort(), identity);
  }
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl, fn.revokes]), FNS.map((identity) => [identity, OBSERVED[identity].acl, []]));
  for (const fn of spec.functions) assert.equal(fn.result ?? defs[name(fn.identity)].result, OBSERVED[fn.identity].result, fn.identity);
  for (const kind of ['tables', 'policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations', 'definer_writes']) {
    assert.equal(spec[kind], undefined, kind);
  }
  for (const name of [...FNS, 'column public.deposit_items.provider', 'column public.deposit_items.check_id', 'column public.mortgage_handling_requests.claim_id',
    'column public.mortgage_agent_compensation_rates.additional_cents', 'column public.check_billing_events.event_type', 'column public.check_billing_events.check_intake_item_id',
    'role checksops', 'role authenticated']) {
    assert.ok(spec.prerequisites.includes(name), name);
  }
  assert.deepEqual(releaseUnrelatedScope(KEY).skip_functions, FNS);
  // The pre-state and intended texts differ only in the bodies.
  const pre = releaseStateText(KEY, releaseIntendedState(KEY, FIXTURE)).split('\n');
  const post = releaseStateText(KEY, releaseIntendedState(KEY, TEXT)).split('\n');
  assert.equal(post[0], 'release sql160 v1');
  assert.deepEqual(post.map((line) => line.replace(/prosrc=[0-9a-f]{64}/, 'prosrc=x')), pre.map((line) => line.replace(/prosrc=[0-9a-f]{64}/, 'prosrc=x')));
  // A live grant outside the observed ACL refuses (nothing revokes it); the observed one does not.
  const state = (acl) => ({
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    functions: Object.fromEntries(FNS.map((identity) => [identity, { ...releaseIntendedState(KEY, FIXTURE).functions[identity], owner_is_login: true,
      ...(identity === FNS[0] && acl ? { acl } : {}) }])),
  });
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, state(null), TEXT), []);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, state(['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']), TEXT), ['function_acl_replaceable']);
});

test('PostgreSQL 16: SQL 160 through the executor from the inspected bodies and grants: the pre-state as derived, a pending pin, drift and an extra grant cannot apply, one apply on the intended fingerprint with grants and SET options kept, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql160-exec-', 59160, { extra: EXTRA });
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
    const attributes = async () => (await admin.query(`SELECT p.oid::regprocedure::text AS f, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        pg_get_function_result(p.oid) AS result, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS prosrc,
        ARRAY(SELECT coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                LEFT JOIN pg_roles g ON g.oid = a.grantee ORDER BY 1) AS acl
      FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`, [FNS])).rows;

    // The inspected definitions with the observed grants: the derived pre-state.
    const before = await attributes();
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, PRE);
    assert.deepEqual(r.release_sql_inspect.function_acl.map((row) => row.acl), FNS.map((fn) => OBSERVED[fn].acl));
    // The results as the catalog reads them under search_path pg_catalog (the engine's read): the spec's.
    await admin.query("SET search_path TO pg_catalog");
    for (const fn of FNS) assert.equal((await admin.query('SELECT pg_get_function_result($1::regprocedure) AS r', [fn])).rows[0].r, OBSERVED[fn].result, fn);
    await admin.query('RESET search_path');
    // A pending pin cannot apply.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    // Drift between the recorded pre-state and the apply refuses.
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    // A grant outside the observed ACL refuses before anything runs (CREATE OR REPLACE would keep it).
    await admin.query(`GRANT EXECUTE ON FUNCTION ${FNS[2]} TO authenticated`);
    try {
      const extra = await inspect();
      assert.ok(extra.precondition_failures.includes('function_acl_replaceable'), JSON.stringify(extra.precondition_failures));
      assert.notEqual((await apply(extra.live_definition_sha256)).ok, true);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${FNS[2]} FROM authenticated`);
    }
    assert.deepEqual(await attributes(), before);

    const applied = await apply(PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    // Only the bodies changed: owner, SECURITY DEFINER, SET options, results and grants as before.
    const after = await attributes();
    assert.deepEqual(after.map((row) => ({ ...row, prosrc: null })), before.map((row) => ({ ...row, prosrc: null })));
    const defs = releaseFunctionDefinitions(TEXT);
    for (const row of after) assert.equal(row.prosrc, sha(defs[row.f.replace(/^(public\.)?|\(.*$/g, '')].prosrc), row.f);
    const done = await inspect();
    assert.equal(done.already_applied, true);
    assert.deepEqual(done.precondition_failures, []);
    assert.equal(done.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(done.release_sql_inspect.functions.map((row) => row.state), FNS.map(() => 'intended'));
    // A second apply: refused, the database already past the pinned pre-state.
    assert.notEqual((await apply(PRE)).ok, true);
    // A drifted grant is not intended.
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${FNS[1]} FROM authenticated`);
    try {
      assert.equal((await inspect()).already_applied, false);
    } finally {
      await admin.query(`GRANT EXECUTE ON FUNCTION ${FNS[1]} TO authenticated`);
    }
    // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
    const owner = await connectAs('checksops_admin');
    try { await owner.query(TEXT); } finally { await owner.end(); }
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
