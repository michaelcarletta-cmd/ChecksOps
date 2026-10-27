/**
 * SQL 121 (aws/workflows/sql/121_cash_jobs_production_grants.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-120 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 121 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 21), code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: one new owner-only definer function and its trigger on checkalt_deposits;
 *     sync_cash_job_check_payment() made SECURITY DEFINER with search_path public, pg_temp and
 *     EXECUTE for the owner only, its body the reviewed one (re-derived from its Supabase migration);
 *     SELECT / INSERT / UPDATE / DELETE on the three cash-job tables for checksops and authenticated;
 *     no grant on cash_job_payments, no table, column or policy; the engine's acl_functions
 *     attributes leave SQL 103's and SQL 119's fingerprints as they were; the body, ACL, definer-write
 *     and ownership pre-conditions refuse;
 *   - on PostgreSQL 16: refused while checkalt_deposits is missing; refused while the function's
 *     body is not the reviewed one; a pending pin cannot apply; one apply through the executor
 *     reaches the intended fingerprint, then is refused as already in place.
 * The behavior (grants, the definer payment trigger, the Check Alt trigger) is
 * aws/tests/sql121-cash-jobs-pg.test.mjs.
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
  AUTHORIZED_SQL121_CASH_JOBS_PRODUCTION_GRANTS,
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
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { CHECK_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-27T12:00:00.000Z';
const KEY = 'sql121';
const NEW_FN = 'public.aws_record_cash_job_checkalt_payment()';
const SYNC_FN = 'public.sync_cash_job_check_payment()';
const CASH_TABLES = ['public.cash_jobs', 'public.cash_job_line_items', 'public.cash_job_attachments'];
// The migration that defines sync_cash_job_check_payment() (the reviewed body SQL 121 makes SECURITY DEFINER).
const SUPABASE_SYNC_FILE = 'supabase/migrations/20260522142101_6c46a740-87fc-48ab-afd4-07af285f1ae3.sql';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SUPABASE_SYNC = fs.readFileSync(path.join(ROOT, SUPABASE_SYNC_FILE), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

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
    expiry: '2026-10-27T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql121-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// The cash-job tables (RLS on, checksops SELECT only, as the restored database leaves them), the
// check_intake_items columns SQL 121 reads, and sync_cash_job_check_payment() with its trigger from
// its own Supabase migration (the reviewed body). checkalt_deposits is added only after the first
// inspect (the prerequisite refusal).
const CASH_SCHEMA = `
CREATE TABLE public.cash_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, contract_amount numeric NOT NULL DEFAULT 0,
  total_paid numeric NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'estimate', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cash_job_line_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cash_job_id uuid);
CREATE TABLE public.cash_job_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cash_job_id uuid);
CREATE TABLE public.cash_job_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cash_job_id uuid NOT NULL, created_by uuid,
  amount numeric NOT NULL, payment_method text, payment_date date, reference_number text, notes text,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.cash_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_job_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_job_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_job_payments ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.cash_jobs, public.cash_job_line_items, public.cash_job_attachments, public.cash_job_payments TO checksops;
ALTER TABLE public.check_intake_items ADD COLUMN IF NOT EXISTS amount numeric, ADD COLUMN IF NOT EXISTS uploaded_by uuid;
${SUPABASE_SYNC};
GRANT EXECUTE ON FUNCTION public.sync_cash_job_check_payment() TO checksops;`;
const CHECKALT_SCHEMA = `
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, tenant_id uuid,
  status text NOT NULL DEFAULT 'pending', submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.checkalt_deposits ENABLE ROW LEVEL SECURITY;
INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ('${CHECK_A}', '${TENANT_A}', 'cleared');`;

test('pin: SQL 121 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL121_CASH_JOBS_PRODUCTION_GRANTS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/121_cash_jobs_production_grants.sql');
  assert.equal(pin.migration_id, '121_cash_jobs_production_grants');
  assert.equal(spec.choice, 'sql121-cash-jobs-grants');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-27) from staging read-live run 40588277757: the
  // new function and its trigger absent and sync_cash_job_check_payment() not yet SECURITY DEFINER,
  // so SQL 121 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-27: staging apply (wave 21) from staging read-live run 40588277757');
  assert.equal(pin.expected_live_definition_sha256, '084deae36bb533c91124d12698b1adb29e5fa7b9ff53932aa293537bc573e76e');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent (a database without SQL 121) has a fingerprint of its own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql121-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [NEW_FN, SYNC_FN]);
  assert.deepEqual([...pin.function_identities],
    [...spec.functions.map((fn) => fn.identity), ...spec.acl_functions.map((fn) => fn.identity)]);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-27) on the staging apply. Its
  // pre-state is production's own (read-only inspect SSM b76e02f3): it differs from staging's by the
  // checksops EXECUTE on sync_cash_job_check_payment() that the file revokes.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-27 /);
  assert.equal(prod.expected_live_definition_sha256, 'ded8c0f12bdb33d0d5c7cc6d544ddddac5a87db5696d5901fb2ffcaff338a790');
  assert.notEqual(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
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

test('reviewed file and spec: one owner-only definer function and its trigger, the payment trigger function made definer with the reviewed body, the three table grants; no other grant, table, column or policy; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_record_cash_job_checkalt_payment']);
  const fn = defs.aws_record_cash_job_checkalt_payment;
  assert.equal(fn.security_definer, true);
  assert.equal(fn.result, 'trigger');
  assert.equal(fn.language, 'plpgsql');
  assert.deepEqual(fn.config, ['row_security=off', 'search_path=public, pg_temp']);
  // It writes only cash_job_payments (an insert, and a delete of the automatic payment).
  assert.deepEqual([...new Set([...fn.prosrc.matchAll(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]))],
    ['public.cash_job_payments']);
  // Approved or accepted only, once per check; removal only after an approval, only the automatic
  // payment, only when no other deposit is approved and the check is not deposited.
  assert.match(fn.prosrc, /v_new IN \('submitted', 'cleared'\) AND v_old NOT IN \('submitted', 'cleared'\)/);
  assert.match(fn.prosrc, /v_new IN \('rejected', 'error', 'duplicate'\) AND v_old IN \('submitted', 'cleared'\)/);
  assert.match(fn.prosrc, /v_check\.check_source IS DISTINCT FROM 'cash_job' OR v_check\.cash_job_id IS NULL/);
  assert.match(fn.prosrc, /AND p\.reference_number = v_check\.id::text\s+AND p\.payment_method = 'check';/);
  assert.match(fn.prosrc, /v_check\.status IS DISTINCT FROM 'deposited'/);
  // The insert is the one sync_cash_job_check_payment() makes (same columns, values and notes).
  const sync = releaseFunctionDefinitions(SUPABASE_SYNC).sync_cash_job_check_payment;
  const insertOf = (body) => /INSERT INTO public\.cash_job_payments \(([\s\S]*?)\) VALUES/.exec(body)[1].replace(/\s+/g, ' ').trim();
  assert.equal(insertOf(fn.prosrc), insertOf(sync.prosrc));
  for (const note of ['Initial deposit check via ChecksOps', 'Final payment check via ChecksOps', 'Progress payment check via ChecksOps', 'Check deposit via ChecksOps']) {
    assert.ok(fn.prosrc.includes(`'${note}'`) && sync.prosrc.includes(`'${note}'`), note);
  }

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{
    identity: NEW_FN,
    acl: ['owner EXECUTE grantor=owner'],
    revokes: ['PUBLIC EXECUTE grantor=owner', 'authenticated EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner'],
  }]);
  // sync_cash_job_check_payment(): the reviewed body is the one its Supabase migration defines.
  assert.equal(spec.acl_functions.length, 1);
  const acl = spec.acl_functions[0];
  assert.equal(acl.identity, SYNC_FN);
  assert.deepEqual(acl.acl, ['owner EXECUTE grantor=owner']);
  assert.deepEqual(acl.revokes, ['PUBLIC EXECUTE grantor=owner', 'authenticated EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner']);
  assert.deepEqual(acl.attributes, { security_definer: true, config: ['search_path=public, pg_temp'], prosrc_sha256: sha(sync.prosrc) });
  assert.equal(sync.security_definer, false);
  assert.deepEqual(sync.config, ['search_path=public']);
  // The file sets exactly those attributes and revokes those grantees.
  assert.match(TEXT, /ALTER FUNCTION public\.sync_cash_job_check_payment\(\) SECURITY DEFINER;/);
  assert.match(TEXT, /ALTER FUNCTION public\.sync_cash_job_check_payment\(\) SET search_path = public, pg_temp;/);
  assert.match(TEXT, /REVOKE ALL ON FUNCTION public\.sync_cash_job_check_payment\(\) FROM PUBLIC;/);
  assert.match(TEXT, /REVOKE ALL ON FUNCTION public\.aws_record_cash_job_checkalt_payment\(\) FROM PUBLIC;/);
  assert.equal([...TEXT.matchAll(/FOREACH v_grantee IN ARRAY ARRAY\['checksops', 'authenticated'\] LOOP/g)].length, 3);
  // Grants: SELECT, INSERT, UPDATE, DELETE only, on the three tables only, to checksops and authenticated only.
  assert.match(TEXT, /FOREACH v_table IN ARRAY ARRAY\['cash_jobs', 'cash_job_line_items', 'cash_job_attachments'\] LOOP/);
  assert.match(TEXT, /'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO %I'/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 1);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|VIEW|INDEX)\b/i, /\bALTER\s+TABLE\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i,
    /\bDROP\s+(?!TRIGGER IF EXISTS aws_checkalt_deposit_cash_job_payment ON public\.checkalt_deposits;)/i, /cash_job_payments TO/i, /\banon\b/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.deepEqual(spec.table_privileges.map((p) => p.table), CASH_TABLES);
  for (const p of spec.table_privileges) {
    assert.deepEqual(p.grantees, ['authenticated', 'checksops']);
    assert.deepEqual(p.privileges, ['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    assert.deepEqual(p.intended, ['authenticated', 'checksops'].flatMap((g) => ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((v) => `${g} ${v} grantor=owner`)));
  }
  assert.deepEqual(spec.triggers, [{
    table: 'public.checkalt_deposits',
    name: 'aws_checkalt_deposit_cash_job_payment',
    def: 'CREATE TRIGGER aws_checkalt_deposit_cash_job_payment AFTER INSERT OR UPDATE OF status ON public.checkalt_deposits FOR EACH ROW EXECUTE FUNCTION public.aws_record_cash_job_checkalt_payment()',
  }]);
  assert.deepEqual(spec.definer_writes, ['public.cash_job_payments', 'public.cash_jobs']);
  assert.deepEqual(spec.altered_relations, [...CASH_TABLES, 'public.checkalt_deposits']);
  assert.deepEqual(spec.render, { grantors: true });
  for (const absent of ['tables', 'added_columns', 'policies', 'column_acl', 'indexes', 'unique_covers', 'dropped_functions', 'whole_tables', 'counts']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.match(TEXT, /Not changed: no grant on public\.cash_job_payments;/);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql121 v1\n/);
  assert.match(text, /\nfunction_acl public\.sync_cash_job_check_payment\(\): acl=owner EXECUTE grantor=owner secdef=true config=search_path=public, pg_temp prosrc=[0-9a-f]{64}\n/);
  assert.match(text, /\ntrigger public\.checkalt_deposits aws_checkalt_deposit_cash_job_payment: enabled=O def=[0-9a-f]{64}\n/);
  assert.match(text, /\nprivileges public\.cash_job_attachments SELECT,INSERT,UPDATE,DELETE: authenticated DELETE grantor=owner;/);
  // The attributes are only in entries that declare them: SQL 103's and SQL 119's state is as before.
  for (const key of ['sql103', 'sql119']) {
    const own = fs.readFileSync(path.join(ROOT, PINS[key].filename), 'utf8');
    assert.equal(releaseIntendedHash(key, own), PINS[key].intended_replacement_sha256, key);
    assert.doesNotMatch(releaseStateText(key, releaseIntendedState(key, own)), /secdef=/, key);
  }

  // Pre-conditions: the body, the ACL, the definer writes and the ownership.
  const want = releaseIntendedState(KEY, TEXT);
  const liveSync = (over = {}) => ({
    exists: true, owner_is_login: true, language: 'plpgsql', volatility: 'v', parallel: 'u', security_definer: false, result: 'trigger',
    config: ['search_path=public'], prosrc_sha256: sha(sync.prosrc), acl: ['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'], ...over,
  });
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    altered: Object.fromEntries([...CASH_TABLES, 'public.checkalt_deposits'].map((t) => [t, { exists: true, owner_is_login: true }])),
    acl_functions: { [SYNC_FN]: liveSync() },
    definer: { 'public.cash_job_payments': true, 'public.cash_jobs': true },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ acl_functions: { [SYNC_FN]: liveSync({ prosrc_sha256: 'f'.repeat(64) }) } }), ['acl_functions_body_reviewed']);
  assert.deepEqual(pre({ acl_functions: { [SYNC_FN]: liveSync({ acl: ['anon EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'] }) } }), ['acl_functions_acl_replaceable']);
  assert.deepEqual(pre({ acl_functions: { [SYNC_FN]: liveSync({ owner_is_login: false }) } }), ['acl_functions_owned_by_login']);
  assert.deepEqual(pre({ acl_functions: { [SYNC_FN]: { exists: false } } }), ['acl_functions_present']);
  assert.deepEqual(pre({ definer: { 'public.cash_job_payments': true, 'public.cash_jobs': false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ altered: { ...base.altered, 'public.cash_jobs': { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  // Post-conditions: SECURITY DEFINER and search_path may change; the body may not.
  const after = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [NEW_FN]: { exists: true, owner_is_login: true } },
    acl_functions: { [SYNC_FN]: liveSync({ security_definer: true, config: ['search_path=public, pg_temp'], acl: ['owner EXECUTE grantor=owner'], ...over }) },
    privileges: Object.fromEntries(CASH_TABLES.map((t) => [t, { exists: true, other: [] }])),
  });
  const before = { acl_functions: { [SYNC_FN]: liveSync() }, privileges: Object.fromEntries(CASH_TABLES.map((t) => [t, { exists: true, other: [] }])) };
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, after(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, after({ prosrc_sha256: 'f'.repeat(64) }), PINS[KEY]), ['acl_functions_otherwise_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, after({ volatility: 's' }), PINS[KEY]), ['acl_functions_otherwise_unchanged']);
  assert.equal(want.acl_functions[SYNC_FN].prosrc_sha256, sha(sync.prosrc));
});

test('PostgreSQL 16: SQL 121 through the executor: refused without checkalt_deposits and with another body, a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql121-exec-', 59510, { extra: [CASH_SCHEMA] });
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
    const owner = async (sql) => {
      const client = await connectAs('checksops_admin');
      try {
        return await client.query(sql);
      } finally {
        await client.end();
      }
    };

    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.prerequisites_missing, [
      'public.checkalt_deposits', 'column public.checkalt_deposits.id', 'column public.checkalt_deposits.check_intake_item_id',
      'column public.checkalt_deposits.status',
    ]);
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(CHECKALT_SCHEMA);
    await fx.admin.query('ALTER TABLE public.checkalt_deposits OWNER TO checksops_admin');

    // The function's body is not the reviewed one: refused, nothing applied.
    const reviewed = (await fx.admin.query("SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = 'public.sync_cash_job_check_payment()'::regprocedure")).rows[0].prosrc;
    await owner(`CREATE OR REPLACE FUNCTION public.sync_cash_job_check_payment() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ BEGIN RETURN NEW; END $$`);
    const other = await inspect();
    assert.deepEqual(other.precondition_failures, ['acl_functions_body_reviewed'], JSON.stringify(other.release_sql_inspect));
    assert.equal(other.release_sql_inspect.acl_functions[0].body_reviewed, false);
    assert.equal((await apply(other.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await owner(`CREATE OR REPLACE FUNCTION public.sync_cash_job_check_payment() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$${reviewed}$$`);

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    assert.notEqual(r.live_definition_sha256, releaseStateHash(KEY, {}));
    const syncReport = r.release_sql_inspect.acl_functions[0];
    assert.deepEqual([syncReport.name, syncReport.state, syncReport.security_definer, syncReport.config, syncReport.body_reviewed],
      ['sync_cash_job_check_payment()', 'different', false, ['search_path=public'], true]);
    assert.deepEqual(syncReport.acl, ['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner']);
    assert.deepEqual(r.release_sql_inspect.table_privileges.map((p) => [p.name, p.lines]),
      CASH_TABLES.map((table) => [table.replace(/^public\./, ''), ['checksops SELECT grantor=owner']]));
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.equal((await fx.admin.query("SELECT has_table_privilege('checksops', 'public.cash_jobs', 'INSERT') AS ok")).rows[0].ok, false);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.release_sql_inspect.acl_functions[0].state, 'intended');
    assert.equal((await fx.admin.query("SELECT has_table_privilege('checksops', 'public.cash_jobs', 'INSERT') AS ok")).rows[0].ok, true);
    assert.equal((await fx.admin.query("SELECT has_table_privilege('checksops', 'public.cash_job_payments', 'INSERT') AS ok")).rows[0].ok, false);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
