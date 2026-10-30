/**
 * SQL 117 (aws/workflows/sql/117_platform_owner_tenant_lifecycle.sql) in the staging guarded
 * executor and the shared release engine (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 117 included); this
 * file covers SQL 117's own:
 *
 *   - the pin: retired after its staging apply rolled back (wave 18; SQL 118 replaces it), code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor, nothing supersedes or needs it;
 *   - the reviewed file and spec: the six functions as the engine parses them (with
 *     aws_platform_owner_deactivated_tenants()'s RETURNS TABLE result stated in the spec), the new
 *     table, the pre- and post-conditions;
 *   - on PostgreSQL 16 (after the real SQL 90 to SQL 102 files): one apply through the executor
 *     reaches the intended fingerprint, then is refused as already in place; a pending pin cannot
 *     apply; drift between the recorded pre-state and the apply refuses.
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
  AUTHORIZED_SQL117_PLATFORM_OWNER_TENANT_LIFECYCLE,
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
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { REPO_ROOT, pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-27T00:00:00.000Z';
const KEY = 'sql117';
const TABLE = 'public.tenant_deactivations';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
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
    expiry: '2026-10-27T01:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql117-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

const FUNCTIONS = Object.freeze([
  'public.aws_tenant_activity_tables()',
  'public.aws_platform_owner_tenant_activity(uuid)',
  'public.aws_platform_owner_deactivate_tenant(uuid, text)',
  'public.aws_platform_owner_reactivate_tenant(uuid)',
  'public.aws_platform_owner_delete_empty_tenant(uuid, text)',
  'public.aws_platform_owner_deactivated_tenants()',
]);

test('pin: SQL 117 retired (SQL 118 replaces it), code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.equal(AUTHORIZED_SQL117_PLATFORM_OWNER_TENANT_LIFECYCLE, pin);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(pin.filename, 'aws/workflows/sql/117_platform_owner_tenant_lifecycle.sql');
  assert.equal(pin.migration_id, '117_platform_owner_tenant_lifecycle');
  assert.equal(spec.choice, 'sql117-platform-owner-tenant-lifecycle');
  assert.equal(MIGRATIONS[spec.choice], pin);
  assertStagingPinState(assert, KEY, pin);
  // Retired: staging apply run 40434533070 rolled back (the new table kept default-privilege
  // grants), so the pin can never execute again; its read-live pre-state stays recorded.
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'Retired 2026-10-27: superseded by SQL 118 after staging apply run 40434533070 rolled back; never applied');
  assert.equal(pin.expected_live_definition_sha256, 'dcfcb810a7d016f63451a3cf6ec00982be2f555fae087871885e49cc4b501956');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.source_sha256, sha(TEXT));
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, TEXT));
  assert.equal(pin.intended_replacement_sha256, 'aceed4572b39db76bc12258f1f707ec4b6d78ebcec730a5dbee2bb1999677e00');
  assert.deepEqual([...pin.function_identities], FUNCTIONS);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), FUNCTIONS);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === pin.filename && to === 'sql/117_platform_owner_tenant_lifecycle.sql'));
  assert.deepEqual(resolveAuthorizedMigration({ filename: pin.filename, migration_id: pin.migration_id }), pin);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.match(workflow, /- sql117-platform-owner-tenant-lifecycle\n/);
  assert.match(workflow, /node --test aws\/tests\/release-sql117-executor\.test\.mjs/);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((r) => r.key === KEY)), ['sql118']);
  // No other release migration creates the table or the functions.
  // Only SQL 118, which supersedes it, creates the same table and functions.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => key !== KEY && (RELEASE_SQL_SPECS[key].tables || []).some((t) => t.name === TABLE)), ['sql118']);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => key !== KEY && RELEASE_SQL_SPECS[key].functions.some((fn) => FUNCTIONS.includes(fn.identity))), ['sql118']);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, FUNCTIONS);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.expected_live_definition_sha256, null);
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

test('reviewed file and spec: six functions as parsed, the RETURNS TABLE result stated, the new table; pre- and post-conditions', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const code = TEXT;
  assert.match(code, /RAISE EXCEPTION 'sql117_prerequisite_missing: /);
  assert.match(code, /CREATE TABLE IF NOT EXISTS public\.tenant_deactivations \(/);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), FUNCTIONS.map((f) => /^public\.([a-z0-9_]+)\(/.exec(f)[1]).sort());
  // The file's RETURNS TABLE (...) parses to the word TABLE; the spec states the rendered result.
  assert.equal(defs.aws_platform_owner_deactivated_tenants.result, 'table');
  const intended = releaseIntendedState(KEY, TEXT);
  assert.equal(intended.functions['public.aws_platform_owner_deactivated_tenants()'].result,
    'TABLE(tenant_id uuid, deactivated_at timestamp with time zone, deactivated_by uuid, reason text, previous_subscription_status text, suspended_memberships integer)');
  assert.equal(intended.functions['public.aws_tenant_activity_tables()'].security_definer, false);
  for (const identity of FUNCTIONS.filter((f) => f !== 'public.aws_tenant_activity_tables()')) {
    const fn = intended.functions[identity];
    assert.equal(fn.security_definer, true, identity);
    assert.deepEqual(fn.config, ['row_security=off', 'search_path=public, pg_temp'], identity);
    assert.deepEqual(fn.acl, ['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'], identity);
  }
  // The engine change states a result only where the spec names one: every other release key's
  // intended fingerprint is the one its pin records.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    // SQL 122 states its row-type results (public.<table>) the same way; SQL 124 its two
    // TABLE (...) results and one row-type result.
    if (!['sql118', 'sql122', 'sql124', 'sql126', 'sql129', 'sql130'].includes(key)) assert.ok(RELEASE_SQL_SPECS[key].functions.every((fn) => fn.result === undefined), key);
    const text = fs.readFileSync(FILES[key], 'utf8');
    if (PINS[key].superseded_intended_sha256 == null) assert.equal(releaseIntendedHash(key, text), PINS[key].intended_replacement_sha256, key);
  }
  assert.deepEqual(intended.tables[TABLE].columns.map((c) => c.name), ['tenant_id', 'deactivated_at', 'deactivated_by', 'reason', 'previous_subscription_status', 'memberships']);
  assert.equal(intended.tables[TABLE].rls, true);
  assert.deepEqual(intended.tables[TABLE].acl, []);
  assert.deepEqual(spec.definer_writes, ['public.tenant_users', 'public.tenants', 'public.tenant_pricing_audit']);
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_relations, [TABLE]);
  assert.deepEqual([...scope.skip_functions].sort(), [...FUNCTIONS].sort());
  // Pre-conditions: absent objects pass; a table of another shape refuses; the prerequisites are required.
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], definer: Object.fromEntries(spec.definer_writes.map((t) => [t, true])) };
  const absent = { functions: Object.fromEntries(FUNCTIONS.map((f) => [f, { exists: false }])), tables: { [TABLE]: { exists: false } } };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...absent, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.ok(pre({ tables: { [TABLE]: { ...intended.tables[TABLE], columns: intended.tables[TABLE].columns.slice(1) } } }).includes('created_tables_absent_or_intended'));
  assert.ok(pre({ prerequisites_missing: ['public.tenant_pricing_audit'] }).includes('prerequisites_present'));
  assert.ok(pre({ definer: { ...base.definer, 'public.tenants': false } }).includes('definer_can_write_relations'));
  // The intended objects are the intended state; nothing is another state.
  assert.equal(releaseStateHash(KEY, intended), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, absent), PINS[KEY].intended_replacement_sha256);
  const pin = PINS[KEY];
  // Post-conditions: the intended fingerprint, the table and functions owned by the login.
  const owned = {
    functions: Object.fromEntries(FUNCTIONS.map((f) => [f, { exists: true, owner_is_login: true }])),
    tables: { [TABLE]: { exists: true, owner_is_login: true } },
  };
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { ...owned, live_definition_sha256: pin.intended_replacement_sha256 }, pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { ...owned, live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
});

const sql = (name) => fs.readFileSync(path.join(REPO_ROOT, 'aws/workflows/sql', name), 'utf8');
const BEFORE = Object.freeze([
  '90_users_only_tenant_roles.sql', '91_moov_onboarding.sql', '92_signature_request_check_files_link_grant.sql',
  '93_tenant_company_info.sql', '94_document_library_restore.sql', '96_platform_owner_tenant_pricing.sql',
  '97_financial_stepup_log_server_writer.sql', '95_remove_freedom_claims_bridge.sql', '98_tenant_fee_collection.sql',
  '99_mortgage_desk_completion_messages.sql', '100_mortgage_desk_live_access.sql', '101_invite_identity_insert_order.sql',
  '102_platform_owner_tenant_profile.sql',
]);
const LIFECYCLE_SCHEMA = `
ALTER TABLE public.tenants ADD COLUMN slug text UNIQUE, ADD COLUMN custom_domain text UNIQUE,
  ADD COLUMN max_checks_per_month integer DEFAULT 100, ADD COLUMN is_test_account boolean NOT NULL DEFAULT false,
  ADD COLUMN moov_environment text NOT NULL DEFAULT 'sandbox', ADD COLUMN kyc_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN kyc_notes text, ADD COLUMN internal_notes text,
  ADD COLUMN is_system_tenant boolean NOT NULL DEFAULT false, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.tenant_users ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.payment_provider_accounts ADD COLUMN provider text NOT NULL DEFAULT 'moov';
`;

async function withPg(t, prefix, port, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [...sql98To100Schema(), LIFECYCLE_SCHEMA] });
  try {
    await fx.applyPredecessors();
    const owner = await fx.connectAs('checksops_admin');
    try {
      for (const file of BEFORE) await owner.query(sql(file));
    } finally {
      await owner.end();
    }
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 117 through the executor: a pending pin cannot apply, drift refused, one apply on the intended fingerprint, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql117-exec-', 60317, async ({ admin, connectAs }) => {
  const seen = [];
  const connect = async () => {
    const client = await connectAs('checksops_admin');
    const query = client.query.bind(client);
    client.query = (text, params) => { seen.push(String(text)); return query(text, params); };
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
  const absentNow = async () => (await admin.query("SELECT to_regclass('public.tenant_deactivations') IS NULL AS a")).rows[0].a;

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.equal(r.already_applied, false);
  assert.equal(await absentNow(), true);
  // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query('CREATE FUNCTION public.aws_tenant_activity_tables() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY[]::text[] $$');
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await owner.query('DROP FUNCTION public.aws_tenant_activity_tables()');
  } finally {
    await owner.end();
  }

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  assert.equal(await absentNow(), false);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
