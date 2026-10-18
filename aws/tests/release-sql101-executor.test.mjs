/**
 * SQL 101 (aws/workflows/sql/101_invite_identity_insert_order.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-100
 * (scripts/deployment-guard/lib/release-sql-state.mjs). release-sql90-97-executor.test.mjs runs
 * what every release key shares (SQL 101 included: pins allowlisted, refusals before
 * connecting, the reviewed-file and forbidden-statement checks, the read-only fake-client
 * inspect); this file covers what is new:
 *
 *   - the pin: staging wave 5 (production pending), code-derived, selectable, packed, in step with the production pin; the
 *     file's bytes are authored by the pinned commit; predecessor and supersedes SQL 90;
 *   - the file replaces only SQL 90's aws_invite_create_user_identity, with the same
 *     attributes and ACL (only the body, so only prosrc_sha256, differs); SQL 90's own pin and
 *     bytes are unchanged;
 *   - on PostgreSQL 16 (SQL 29 / 30 / 90 applied first, a non-superuser checksops_admin owning
 *     everything): refused before SQL 90 and with an extra EXECUTE grant; one apply through the
 *     executor on the intended fingerprint; afterwards SQL 90 counts as applied for SQL 93,
 *     94, 99 and 100 (supersedes) while SQL 90's own fingerprint has moved on; with
 *     profiles_id_identity_fkey a brand-new invite works.
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
  AUTHORIZED_SQL101_INVITE_IDENTITY_INSERT_ORDER,
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
  releaseSupersededIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState } from './helpers/staging-sql-wave1.mjs';
import { MEMBER_A, TENANT_A, pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-18T12:00:00.000Z';
const KEY = 'sql101';
const IDENTITY = 'public.aws_invite_create_user_identity(uuid, text, text, text)';
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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql101-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 101 staging wave 5, code-derived, selectable, packed, in step with the production pin; predecessor and supersedes SQL 90', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL101_INVITE_IDENTITY_INSERT_ORDER, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/101_invite_identity_insert_order.sql');
  assert.equal(pin.migration_id, '101_invite_identity_insert_order');
  assert.equal(spec.choice, 'sql101-invite-identity-insert-order');
  assert.equal(sha(TEXT[KEY]), pin.source_sha256);
  assertStagingPinState(assert, KEY, pin);
  assert.equal(releaseIntendedHash(KEY, TEXT[KEY]), pin.intended_replacement_sha256);
  // SQL 90 after SQL 101: every SQL 90 object, with the invite function as SQL 101 renders it.
  assert.deepEqual(Object.keys(pin.superseded_intended_sha256), ['sql90']);
  assert.equal(releaseSupersededIntendedHash('sql90', TEXT.sql90, KEY, TEXT[KEY]), pin.superseded_intended_sha256.sql90);
  assert.notEqual(pin.superseded_intended_sha256.sql90, releaseIntendedHash('sql90', TEXT.sql90));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql101-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [IDENTITY]);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [IDENTITY]);
  assert.deepEqual(spec.predecessors, ['sql90']);
  assert.deepEqual(spec.supersedes, ['sql90']);
  // Only SQL 101 supersedes SQL 90.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql90')), ['sql101']);
  const prod = productionPin(KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, ['sql90']);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  // The pinned commit authored these bytes (skipped in a checkout without that history).
  let bytes = null;
  try {
    bytes = execFileSync('git', ['-C', ROOT, 'show', `${pin.commit}:${pin.filename}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    bytes = null;
  }
  if (bytes !== null) assert.equal(sha(bytes), pin.source_sha256, 'the pinned commit carries the pinned bytes');
});

test('reviewed file: only SQL 90\'s invite function, same attributes and ACL, a new body; identity row before profile', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT[KEY]), TEXT[KEY]);
  const defs = releaseFunctionDefinitions(TEXT[KEY]);
  assert.deepEqual(Object.keys(defs), ['aws_invite_create_user_identity']);
  const ours = releaseIntendedState(KEY, TEXT[KEY]).functions[IDENTITY];
  const sql90 = releaseIntendedState('sql90', TEXT.sql90).functions[IDENTITY];
  const { prosrc_sha256: newBody, ...newAttrs } = ours;
  const { prosrc_sha256: oldBody, ...oldAttrs } = sql90;
  assert.deepEqual(newAttrs, oldAttrs);
  assert.notEqual(newBody, oldBody);
  assert.deepEqual(ours.config, ['row_security=off', 'search_path=public']);
  assert.equal(ours.security_definer, true);
  assert.equal(ours.volatility, 'v');
  assert.equal(ours.result, 'uuid');
  const body = defs.aws_invite_create_user_identity.prosrc;
  assert.ok(body.indexOf('INSERT INTO public.identity_accounts') < body.indexOf('INSERT INTO public.profiles'));
  const old = releaseFunctionDefinitions(TEXT.sql90).aws_invite_create_user_identity.prosrc;
  assert.ok(old.indexOf('INSERT INTO public.profiles') < old.indexOf('INSERT INTO public.identity_accounts'), 'SQL 90 inserted the profile first');
  // SQL 90's comment, REVOKE and GRANT lines, byte for byte.
  for (const line of [
    "COMMENT ON FUNCTION public.aws_invite_create_user_identity(uuid, text, text, text) IS\n  'Invite: creates or finds the invitee profile and Cognito link for a member of _tenant_id or the platform owner''s locked first invite. Refuses the platform owner; never re-points a cognito_sub (SQL 90).';",
    'REVOKE ALL ON FUNCTION public.aws_invite_create_user_identity(uuid, text, text, text) FROM PUBLIC;',
    'GRANT EXECUTE ON FUNCTION public.aws_invite_create_user_identity(uuid, text, text, text) TO checksops, authenticated;',
  ]) {
    assert.ok(TEXT.sql90.includes(line), line);
    assert.ok(TEXT[KEY].includes(line), line);
  }
  assert.match(TEXT[KEY], /sql101_prerequisite_missing/);
  // Nothing outside the function: no policy, table, view or drop.
  assert.deepEqual(releaseUnrelatedScope(KEY).skip_functions, [IDENTITY]);
  for (const field of ['policies', 'tables', 'views', 'added_columns', 'column_acl', 'table_privileges', 'triggers', 'dropped_functions', 'altered_relations']) {
    assert.equal(RELEASE_SQL_SPECS[KEY][field], undefined, field);
  }
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

test('PostgreSQL 16: SQL 101 through the executor: predecessor, ACL refusal, one apply on the intended fingerprint, SQL 90 superseded', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql101-exec-', 63300, async ({ admin, connectAs, applyPredecessors }) => {
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
  const asOwner = async (sql) => {
    const c = await connectAs('checksops_admin');
    try { await c.query(sql); } finally { await c.end(); }
  };

  // Before SQL 90: refused on the predecessor and on its own prerequisite (the function it replaces).
  await applyPredecessors();
  const early = await inspect(KEY);
  assert.deepEqual(early.release_sql_inspect.predecessors, { sql90: false });
  assert.ok(early.precondition_failures.includes('predecessors_applied'));
  assert.ok(early.precondition_failures.includes('prerequisites_present'));
  const refusedEarly = await apply(KEY, early.live_definition_sha256);
  assert.equal(refusedEarly.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(refusedEarly.details.failed.includes('predecessors_applied'));

  await asOwner(TEXT.sql90);
  assert.equal((await inspect('sql90')).already_applied, true);
  let r = await inspect(KEY);
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, { sql90: true });
  assert.equal(r.already_applied, false);
  assert.deepEqual(r.release_sql_inspect.functions.map((row) => row.state), ['different']);

  // An EXECUTE grant the file neither keeps nor revokes would survive CREATE OR REPLACE: refused.
  await admin.query('BEGIN');
  try {
    await admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO anon`);
    const state = (await readReleaseSqlState(admin, KEY)).details;
    assert.ok(releaseSharedPreconditionFailures(KEY, state, TEXT[KEY]).includes('function_acl_replaceable'));
  } finally {
    await admin.query('ROLLBACK');
  }
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO PUBLIC`);
  assert.equal((await apply(KEY, r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE EXECUTE ON FUNCTION ${IDENTITY} FROM PUBLIC`);

  const applied = await apply(KEY, r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect(KEY);
  assert.equal(after.already_applied, true);
  assert.ok(after.release_sql_inspect.functions.every((row) => row.state === 'intended'), JSON.stringify(after.release_sql_inspect.functions));
  assert.equal((await apply(KEY, r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);

  // SQL 90's own fingerprint has moved on (its invite function is SQL 101's now), but the
  // migrations that need SQL 90 still see it applied, through SQL 101 (supersedes).
  assert.equal((await inspect('sql90')).already_applied, false);
  for (const key of ['sql93', 'sql94', 'sql99', 'sql100']) {
    const dependent = await inspect(key);
    assert.equal(dependent.release_sql_inspect.predecessors.sql90, true, key);
    assert.ok(!dependent.precondition_failures.includes('predecessors_applied'), `${key}: ${JSON.stringify(dependent.precondition_failures)}`);
  }
  // ...but only while every other SQL 90 object still matches: a drifted SQL 90 grant is no
  // longer SQL 90 applied, even with SQL 101's function in place.
  await admin.query('REVOKE EXECUTE ON FUNCTION public.aws_first_invite_allowed(uuid) FROM authenticated');
  try {
    assert.equal((await inspect(KEY)).already_applied, true);
    assert.equal((await inspect('sql93')).release_sql_inspect.predecessors.sql90, false);
  } finally {
    await admin.query('GRANT EXECUTE ON FUNCTION public.aws_first_invite_allowed(uuid) TO checksops, authenticated');
  }
  assert.equal((await inspect('sql93')).release_sql_inspect.predecessors.sql90, true);

  // With the live constraint, a brand-new invite through the applied function has both rows.
  await admin.query('ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_identity_fkey FOREIGN KEY (id) REFERENCES public.identity_accounts(application_user_id) ON DELETE CASCADE');
  const member = await connectAs('checksops');
  try {
    await member.query('BEGIN');
    await member.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
    const id = (await member.query('SELECT public.aws_invite_create_user_identity($1::uuid, $2, $3, $4)::text AS id',
      [TENANT_A, 'new-user@example.invalid', 'New User', 'sub-new-user'])).rows[0].id;
    await member.query('ROLLBACK');
    assert.match(id, /^[0-9a-f-]{36}$/);
  } finally {
    await member.query('ROLLBACK').catch(() => {});
    await member.end();
  }
}));
