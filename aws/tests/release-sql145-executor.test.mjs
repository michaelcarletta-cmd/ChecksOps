/**
 * SQL 145 (aws/workflows/sql/145_platform_owner_billing_collection_leg.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-144 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 145 included); this file covers what is
 * new:
 *
 *   - the pin: staging-authorized (wave 40) from staging read-live run 42331198486, code-derived, selectable, packed,
 *     in step with the production pin (pending); the pinned commit authored the bytes; no predecessor; nothing
 *     supersedes or names it;
 *   - the file and spec: one new DEFINER writer, aws_platform_owner_insert_billing_collection_leg(...): plpgsql,
 *     VOLATILE, SECURITY DEFINER, search_path public, pg_temp, RETURNS public.payment_transfers; the platform-owner and
 *     server-write-path gates, the leg checks (role, key, contract, period, status, environment, amount), the
 *     obligation and amount check, the API's INSERT and ON CONFLICT update over the same kind of leg only, and no other
 *     write; the prerequisite DO block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec's
 *     prerequisites and the two definer relations; the pre- and post-conditions;
 *   - on PostgreSQL 16 (the payment transfer and obligation schema on the release fixture): the inspect reads the
 *     pre-state both databases have (the function absent) as derived here; refused while a column it writes is missing
 *     or either relation is under FORCE ROW LEVEL SECURITY; a pending pin cannot apply; an unexpected pre-state is
 *     refused (DEPLOYMENT_COLLISION); one apply through the executor reaches the intended fingerprint (EXECUTE for
 *     checksops and the owner), then a second apply is refused (UNRELATED_MUTATION: already in place).
 * The behavior (who may write which leg; the incident reproduced) is
 * aws/tests/sql145-platform-owner-billing-collection-leg-pg.test.mjs.
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
  AUTHORIZED_SQL145_PLATFORM_OWNER_BILLING_COLLECTION_LEG,
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
import { collectionLegSchema } from './helpers/sql145-collection-leg-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-07T12:00:00.000Z';
const KEY = 'sql145';
const NAME = 'aws_platform_owner_insert_billing_collection_leg';
const ARGS = 'uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb';
const IDENTITY = `public.${NAME}(${ARGS})`;
const RELATIONS = Object.freeze(['public.payment_transfers', 'public.tenant_maintenance_payments']);
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const RESULT = 'public.payment_transfers';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql145-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 145 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor; nothing names it', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL145_PLATFORM_OWNER_BILLING_COLLECTION_LEG, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/145_platform_owner_billing_collection_leg.sql');
  assert.equal(pin.migration_id, '145_platform_owner_billing_collection_leg');
  assert.equal(spec.choice, 'sql145-platform-owner-billing-collection-leg');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-07, "record the SQL 145 staging pin") from staging read-live
  // run 42331198486: already_applied false, precondition_failures []. It read the derived pre-state.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-07: staging apply (wave 40) from staging read-live run 42331198486');
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // The pre-state (the function absent) has a fingerprint of its own, and renders as absent.
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.equal(ABSENT_PRE, releaseStateHash(KEY, {}));
  assert.deepEqual(releaseStateText(KEY, { functions: { [IDENTITY]: { exists: false } } }).split('\n'), ['release sql145 v1', `function ${IDENTITY}: absent`]);
  // The runbook and the production pin name the expected pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-145-apply.md'), 'utf8');
  assert.ok(runbook.includes(ABSENT_PRE));
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 40\); not applied anywhere\. The production pin is pending\./);
  assert.match(runbook, /read-live \(2026-11-07\)\.\*\* Run 42331198486/);
  assert.ok(runbook.includes(pin.expected_live_definition_sha256));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.ok(runbook.includes(pin.source_sha256));
  assert.ok(runbook.includes(sha(releaseFunctionDefinitions(TEXT)[NAME].prosrc)));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql145-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [IDENTITY]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  // No predecessor; nothing supersedes, refuses after or depends on it.
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['runs_before', 'supersedes', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces, drops or re-grants the function.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
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

test('reviewed file and spec: one new DEFINER writer with the platform-owner and server-write gates, the leg and obligation checks, the API\'s INSERT and its narrowed ON CONFLICT update; the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [NAME]);
  const def = defs[NAME];
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'payment_transfers');
  assert.deepEqual(def.config, ['search_path=public, pg_temp']);
  const body = def.prosrc.replace(/--[^\n]*/g, '');
  // Gates first: the platform owner, then a server write path.
  assert.match(body, /^\s*DECLARE[\s\S]*?BEGIN\s+IF auth\.uid\(\) IS NULL OR NOT COALESCE\(public\.is_platform_owner\(\), false\) THEN\s+RAISE EXCEPTION 'billing_collection_leg_forbidden'\s+USING ERRCODE = '42501';\s+END IF;\s+IF NOT COALESCE\(public\.aws_money_write_allowed\(\), false\) THEN\s+RAISE EXCEPTION 'billing_collection_leg_not_server_write'\s+USING ERRCODE = '42501';/);
  // Only a tenant-collection-v2 leg: role, key, contract, period, leg type; status, environment, amount.
  assert.match(body, /_leg_role NOT IN \('wallet', 'ach_debit'\)/);
  assert.match(body, /v_suffix := CASE _leg_role WHEN 'wallet' THEN 'wallet' ELSE 'bank' END;/);
  assert.match(body, /v_period !~ '\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'/);
  assert.match(body, /\(_provider_metadata ->> 'collection_contract'\) IS DISTINCT FROM 'tenant-collection-v2'/);
  assert.match(body, /\(_provider_metadata ->> 'leg_type'\) IS DISTINCT FROM _leg_role/);
  assert.match(body, /_idempotency_key IS DISTINCT FROM \('billing-' \|\| v_period \|\| '-' \|\| _tenant_id::text \|\| '-' \|\| v_suffix\)/);
  assert.match(body, /_environment NOT IN \('production', 'sandbox'\)/);
  assert.match(body, /_status NOT IN \('due', 'submitted', 'settled'\)/);
  assert.match(body, /_amount_cents IS NULL OR _amount_cents <= 0/);
  // The obligation of that tenant and period, and the amount bound.
  assert.match(body, /FROM public\.tenant_maintenance_payments tmp\s+WHERE tmp\.id = v_obligation::uuid\s+AND tmp\.tenant_id = _tenant_id\s+AND tmp\.billing_period = v_period;/);
  assert.match(body, /IF v_due IS NULL OR _amount_cents \+ v_other > v_due THEN/);
  // The API's INSERT (fixed provider, fee, net, speed, submitted_at) and its ON CONFLICT update, same kind of leg only.
  assert.match(body, /VALUES \(_tenant_id, 'moov', _environment, _status, _idempotency_key, _amount_cents,\s+0, _amount_cents, 'standard', _description,/);
  assert.match(body, /ON CONFLICT \(tenant_id, idempotency_key\) DO UPDATE SET\s+provider_transfer_id = COALESCE\(EXCLUDED\.provider_transfer_id, pt\.provider_transfer_id\),\s+provider_status = COALESCE\(EXCLUDED\.provider_status, pt\.provider_status\),\s+status = EXCLUDED\.status,\s+updated_at = now\(\)\s+WHERE pt\.leg_role = EXCLUDED\.leg_role\s+AND \(pt\.provider_metadata ->> 'collection_contract'\) = 'tenant-collection-v2'/);
  assert.match(body, /RAISE EXCEPTION 'billing_collection_leg_conflict'\s+USING ERRCODE = '23505';/);
  // One write, an INSERT into payment_transfers; nothing else is written.
  assert.deepEqual([...body.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.[a-z_]+)?/gi)].map((m) => m[0].trim()),
    ['INSERT INTO public.payment_transfers', 'UPDATE']);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: IDENTITY, result: RESULT, acl: [...ACL], revokes: [...REVOKES] }]);
  assert.deepEqual(spec.prerequisites.slice(0, 7), ['public.payment_transfers', 'public.payment_transfers_idempotency_uniq',
    'public.tenant_maintenance_payments', 'public.is_platform_owner()', 'public.aws_money_write_allowed()', 'auth.uid()', 'role checksops']);
  // The file's prerequisite block names the same objects, and every column it checks is a spec prerequisite, and nothing else.
  const fileObjects = [...TEXT.matchAll(/^\s+\('([^']+)', (?:pg_catalog\.to_reg|\(SELECT r\.oid)/gm)].map((m) => m[1]);
  assert.deepEqual(fileObjects, spec.prerequisites.slice(0, 7));
  const fileColumns = [...TEXT.matchAll(/\('(payment_transfers|tenant_maintenance_payments)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.deepEqual(spec.prerequisites.slice(7), fileColumns);
  // Every column the INSERT writes is a checked prerequisite.
  const insertColumns = /INSERT INTO public\.payment_transfers AS pt\s+\(([^)]+)\)/.exec(body)[1].split(',').map((c) => `column public.payment_transfers.${c.trim()}`);
  for (const column of insertColumns) assert.ok(spec.prerequisites.includes(column), column);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC, the role REVOKE block, the GRANT.
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.equal([...code.matchAll(/\bDO\s+\$sql145_prereq\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bDO\s+\$sql145_revoke\$/g)].length, 1);
  assert.match(code, /sql145_prerequisite_missing/);
  assert.match(code, /sql145_definer_cannot_write/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].map((m) => m[0]).join('\n'), `GRANT EXECUTE ON FUNCTION public.${NAME}(${ARGS}) TO checksops;`);
  assert.equal([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]).join('\n'), `REVOKE ALL ON FUNCTION public.${NAME}(${ARGS}) FROM PUBLIC;`);
  const outsideBody = code.replace(def.prosrc.replace(/--[^\n]*/g, ''), '');
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/, /\bPOLICY\b/]) {
    assert.doesNotMatch(outsideBody, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [IDENTITY]);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql145 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=${RESULT} config=search_path=public, pg_temp prosrc=${sha(def.prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: the function absent passes; either relation unreachable or missing refuses; an existing function
  // owned by another role, with another grant or another result refuses; the revoked roles are revocable.
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
  assert.ok(pre({ prerequisites_missing: ['public.aws_money_write_allowed()'] }).includes('prerequisites_present'));
  assert.deepEqual(pre(fn(ACL)), []);
  assert.deepEqual(pre(fn([...REVOKES, ...ACL])), []);
  assert.deepEqual(pre(fn([...ACL, 'sql145_plain EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(ACL, { result: 'SETOF record' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: ABSENT_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 145 through the executor: the pre-state as derived; refused while a column is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql145-exec-', 60380, { extra: collectionLegSchema() });
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
    const present = async () => (await fx.admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;
    const executeAcl = async () => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
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
    await fx.admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN source_tenant_account_id TO source_moved');
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.payment_transfers.source_tenant_account_id'), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN source_moved TO source_tenant_account_id');
    assert.deepEqual((await inspect()).precondition_failures, []);
    assert.equal(await present(), false);

    // A pending pin cannot apply (pend a copy of the committed pin, the pre-state kept recorded).
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

    // One apply on the intended fingerprint: the function exists, owned by the login, EXECUTE for checksops and the owner.
    const applied = await apply(ABSENT_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((f) => f.state), ['intended']);
    assert.deepEqual(after.release_sql_inspect.function_acl, [{ name: `${NAME}(${ARGS})`, acl: [...ACL] }]);
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
