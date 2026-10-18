/**
 * SQL 102 (aws/workflows/sql/102_platform_owner_tenant_profile.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-101
 * (scripts/deployment-guard/lib/release-sql-state.mjs). release-sql90-97-executor.test.mjs runs
 * what every release key shares (SQL 102 included: pins allowlisted, refusals before
 * connecting, the reviewed-file and forbidden-statement checks, the read-only fake-client
 * inspect); this file covers what is new:
 *
 *   - the pin: staging wave 6 approved, read-live still to record (so pending), code-derived,
 *     selectable, packed, in step with the production pin; the file's bytes are authored by the
 *     pinned commit once it is set; predecessor and supersedes SQL 98; SQL 98 refuses after it;
 *   - the file creates the profile setter, the member removal, the profile column list and the
 *     audit trigger, and replaces SQL 98's aws_tenants_member_column_guard with the same
 *     attributes and ACL and only the platform owner's allowed list widened;
 *   - on PostgreSQL 16 (SQL 29 / 30 / 90-97 applied first, a non-superuser checksops_admin owning
 *     everything): refused before SQL 98 and with an extra EXECUTE grant; after SQL 98-101, one
 *     apply through the executor on the intended fingerprint; afterwards SQL 98 (and through it
 *     SQL 96 and SQL 93) still counts as applied while SQL 98's own fingerprint has moved on, but
 *     only while every other SQL 98 object matches; SQL 98 itself refuses (successors_not_applied).
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
  AUTHORIZED_SQL102_PLATFORM_OWNER_TENANT_PROFILE,
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
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseSupersededIntendedHash,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { STAGING_WAVE1, assertStagingPinState } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-18T12:00:00.000Z';
const KEY = 'sql102';
const GUARD = 'public.aws_tenants_member_column_guard()';
const IDENTITIES = Object.freeze([
  'public.aws_tenant_profile_columns()',
  'public.aws_platform_owner_set_tenant_profile(uuid, jsonb)',
  'public.aws_platform_owner_remove_tenant_member(uuid, uuid)',
  'public.aws_tenant_profile_audit_row()',
  GUARD,
]);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, fs.readFileSync(path.join(ROOT, PINS[key].filename), 'utf8')])));
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = (key) => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[key].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(key, overrides = {}) {
  const pin = overrides.pin || PINS[key];
  const rest = { ...overrides };
  delete rest.pin;
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
    expiry: '2026-10-18T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key) => releaseEvent(key, { action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql102-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 102 staging wave 6 (read-live to record, pending), code-derived, selectable, packed, in step with the production pin; predecessor and supersedes SQL 98', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL102_PLATFORM_OWNER_TENANT_PROFILE, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/102_platform_owner_tenant_profile.sql');
  assert.equal(pin.migration_id, '102_platform_owner_tenant_profile');
  assert.equal(spec.choice, 'sql102-platform-owner-tenant-profile');
  assert.equal(sha(TEXT[KEY]), pin.source_sha256);
  assert.deepEqual({ wave: STAGING_WAVE1[KEY].wave, approved: STAGING_WAVE1[KEY].approved }, { wave: 6, approved: '2026-10-18' });
  assertStagingPinState(assert, KEY, pin);
  assert.equal(releaseIntendedHash(KEY, TEXT[KEY]), pin.intended_replacement_sha256);
  // SQL 98 after SQL 102: every SQL 98 object, with the column guard as SQL 102 renders it.
  assert.deepEqual(Object.keys(pin.superseded_intended_sha256), ['sql98']);
  assert.equal(releaseSupersededIntendedHash('sql98', TEXT.sql98, KEY, TEXT[KEY]), pin.superseded_intended_sha256.sql98);
  assert.notEqual(pin.superseded_intended_sha256.sql98, releaseIntendedHash('sql98', TEXT.sql98));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql102-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], IDENTITIES);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), IDENTITIES);
  assert.deepEqual(spec.predecessors, ['sql98']);
  assert.deepEqual(spec.supersedes, ['sql98']);
  // Only SQL 102 supersedes SQL 98, and SQL 98 refuses once SQL 102's setter exists (like SQL 96 after SQL 98).
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql98')), ['sql102']);
  assert.deepEqual(RELEASE_SQL_SPECS.sql98.refuse_after, [{ key: 'sql102', object: 'public.aws_platform_owner_set_tenant_profile(uuid, jsonb)' }]);
  const prod = productionPin(KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, ['sql98']);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  // The pinned commit authored these bytes (skipped while the commit is pending or without that history).
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

test('reviewed file: the profile setter, member removal and audit trigger; SQL 98\'s guard with only the platform owner\'s list widened', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT[KEY]), TEXT[KEY]);
  const defs = releaseFunctionDefinitions(TEXT[KEY]);
  assert.deepEqual(Object.keys(defs).sort(), IDENTITIES.map((id) => id.replace(/^public\.|\(.*$/g, '')).sort());
  const ours = releaseIntendedState(KEY, TEXT[KEY]).functions;
  const sql98 = releaseIntendedState('sql98', TEXT.sql98).functions[GUARD];
  const { prosrc_sha256: newBody, ...newAttrs } = ours[GUARD];
  const { prosrc_sha256: oldBody, ...oldAttrs } = sql98;
  assert.deepEqual(newAttrs, oldAttrs);
  assert.notEqual(newBody, oldBody);
  // The guard body is SQL 98's with the platform owner's allowed list widened, nothing else.
  const was = "public.aws_tenant_pricing_columns() || ARRAY['deposits_enabled'];";
  const now = "public.aws_tenant_pricing_columns() || ARRAY['deposits_enabled']\n      || public.aws_tenant_profile_columns() || ARRAY['moov_environment'];";
  assert.equal(releaseFunctionDefinitions(TEXT.sql98).aws_tenants_member_column_guard.prosrc.replace(was, now), defs.aws_tenants_member_column_guard.prosrc);
  for (const id of IDENTITIES.slice(1, 4)) {
    assert.equal(ours[id].security_definer, true, id);
    assert.deepEqual(ours[id].config, ['row_security=off', 'search_path=public'], id);
  }
  assert.equal(ours['public.aws_platform_owner_set_tenant_profile(uuid, jsonb)'].result, 'jsonb');
  assert.equal(ours['public.aws_platform_owner_remove_tenant_member(uuid, uuid)'].result, 'jsonb');
  assert.equal(ours['public.aws_tenant_profile_audit_row()'].result, 'trigger');
  assert.equal(ours['public.aws_tenant_profile_columns()'].volatility, 'i');
  assert.equal(ours['public.aws_tenant_profile_columns()'].security_definer, false);
  assert.deepEqual(ours['public.aws_tenant_profile_audit_row()'].acl, ['owner EXECUTE']);
  assert.deepEqual(ours[GUARD].acl, ['PUBLIC EXECUTE', 'owner EXECUTE']);
  for (const id of IDENTITIES.slice(0, 3)) {
    assert.deepEqual(ours[id].acl, ['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'], id);
    assert.ok(TEXT[KEY].includes(`REVOKE ALL ON FUNCTION ${id} FROM PUBLIC;`), id);
    assert.ok(TEXT[KEY].includes(`GRANT EXECUTE ON FUNCTION ${id} TO checksops, authenticated;`), id);
  }
  assert.match(TEXT[KEY], /sql102_prerequisite_missing/);
  // The moov lock only reads payment_provider_accounts where it exists (nested IF, not AND).
  assert.match(defs.aws_platform_owner_set_tenant_profile.prosrc, /IF to_regclass\('public\.payment_provider_accounts'\) IS NOT NULL THEN\s+IF EXISTS/);
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, IDENTITIES);
  assert.deepEqual(scope.skip_triggers, ['public.tenants.aws_tenant_profile_audit']);
  for (const field of ['policies', 'tables', 'views', 'added_columns', 'column_acl', 'table_privileges', 'dropped_functions', 'indexes']) {
    assert.equal(RELEASE_SQL_SPECS[KEY][field], undefined, field);
  }
  assert.deepEqual(RELEASE_SQL_SPECS[KEY].altered_relations, ['public.tenants']);
});

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
  const fx = await releaseFixture(pg, prefix, port, { extra: sql98To100Schema() });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 102 through the executor: refused before SQL 98, ACL refusal, one apply on the intended fingerprint, SQL 98 superseded', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql102-exec-', 63700, async ({ admin, connectAs, applyPredecessors }) => {
  const seen = [];
  const connect = async () => {
    const client = await connectAs('checksops_admin');
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const inspect = async (key) => {
    seen.length = 0;
    const result = await handlerFor(connect)(inspectEvent(key));
    assert.equal(result.ok, true, `${key}: ${JSON.stringify(result)}`);
    assert.equal(seen[0], 'BEGIN READ ONLY', key);
    assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), `${key}: ${JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text)))}`);
    assert.doesNotMatch(JSON.stringify(result), /example\.invalid|checksopsadmin@/, key);
    return result.details.receipt;
  };
  // An execute-authorized, owner-approved copy of the staging pin (test only).
  const apply = async (key, live) => {
    const pin = Object.freeze({ ...PINS[key], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
    return handlerFor(connect, { pins: { [key]: pin } })(releaseEvent(key, { pin }));
  };
  const asOwner = async (keys) => {
    const c = await connectAs('checksops_admin');
    try {
      for (const key of keys) await c.query(TEXT[key]);
    } finally {
      await c.end();
    }
  };

  // Before SQL 98 (SQL 90-97 in): refused on the predecessor and on its own prerequisites.
  await applyPredecessors();
  await asOwner(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql96', 'sql97', 'sql95']);
  const early = await inspect(KEY);
  assert.deepEqual(early.release_sql_inspect.predecessors, { sql98: false });
  assert.ok(early.precondition_failures.includes('predecessors_applied'));
  assert.ok(early.precondition_failures.includes('prerequisites_present'));
  assert.deepEqual(early.release_sql_inspect.prerequisites_missing, ['public.aws_platform_owner_set_tenant_deposits_enabled(uuid, boolean)']);
  const refusedEarly = await apply(KEY, early.live_definition_sha256);
  assert.equal(refusedEarly.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(refusedEarly.details.failed.includes('predecessors_applied'));
  // The file itself refuses too (55000 sql102_prerequisite_missing).
  const direct = await connectAs('checksops_admin');
  try {
    await assert.rejects(direct.query(TEXT[KEY]), (e) => e.code === '55000' && /sql102_prerequisite_missing/.test(e.message));
  } finally {
    await direct.end();
  }

  await asOwner(['sql98', 'sql99', 'sql100', 'sql101']);
  assert.equal((await inspect('sql98')).already_applied, true);
  const r = await inspect(KEY);
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, { sql98: true });
  assert.equal(r.already_applied, false);
  assert.deepEqual(r.release_sql_inspect.functions.map((row) => row.state), ['absent', 'absent', 'absent', 'absent', 'different']);

  // An EXECUTE grant the file neither keeps nor revokes would survive CREATE OR REPLACE: refused.
  await admin.query('BEGIN');
  try {
    await admin.query(`GRANT EXECUTE ON FUNCTION ${GUARD} TO anon`);
    const state = (await readReleaseSqlState(admin, KEY)).details;
    assert.ok(releaseSharedPreconditionFailures(KEY, state, TEXT[KEY]).includes('function_acl_replaceable'));
  } finally {
    await admin.query('ROLLBACK');
  }
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`REVOKE EXECUTE ON FUNCTION ${GUARD} FROM PUBLIC`);
  assert.equal((await apply(KEY, r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`GRANT EXECUTE ON FUNCTION ${GUARD} TO PUBLIC`);

  const applied = await apply(KEY, r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect(KEY);
  assert.equal(after.already_applied, true);
  assert.ok(after.release_sql_inspect.functions.every((row) => row.state === 'intended'), JSON.stringify(after.release_sql_inspect.functions));
  assert.equal((await apply(KEY, r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);

  // SQL 98's own fingerprint has moved on (its guard is SQL 102's now), but SQL 98 still counts
  // as applied through SQL 102 (supersedes), and SQL 96 / SQL 93 through SQL 98.
  const s98 = await inspect('sql98');
  assert.equal(s98.already_applied, false);
  assert.ok(s98.precondition_failures.includes('successors_not_applied'), JSON.stringify(s98.precondition_failures));
  assert.equal(s98.release_sql_inspect.predecessors.sql96, true);
  assert.equal((await inspect('sql96')).release_sql_inspect.predecessors.sql93, true);
  assert.equal((await inspect(KEY)).release_sql_inspect.predecessors.sql98, true);
  // ...but only while every other SQL 98 object still matches: a drifted SQL 98 grant is no
  // longer SQL 98 applied, even with SQL 102's guard in place.
  await admin.query('REVOKE EXECUTE ON FUNCTION public.aws_tenant_deposits_enabled(uuid) FROM authenticated');
  try {
    const drifted = await inspect(KEY);
    assert.equal(drifted.already_applied, true);
    assert.equal(drifted.release_sql_inspect.predecessors.sql98, false);
    assert.equal((await inspect('sql96')).release_sql_inspect.predecessors.sql93, false);
  } finally {
    await admin.query('GRANT EXECUTE ON FUNCTION public.aws_tenant_deposits_enabled(uuid) TO checksops, authenticated');
  }
  assert.equal((await inspect(KEY)).release_sql_inspect.predecessors.sql98, true);
  // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
  await asOwner([KEY]);
  assert.equal((await inspect(KEY)).already_applied, true);
}));
