/**
 * SQL 128 (aws/workflows/sql/128_contractor_verification_from_compliance.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-127 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 128 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 27), code-derived, selectable, packed, in step with the production pin
 *     (execute true on production's own pre-state, derived from bytes); the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: contractor_verification_status(uuid) replaced, its body the supabase
 *     migration's with only the two document checks changed (helpers/sql128-contractor-verification-
 *     schema.mjs), STABLE, SECURITY DEFINER, search_path public, jsonb; EXECUTE for checksops and
 *     the owner (PUBLIC, anon, authenticated and service_role revoked); the orphan
 *     _trg_recompute_contractor_tier_from_docs() dropped; no table, column, view, policy, table
 *     grant or trigger; the prerequisites are the file's own; the ownership, result and ACL
 *     pre-conditions refuse;
 *   - on PostgreSQL 16 (the functions restored from the supabase migration): the inspect reports the
 *     restored state (derived here from the supabase bytes and the default ACL); refused while the
 *     function is missing, owned by another role or granted to a role the file does not revoke; a
 *     pending pin cannot apply; one apply through the executor reaches the intended fingerprint,
 *     then is refused as already in place.
 * The behavior (which uploads count, the review trigger) is aws/tests/sql128-contractor-verification-pg.test.mjs.
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
  AUTHORIZED_SQL128_CONTRACTOR_VERIFICATION_FROM_COMPLIANCE,
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
  DOCS_TRIGGER_IDENTITY,
  STATUS_IDENTITY,
  contractorVerificationSchema,
  sql128Body,
  supabaseBody,
  supabaseStatement,
} from './helpers/sql128-contractor-verification-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-30T12:00:00.000Z';
const KEY = 'sql128';
const FOR_CHECKSOPS = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const RESTORED_ACL = Object.freeze(['PUBLIC EXECUTE', 'owner EXECUTE']);
// Production's pre-state (read-only inspect of 2026-10-30): the restored ACL plus EXECUTE for checksops.
const PRODUCTION_ACL = Object.freeze(['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/**
 * The state the inspect reads on a database restored from the supabase migrations (pg_dump
 * --no-acl, aws/db-copy/FIRST_COPY_PROCEDURE.md): contractor_verification_status as SQL 128 leaves
 * it except the body (the supabase one) and EXECUTE (PUBLIC and the owner, the default); the docs
 * trigger function present (restored without its trigger) or absent. Derived from bytes.
 */
const restoredState = ({ docsTrigger = true } = {}) => {
  const want = releaseIntendedState(KEY, TEXT);
  return {
    functions: {
      [STATUS_IDENTITY]: { ...want.functions[STATUS_IDENTITY], prosrc_sha256: sha(supabaseBody('contractor_verification_status')), acl: [...RESTORED_ACL] },
      [DOCS_TRIGGER_IDENTITY]: docsTrigger
        ? {
          exists: true, language: 'plpgsql', volatility: 'v', parallel: 'u', security_definer: true, result: 'trigger',
          config: ['search_path=public'], prosrc_sha256: sha(supabaseBody('_trg_recompute_contractor_tier_from_docs')), acl: [...RESTORED_ACL],
        }
        : { exists: false },
    },
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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql128-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 128 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL128_CONTRACTOR_VERIFICATION_FROM_COMPLIANCE, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/128_contractor_verification_from_compliance.sql');
  assert.equal(pin.migration_id, '128_contractor_verification_from_compliance');
  assert.equal(spec.choice, 'sql128-contractor-verification-from-compliance');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-30) from staging read-live run 41042517205: the
  // restored supabase state with the orphan docs trigger function, so SQL 128 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-30: staging apply (wave 27) from staging read-live run 41042517205');
  assert.equal(pin.expected_live_definition_sha256, '8bd6b42d189ff05b77e19d178ddba0229a0d2b6bca0a2d1d98221774fa8fbc5f');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // The staging pre-state is the restored supabase state derived here (docs trigger function present).
  assert.equal(pin.expected_live_definition_sha256, releaseStateHash(KEY, restoredState()));
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent, and the restored supabase state (with or without the docs trigger
  // function), each have a fingerprint of their own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, restoredState()), pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, restoredState({ docsTrigger: false })), pin.intended_replacement_sha256);
  // The runbook names both restored pre-states (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-128-apply.md'), 'utf8');
  assert.ok(runbook.includes(releaseStateHash(KEY, restoredState())));
  assert.ok(runbook.includes(releaseStateHash(KEY, restoredState({ docsTrigger: false }))));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql128-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [STATUS_IDENTITY]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['runs_before', 'supersedes', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces or drops either function.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...other.functions.map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.deepEqual(touched.filter((identity) => [STATUS_IDENTITY, DOCS_TRIGGER_IDENTITY].includes(identity)), [], key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin applied 2026-10-30 and retired (owner-approved pin change, #1437, on the staging apply). Its
  // pre-state is production's own (read-only inspect SSM 54ccb458): the restored state with an extra
  // EXECUTE grant to checksops on both functions, derived here from the supabase bytes.
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-10-30; execute is false again/);
  assert.equal(prod.applied.receipt.before_hash, prod.expected_live_definition_sha256);
  assert.equal(prod.applied.receipt.after_hash, prod.intended_replacement_sha256);
  assert.equal(prod.expected_live_definition_sha256, '127bf5da500b4e5975686249b373ab0913f370ce5557292c5c49394e0ad775e8');
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
  const productionRestored = restoredState();
  for (const fn of Object.values(productionRestored.functions)) fn.acl = [...PRODUCTION_ACL];
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

test('reviewed file and spec: the supabase body with only the two document checks changed; EXECUTE for checksops and the owner; the orphan docs trigger function dropped; no table, view, policy, table grant or trigger; the file\'s prerequisites; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['contractor_verification_status']);
  const def = defs.contractor_verification_status;
  // The body: exactly the supabase migration's with SQL 128's edit (matching once).
  assert.equal(def.prosrc, sql128Body());
  assert.notEqual(def.prosrc, supabaseBody('contractor_verification_status'));
  assert.doesNotMatch(def.prosrc, /contractor_documents/);
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 's');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'jsonb');
  assert.deepEqual(def.config, ['search_path=public']);
  const header = supabaseStatement('contractor_verification_status');
  for (const re of [/RETURNS jsonb/, /LANGUAGE plpgsql/, /\bSTABLE\b/, /SECURITY DEFINER/, /SET search_path = public/]) assert.match(header.slice(0, header.indexOf('AS $$')), re);
  // Every document check is scoped to the profile's own user's tenants; reads only.
  const scoped = 'tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)';
  assert.equal(def.prosrc.split(scoped).length - 1, 4);
  assert.equal((def.prosrc.match(/\bFROM public\.(moov_compliance_documents|tenant_documents)\b/g) || []).length, 4);
  assert.equal((def.prosrc.match(/d\.status IN \('stored', 'sent'\)/g) || []).length, 2);
  assert.match(def.prosrc, /AND \(t\.expires_at IS NULL OR t\.expires_at >= CURRENT_DATE\)/);
  assert.doesNotMatch(def.prosrc, /\b(UPDATE|INSERT INTO|DELETE FROM)\s+(public\.)?[a-z_]+/);
  assert.doesNotMatch(def.prosrc, /row_security|SET\s+ROLE|\bGRANT\b|\bREVOKE\b/i);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: STATUS_IDENTITY, acl: [...FOR_CHECKSOPS], revokes: [...REVOKES] }]);
  assert.deepEqual(spec.dropped_functions, [DOCS_TRIGGER_IDENTITY]);
  // The file's ACL and DROP statements, nothing else.
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${STATUS_IDENTITY} FROM PUBLIC;`));
  assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION ${STATUS_IDENTITY} TO checksops;`));
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 1);
  assert.match(code, /FOREACH grantee IN ARRAY ARRAY\['anon', 'authenticated', 'service_role'\] LOOP\s+IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = grantee\) THEN/);
  assert.equal([...code.matchAll(/\bDROP\b/g)].length, 1);
  assert.ok(code.includes(`DROP FUNCTION IF EXISTS ${DOCS_TRIGGER_IDENTITY};`));
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i, /\bTRUNCATE\b/i, /\bALTER\s+(TABLE|VIEW|FUNCTION)\b/i,
    /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  // Every object and column the file's own prerequisite block names is a spec prerequisite.
  const prereqBlock = TEXT.slice(TEXT.indexOf('DO $sql128_prereq$'), TEXT.indexOf('$sql128_prereq$;'));
  const fileObjects = [...prereqBlock.matchAll(/\('([^']+)', to_reg/g)].map((m) => m[1]);
  const fileColumns = [...prereqBlock.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.deepEqual(fileObjects, spec.prerequisites.slice(0, fileObjects.length));
  assert.equal(fileColumns.length, 19);
  assert.deepEqual(spec.prerequisites, [...fileObjects, 'role checksops', ...fileColumns]);
  assert.match(prereqBlock, /WHERE rolname = 'checksops'/);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'definer_writes', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [STATUS_IDENTITY, DOCS_TRIGGER_IDENTITY]);
  assert.deepEqual(scope.skip_relations, []);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql128 v1',
    `function ${STATUS_IDENTITY}: lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=${sha(sql128Body())} acl=checksops EXECUTE;owner EXECUTE`,
    `function ${DOCS_TRIGGER_IDENTITY}: absent`,
  ]);

  // Pre-conditions: the function's owner, its result, an EXECUTE grant the file would not revoke.
  const restored = restoredState();
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {} };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const live = (identity, over = {}) => ({ ...restored.functions[identity], owner_is_login: true, ...over });
  const all = { [STATUS_IDENTITY]: live(STATUS_IDENTITY), [DOCS_TRIGGER_IDENTITY]: live(DOCS_TRIGGER_IDENTITY) };
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ functions: all }), []);
  assert.deepEqual(pre({ prerequisites_missing: ['public.moov_compliance_documents'] }), ['prerequisites_present']);
  assert.deepEqual(pre({ functions: { ...all, [STATUS_IDENTITY]: live(STATUS_IDENTITY, { acl: [...REVOKES, 'checksops EXECUTE', 'owner EXECUTE'] }) } }), []);
  assert.deepEqual(pre({ functions: { ...all, [STATUS_IDENTITY]: live(STATUS_IDENTITY, { acl: ['owner EXECUTE', 'reporting EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { ...all, [STATUS_IDENTITY]: live(STATUS_IDENTITY, { owner_is_login: false }) } }), ['functions_owned_by_login']);
  assert.deepEqual(pre({ functions: { ...all, [STATUS_IDENTITY]: live(STATUS_IDENTITY, { result: 'json' }) } }), ['function_results_match']);
  assert.ok(pre({ functions: { ...all, [DOCS_TRIGGER_IDENTITY]: live(DOCS_TRIGGER_IDENTITY, { owner_is_login: false }) } }).includes('dropped_functions_owned_by_login'));
  assert.ok(pre({ dependents: { [DOCS_TRIGGER_IDENTITY]: 1 } }).includes('dropped_functions_have_no_other_dependents'));
  assert.ok(pre({ dropped_function_callers: ['public.some_caller()'] }).includes('dropped_functions_not_called_by_other_functions'));
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const after = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [STATUS_IDENTITY]: { exists: true, owner_is_login: true }, [DOCS_TRIGGER_IDENTITY]: { exists: false } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after({ live_definition_sha256: 'f'.repeat(64) }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 128 through the executor: the restored state as derived; refused while the function is missing, owned by another role or granted beyond the revoked roles; production\'s pre-state as recorded, any other refused; a pending pin cannot apply; one apply from it on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql128-exec-', 59780, { extra: contractorVerificationSchema() });
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
    const body = async () => (await fx.admin.query(`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS h
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [STATUS_IDENTITY])).rows[0]?.h;
    const restoredBody = sha(supabaseBody('contractor_verification_status'));

    // The restored state: the supabase body, EXECUTE PUBLIC and the owner, the docs trigger
    // function present; the inspect's fingerprint is the one derived from those bytes.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, releaseStateHash(KEY, restoredState()));
    assert.equal(await body(), restoredBody);

    // The function missing: refused, nothing applied.
    await fx.admin.query('ALTER FUNCTION public.contractor_verification_status(uuid) RENAME TO contractor_verification_status_moved');
    const missing = await inspect();
    assert.deepEqual(missing.release_sql_inspect.prerequisites_missing, [STATUS_IDENTITY]);
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER FUNCTION public.contractor_verification_status_moved(uuid) RENAME TO contractor_verification_status');

    // Owned by another role: refused, nothing applied.
    await fx.admin.query('ALTER FUNCTION public.contractor_verification_status(uuid) OWNER TO ubuntu');
    const foreign = await inspect();
    assert.deepEqual(foreign.precondition_failures, ['functions_owned_by_login'], JSON.stringify(foreign.release_sql_inspect));
    assert.equal((await apply(foreign.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER FUNCTION public.contractor_verification_status(uuid) OWNER TO checksops_admin');

    // EXECUTE for a role the file does not revoke: refused (it would survive), nothing applied.
    await fx.admin.query('CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION public.contractor_verification_status(uuid) TO reporting');
    const granted = await inspect();
    assert.deepEqual(granted.precondition_failures, ['function_acl_replaceable'], JSON.stringify(granted.release_sql_inspect));
    assert.equal((await apply(granted.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('REVOKE EXECUTE ON FUNCTION public.contractor_verification_status(uuid) FROM reporting; DROP ROLE reporting');
    assert.equal(await body(), restoredBody);

    // EXECUTE for authenticated (the supabase grant, a role the file revokes): allowed; revoked again.
    await fx.admin.query('GRANT EXECUTE ON FUNCTION public.contractor_verification_status(uuid) TO authenticated');
    const wider = await inspect();
    assert.deepEqual(wider.precondition_failures, [], JSON.stringify(wider.release_sql_inspect));
    assert.notEqual(wider.live_definition_sha256, r.live_definition_sha256);
    await fx.admin.query('REVOKE EXECUTE ON FUNCTION public.contractor_verification_status(uuid) FROM authenticated');

    // Production's pre-state (read-only inspect of 2026-10-30): the restored state plus EXECUTE for
    // checksops on both functions. The inspect reads the production pin's recorded pre-state.
    await fx.admin.query(`GRANT EXECUTE ON FUNCTION public.contractor_verification_status(uuid) TO checksops;
      GRANT EXECUTE ON FUNCTION public._trg_recompute_contractor_tier_from_docs() TO checksops`);
    const production = await inspect();
    assert.deepEqual(production.precondition_failures, [], JSON.stringify(production.release_sql_inspect));
    assert.deepEqual(production.release_sql_inspect.prerequisites_missing, []);
    assert.equal(production.already_applied, false);
    assert.equal(production.live_definition_sha256, productionPin().expected_live_definition_sha256);
    assert.notEqual(production.live_definition_sha256, r.live_definition_sha256);
    // Any other recorded pre-state is refused: staging's, the authenticated grant's.
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal((await apply(wider.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: production.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.equal(await body(), restoredBody);

    const applied = await apply(production.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, production.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(await body(), sha(sql128Body()));
    const row = (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile,
        has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        to_regprocedure('public._trg_recompute_contractor_tier_from_docs()') IS NULL AS docs_dropped
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [STATUS_IDENTITY])).rows[0];
    assert.deepEqual(row, { owner: 'checksops_admin', prosecdef: true, provolatile: 's', checksops: true, authenticated: false, docs_dropped: true });
    assert.equal((await apply(production.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
