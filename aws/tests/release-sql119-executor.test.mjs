/**
 * SQL 119 (aws/workflows/sql/119_provider_stakeholder_sync_acl.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-118 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 119 included); this
 * file covers what is new:
 *
 *   - the pin: pending (execute false, no recorded pre-state), code-derived, selectable, packed,
 *     in step with the production pin; the pinned commit authored the bytes; no predecessor; runs
 *     before SQL 115;
 *   - the spec's acl_functions entry (SQL 119 creates or replaces no function): the fingerprint
 *     is the function's ACL with grantors, owner only; the unrelated snapshot skips the function
 *     and the post-conditions require the rest of it unchanged;
 *   - the file: one guard block, one REVOKE and one block for the optional roles, nothing else;
 *   - on PostgreSQL 16 (production's ACL: PUBLIC, checksops and owner EXECUTE): the file refuses
 *     a missing function (55000) and a login that does not own it (42501); the engine refuses an
 *     entry granted by another role; one apply through the executor reaches the intended
 *     fingerprint, then is refused as already in place.
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
  AUTHORIZED_SQL119_PROVIDER_STAKEHOLDER_SYNC_ACL,
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
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { PROVIDER_STAKEHOLDER_SCHEMA, SYNC_FUNCTION } from './helpers/sql115-provider-stakeholder-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-27T12:00:00.000Z';
const KEY = 'sql119';
const FN = SYNC_FUNCTION;
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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql119-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 119 pending, code-derived, selectable, packed, in step with the production pin; no predecessor, runs before SQL 115', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL119_PROVIDER_STAKEHOLDER_SYNC_ACL, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/119_provider_stakeholder_sync_acl.sql');
  assert.equal(pin.migration_id, '119_provider_stakeholder_sync_acl');
  assert.equal(spec.choice, 'sql119-provider-stakeholder-sync-acl');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql119-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [FN]);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.runs_before, ['sql115']);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 119, supersedes it or needs it as a predecessor.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 115 is the migration it unblocks: the same function, whose intended ACL is the owner's only.
  assert.deepEqual(RELEASE_SQL_SPECS.sql115.functions.map((fn) => fn.identity), [FN]);
  assert.deepEqual(RELEASE_SQL_SPECS.sql115.functions[0].acl, ['owner EXECUTE']);
  assert.ok(!RELEASE_SQL_SPECS.sql115.functions[0].revokes.includes('checksops EXECUTE'));
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-27) on the staging
  // read-live; the staging pin above stays pending (staging already in the intended state, no apply).
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-27 /);
  assert.equal(prod.expected_live_definition_sha256, '249237decc1f079bf04915a5f42862792efb13f00729a8d0bbbfdb8b5c456e35');
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

test('reviewed file and spec: one guard, one REVOKE and the optional-role block; the fingerprint is the function ACL (owner only); the rest of the function must not change', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const statements = TEXT.replace(/--[^\n]*/g, '').replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, [
    'DO $body$',
    `REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC, checksops`,
    'DO $body$',
  ]);
  assert.match(TEXT, /sql119_prerequisite_missing/);
  assert.match(TEXT, /sql119_not_function_owner/);
  assert.match(TEXT, /FOREACH grantee IN ARRAY ARRAY\['anon', 'authenticated', 'service_role'\] LOOP/);
  assert.match(TEXT, /EXECUTE format\('REVOKE ALL ON FUNCTION public\.sync_provider_stakeholder_account\(uuid\) FROM %I', grantee\)/);
  assert.doesNotMatch(TEXT.replace(/--[^\n]*/g, ''), /\bGRANT\b/i);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.acl_functions.map((fn) => fn.identity), [FN]);
  assert.deepEqual(spec.render, { grantors: true });
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.acl_functions, { [FN]: { exists: true, acl: ['owner EXECUTE grantor=owner'] } });
  assert.equal(releaseStateText(KEY, intended), `release sql119 v1\nfunction_acl ${FN}: acl=owner EXECUTE grantor=owner`);
  assert.equal(releaseStateText(KEY, {}), `release sql119 v1\nfunction_acl ${FN}: absent`);
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [FN]);
  for (const field of ['skip_relations', 'acl_relations', 'skip_columns', 'skip_constraints', 'skip_policies', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Post-conditions: a body or owner change of the function is refused even on the intended ACL.
  const fnState = (over = {}) => ({ exists: true, owner_is_login: true, language: 'plpgsql', volatility: 'v', parallel: 'u', security_definer: true, result: 'uuid', config: ['search_path=public'], prosrc_sha256: 'a'.repeat(64), acl: ['owner EXECUTE grantor=owner'], ...over });
  const pin = PINS[KEY];
  const st = (fn) => ({ live_definition_sha256: pin.intended_replacement_sha256, acl_functions: { [FN]: fn } });
  const before = st(fnState({ acl: ['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'] }));
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState()), pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState({ prosrc_sha256: 'b'.repeat(64) })), pin), ['acl_functions_otherwise_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(fnState({ owner_is_login: false })), pin), ['acl_functions_otherwise_unchanged']);
  // Pre-conditions: present, owned by the login, and only entries the file keeps or revokes (granted by the owner).
  const pre = (fn) => releaseSharedPreconditionFailures(KEY, { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], acl_functions: { [FN]: fn } }, TEXT);
  assert.deepEqual(pre(before.acl_functions[FN]), []);
  assert.deepEqual(pre(fnState({ acl: ['authenticated EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'] })), []);
  assert.deepEqual(pre({ exists: false }), ['acl_functions_present']);
  assert.deepEqual(pre(fnState({ owner_is_login: false })), ['acl_functions_owned_by_login']);
  assert.deepEqual(pre(fnState({ acl: ['authenticated EXECUTE grantor=checksops', 'owner EXECUTE grantor=owner'] })), ['acl_functions_acl_replaceable']);
  assert.deepEqual(pre(fnState({ acl: ['checksops EXECUTE with grant option grantor=owner', 'owner EXECUTE grantor=owner'] })), ['acl_functions_acl_replaceable']);
  // The supabase-era lines (anon, authenticated, service_role) are revocable too.
  assert.deepEqual(pre(fnState({ acl: ['PUBLIC EXECUTE grantor=owner', 'anon EXECUTE grantor=owner', 'authenticated EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner', 'service_role EXECUTE grantor=owner'] })), []);
  assert.deepEqual(pre(fnState({ acl: ['checksops_admin_ro EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'] })), ['acl_functions_acl_replaceable']);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [PROVIDER_STAKEHOLDER_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 119 through the executor: the file\'s own refusals, a foreign grantor refused, one apply on the intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql119-exec-', 58619, async ({ admin, connectAs }) => {
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
  // Production's ACL (inspect 2026-10-27, SSM 2db258df): PUBLIC, checksops and the owner.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(`REVOKE ALL ON FUNCTION ${FN} FROM anon, authenticated, service_role`);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${FN} TO checksops`);
  } finally {
    await owner.end();
  }

  // The file refuses a login that does not own the function (the superuser here) ...
  await admin.query('BEGIN');
  try {
    await assert.rejects(admin.query(TEXT), (e) => e.code === '42501' && /sql119_not_function_owner/.test(e.message));
  } finally {
    await admin.query('ROLLBACK');
  }
  // ... and a missing function.
  await admin.query('BEGIN');
  try {
    await admin.query(`DROP FUNCTION ${FN} CASCADE`);
    await assert.rejects(admin.query(TEXT), (e) => e.code === '55000' && /sql119_prerequisite_missing/.test(e.message));
  } finally {
    await admin.query('ROLLBACK');
  }
  // An entry granted by another role is not the owner's to revoke: the engine refuses.
  await admin.query('BEGIN');
  try {
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM checksops`);
    await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO checksops WITH GRANT OPTION`);
    await admin.query('SET LOCAL ROLE checksops');
    await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO authenticated`);
    await admin.query('RESET ROLE');
    const state = (await readReleaseSqlState(admin, KEY)).details;
    assert.ok(releaseSharedPreconditionFailures(KEY, state, TEXT).includes('acl_functions_acl_replaceable'));
  } finally {
    await admin.query('ROLLBACK');
  }

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.equal(r.already_applied, false);
  assert.deepEqual(r.release_sql_inspect.acl_functions[0].acl, ['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner']);
  // A pending pin cannot apply.
  const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM PUBLIC`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.release_sql_inspect.acl_functions, [{ name: 'sync_provider_stakeholder_account(uuid)', state: 'intended', acl: ['owner EXECUTE grantor=owner'] }]);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
