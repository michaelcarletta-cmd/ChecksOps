/**
 * SQL 146 (aws/workflows/sql/146_moov_status_catch_up_writes.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-145 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 146 included); this file covers what is
 * new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the production pin (pending too); the pinned
 *     commit authored the bytes; no predecessor; nothing supersedes or names it;
 *   - the file and spec: two new DEFINER functions, aws_moov_catch_up_lock_rows(...) and
 *     aws_moov_apply_collection_leg_status(...): plpgsql, VOLATILE, SECURITY DEFINER, search_path public, pg_temp,
 *     RETURNS jsonb; the webhook-apply-context and platform-owner gates, the input checks, the lock (FOR UPDATE, no
 *     write), the leg writer's row checks (SQL 109 legs and other contracts not owned, Moov's amount), its never-backwards
 *     rank and its one UPDATE; the prerequisite DO block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the
 *     spec's prerequisites and the two definer relations; the pre- and post-conditions;
 *   - on PostgreSQL 16 (the payment transfer and obligation schema on the release fixture): the inspect reads the
 *     pre-state both databases have (both functions absent) as derived here; refused while a column it reads or writes
 *     is missing or either relation is under FORCE ROW LEVEL SECURITY; a pending pin cannot apply; an unexpected
 *     pre-state is refused (DEPLOYMENT_COLLISION); one apply through the executor reaches the intended fingerprint
 *     (EXECUTE for checksops and the owner), then a second apply is refused (UNRELATED_MUTATION: already in place).
 * The behavior (the incident reproduced; who may lock and write which row; the catch-up end to end) is
 * aws/tests/sql146-moov-status-catch-up-writes-pg.test.mjs.
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
  AUTHORIZED_SQL146_MOOV_STATUS_CATCH_UP_WRITES,
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
import { catchUpSchema } from './helpers/sql146-catch-up-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-07T12:00:00.000Z';
const KEY = 'sql146';
const LOCK = 'aws_moov_catch_up_lock_rows';
const LOCK_ARGS = 'text, text, uuid[]';
const LEG = 'aws_moov_apply_collection_leg_status';
const LEG_ARGS = 'text, text, bigint, text, text, text, timestamptz';
const LOCK_IDENTITY = `public.${LOCK}(${LOCK_ARGS})`;
const LEG_IDENTITY = `public.${LEG}(text, text, bigint, text, text, text, timestamp with time zone)`;
const IDENTITIES = Object.freeze([LOCK_IDENTITY, LEG_IDENTITY]);
const RELATIONS = Object.freeze(['public.payment_transfers', 'public.tenant_maintenance_payments']);
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases have: both functions absent (everything else present). */
const ABSENT_PRE = releaseStateHash(KEY, { functions: { [LOCK_IDENTITY]: { exists: false }, [LEG_IDENTITY]: { exists: false } } });

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
    expiry: '2026-11-07T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql146-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 146 pending, code-derived, selectable, packed, in step with the production pin; no predecessor; nothing names it', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL146_MOOV_STATUS_CATCH_UP_WRITES, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/146_moov_status_catch_up_writes.sql');
  assert.equal(pin.migration_id, '146_moov_status_catch_up_writes');
  assert.equal(spec.choice, 'sql146-moov-status-catch-up-writes');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // The pre-state (both functions absent) has a fingerprint of its own, and renders as absent.
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.equal(ABSENT_PRE, releaseStateHash(KEY, {}));
  assert.deepEqual(releaseStateText(KEY, { functions: { [LOCK_IDENTITY]: { exists: false }, [LEG_IDENTITY]: { exists: false } } }).split('\n'),
    ['release sql146 v1', `function ${LOCK_IDENTITY}: absent`, `function ${LEG_IDENTITY}: absent`]);
  // The runbook and the production pin name the expected pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-146-apply.md'), 'utf8');
  assert.ok(runbook.includes(ABSENT_PRE));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.ok(runbook.includes(pin.source_sha256));
  const defs = releaseFunctionDefinitions(TEXT);
  for (const name of [LOCK, LEG]) assert.ok(runbook.includes(sha(defs[name].prosrc)), name);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql146-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...IDENTITIES]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  // No predecessor; nothing supersedes, refuses after or depends on it.
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['runs_before', 'supersedes', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces, drops or re-grants either function.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const identity of IDENTITIES) assert.ok(!touched.includes(identity), `${key} ${identity}`);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...IDENTITIES]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(ABSENT_PRE));
  assert.ok(prod.order_note.includes(ABSENT_PRE));
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

test('reviewed file and spec: two new DEFINER functions with the webhook-apply-context and platform-owner gates, the lock (no write) and the leg writer (its row checks, never backwards, one UPDATE); the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [LOCK, LEG]);
  for (const name of [LOCK, LEG]) {
    const def = defs[name];
    assert.equal(def.language, 'plpgsql', name);
    assert.equal(def.volatility, 'v', name);
    assert.equal(def.parallel, 'u', name);
    assert.equal(def.security_definer, true, name);
    assert.equal(def.result, 'jsonb', name);
    assert.deepEqual(def.config, ['search_path=public, pg_temp'], name);
  }
  const strip = (text) => text.replace(/--[^\n]*/g, '');
  const lock = strip(defs[LOCK].prosrc);
  const leg = strip(defs[LEG].prosrc);
  // The lock: the webhook apply context first, then the platform owner; inputs; FOR UPDATE on both relations; no write.
  assert.match(lock, /BEGIN\s+IF NOT COALESCE\(public\.aws_moov_webhook_apply_active\(\), false\) THEN\s+RAISE EXCEPTION 'moov_catch_up_webhook_apply_required'\s+USING ERRCODE = '42501';\s+END IF;\s+IF auth\.uid\(\) IS NULL OR NOT COALESCE\(public\.is_platform_owner\(\), false\) THEN\s+RAISE EXCEPTION 'moov_catch_up_forbidden'\s+USING ERRCODE = '42501';/);
  assert.match(lock, /_environment NOT IN \('production', 'sandbox'\)/);
  assert.match(lock, /COALESCE\(cardinality\(v_ids\), 0\) > 50/);
  assert.match(lock, /FROM public\.payment_transfers t\s+WHERE t\.provider = 'moov'\s+AND t\.environment = _environment\s+AND t\.provider_transfer_id = btrim\(_provider_transfer_id\)\s+ORDER BY t\.id\s+FOR UPDATE;/);
  assert.match(lock, /FROM public\.tenant_maintenance_payments o\s+WHERE o\.id = ANY \(v_ids\)\s+ORDER BY o\.id\s+FOR UPDATE;/);
  assert.deepEqual([...lock.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/gi)].map((m) => m[0]), ['UPDATE', 'UPDATE'], 'only FOR UPDATE');
  assert.equal([...lock.matchAll(/FOR UPDATE/g)].length, 2);
  // The leg writer: the webhook apply context; with a user only the platform owner; inputs; the row checks; the rank.
  assert.match(leg, /BEGIN\s+IF NOT COALESCE\(public\.aws_moov_webhook_apply_active\(\), false\) THEN\s+RAISE EXCEPTION 'moov_collection_leg_webhook_apply_required'\s+USING ERRCODE = '42501';\s+END IF;\s+IF auth\.uid\(\) IS NOT NULL AND NOT COALESCE\(public\.is_platform_owner\(\), false\) THEN\s+RAISE EXCEPTION 'moov_collection_leg_forbidden'\s+USING ERRCODE = '42501';/);
  assert.match(leg, /_amount_cents IS NULL OR _amount_cents <= 0/);
  assert.match(leg, /_status NOT IN \('settled', 'failed', 'returned'\)/);
  assert.match(leg, /AND t\.provider_transfer_id = btrim\(_provider_transfer_id\)\s+FOR UPDATE;/);
  assert.match(leg, /COALESCE\(v_row\.leg_role, ''\) IN \('wallet_funding', 'send_wallet', 'send_bank'\)/);
  assert.match(leg, /COALESCE\(v_row\.provider_metadata ->> 'collection_contract', ''\) = 'tenant-collection-v2'\s+OR COALESCE\(v_row\.provider_metadata ->> 'checksops_kind', ''\) = 'monthly_subscription'/);
  assert.match(leg, /IF v_row\.amount_cents IS DISTINCT FROM _amount_cents THEN/);
  assert.match(leg, /IF v_new_rank > v_old_rank THEN\s+v_outcome := 'applied';/);
  // One write: the leg UPDATE of status, provider_status, completed_at, failure_reason and updated_at, by id.
  assert.deepEqual([...leg.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.[a-z_]+)?/gi)].map((m) => m[0].trim()),
    ['UPDATE public.payment_transfers']);
  const set = /UPDATE public\.payment_transfers t\s+SET ([\s\S]+?)\s+WHERE t\.id = v_row\.id;/.exec(leg)[1];
  assert.deepEqual([...set.matchAll(/(?:^|,\s*)([a-z_]+) =/g)].map((m) => m[1]), ['status', 'provider_status', 'completed_at', 'failure_reason', 'updated_at']);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, IDENTITIES.map((identity) => ({ identity, acl: [...ACL], revokes: [...REVOKES] })));
  assert.deepEqual(spec.prerequisites.slice(0, 6), ['public.payment_transfers', 'public.tenant_maintenance_payments', 'public.is_platform_owner()',
    'public.aws_moov_webhook_apply_active()', 'auth.uid()', 'role checksops']);
  // The file's prerequisite block names the same objects, and every column it checks is a spec prerequisite, and nothing else.
  const fileObjects = [...TEXT.matchAll(/^\s+\('([^']+)', (?:pg_catalog\.to_reg|\(SELECT r\.oid)/gm)].map((m) => m[1]);
  assert.deepEqual(fileObjects, spec.prerequisites.slice(0, 6));
  const fileColumns = [...TEXT.matchAll(/\('(payment_transfers|tenant_maintenance_payments)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.deepEqual(spec.prerequisites.slice(6), fileColumns);
  // Every column either function reads or writes is a checked prerequisite.
  for (const column of ['id', 'tenant_id', 'provider', 'environment', 'provider_transfer_id', 'provider_status', 'status', 'leg_role', 'amount_cents',
    'failure_reason', 'provider_metadata', 'completed_at', 'updated_at']) {
    assert.ok(spec.prerequisites.includes(`column public.payment_transfers.${column}`), column);
  }
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, two CREATE OR REPLACE FUNCTIONs, the REVOKEs from PUBLIC, the role REVOKE block, the GRANTs.
  const code = strip(TEXT);
  assert.equal([...code.matchAll(/\bDO\s+\$sql146_prereq\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bDO\s+\$sql146_revoke\$/g)].length, 1);
  assert.match(code, /sql146_prerequisite_missing/);
  assert.match(code, /sql146_definer_cannot_write/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 2);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].map((m) => m[0]).join('\n'),
    `GRANT EXECUTE ON FUNCTION public.${LOCK}(${LOCK_ARGS}) TO checksops;\nGRANT EXECUTE ON FUNCTION public.${LEG}(${LEG_ARGS}) TO checksops;`);
  assert.equal([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]).join('\n'),
    `REVOKE ALL ON FUNCTION public.${LOCK}(${LOCK_ARGS}) FROM PUBLIC;\nREVOKE ALL ON FUNCTION public.${LEG}(${LEG_ARGS}) FROM PUBLIC;`);
  let outsideBodies = code;
  for (const name of [LOCK, LEG]) outsideBodies = outsideBodies.replace(strip(defs[name].prosrc), '');
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/, /\bPOLICY\b/]) {
    assert.doesNotMatch(outsideBodies, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [...IDENTITIES]);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql146 v1',
    `function ${LOCK_IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=${sha(defs[LOCK].prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
    `function ${LEG_IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=${sha(defs[LEG].prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: both absent passes; either relation unreachable or missing refuses; an existing function owned by
  // another role, with another grant or another result refuses; the revoked roles are revocable.
  const definer = Object.fromEntries(RELATIONS.map((table) => [table, true]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {}, definer };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (identity, acl, over = {}) => ({ functions: { [identity]: { ...releaseIntendedState(KEY, TEXT).functions[identity], owner_is_login: true, acl: [...acl], ...over } } });
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ functions: { [LOCK_IDENTITY]: { exists: false }, [LEG_IDENTITY]: { exists: false } } }), []);
  for (const table of RELATIONS) {
    assert.deepEqual(pre({ definer: { ...definer, [table]: false } }), ['definer_can_write_relations'], table);
    assert.ok(pre({ prerequisites_missing: [table] }).includes('prerequisites_present'), table);
  }
  assert.ok(pre({ prerequisites_missing: ['public.aws_moov_webhook_apply_active()'] }).includes('prerequisites_present'));
  for (const identity of IDENTITIES) {
    assert.deepEqual(pre(fn(identity, ACL)), [], identity);
    assert.deepEqual(pre(fn(identity, [...REVOKES, ...ACL])), [], identity);
    assert.deepEqual(pre(fn(identity, [...ACL, 'sql146_plain EXECUTE'])), ['function_acl_replaceable'], identity);
    assert.deepEqual(pre(fn(identity, ACL, { owner_is_login: false })), ['functions_owned_by_login'], identity);
    assert.deepEqual(pre(fn(identity, ACL, { result: 'SETOF record' })), ['function_results_match'], identity);
  }
  // Post-conditions: the intended fingerprint with both functions owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: Object.fromEntries(IDENTITIES.map((identity) => [identity, { exists: true, owner_is_login: true }])),
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: ABSENT_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 146 through the executor: the pre-state as derived; refused while a column is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql146-exec-', 60390, { extra: catchUpSchema() });
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
    const present = async () => (await fx.admin.query('SELECT bool_or(pg_catalog.to_regprocedure(i) IS NOT NULL) AS present FROM unnest($1::text[]) i', [[...IDENTITIES]])).rows[0].present;
    const executeAcl = async (identity) => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [identity])).rows[0];
    const allOk = RELATIONS.map((table) => ({ name: table.replace(/^public\./, ''), ok: true }));

    // The pre-state both databases have: the function absent, every prerequisite present, both relations reachable.
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, {});
    assert.deepEqual(pre.release_sql_inspect.definer_writes, allOk);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, ABSENT_PRE);
    assert.equal(await present(), false);

    // Either relation under FORCE ROW LEVEL SECURITY (the DEFINER owner could not write or read it): refused, nothing applied.
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

    // A column it writes missing: refused, nothing applied.
    await fx.admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN amount_cents TO amount_moved');
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.payment_transfers.amount_cents'), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN amount_moved TO amount_cents');
    assert.deepEqual((await inspect()).precondition_failures, []);
    assert.equal(await present(), false);

    // A pending pin cannot apply (the committed pin is pending; pend a copy with the pre-state recorded).
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT_PRE });
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }));
    assert.equal(pending.ok, false);
    assert.equal(await present(), false);

    // An unexpected pre-state: a pin recording the intended state as the pre-state is not a valid authorization
    // package; a pin recording a hash the database does not show refuses on the live state. Nothing applied either way.
    const onIntended = await apply(PINS[KEY].intended_replacement_sha256);
    assert.equal(onIntended.ok, false, JSON.stringify(onIntended));
    assert.equal(onIntended.code, CODES.INVALID_MANIFEST);
    assert.equal(await present(), false);
    const unknown = await apply('f'.repeat(64));
    assert.equal(unknown.ok, false, JSON.stringify(unknown));
    assert.equal(unknown.code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await present(), false);
    assert.equal((await inspect()).live_definition_sha256, ABSENT_PRE);

    // One apply on the intended fingerprint: both functions exist, owned by the login, EXECUTE for checksops and the owner.
    const applied = await apply(ABSENT_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((f) => f.state), ['intended', 'intended']);
    assert.equal(await present(), true);
    for (const identity of IDENTITIES) {
      assert.deepEqual(await executeAcl(identity), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] }, identity);
    }
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(ABSENT_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
