/**
 * SQL 171 (aws/workflows/sql/171_device_push_tokens.sql) on PostgreSQL 16, through its production tool, the owner the
 * non-superuser checksops_admin login (production's admin login, which applies the file). Owner 2026-11-19: app
 * notifications when signatures are received, funds are disbursed or received, the wallet changes, or a message arrives;
 * the app side (PR 2016) sends the phone's push token to the API, and this file is where the API keeps it. The functions
 * are called as checksops, the API login, with request.app_user_id set as the API sets it (auth.uid() is main's own text,
 * aws/identity/sql/02_auth_uid_guc.sql); the applying login has default privileges that grant new tables to checksops and
 * authenticated.
 *
 *   - one apply through the production tool reaches the intended fingerprint from the absent pre-state; the new table has
 *     no grant left, no policy, no trigger;
 *   - as the API role for a signed-in user: register inserts the token; registering it again refreshes last_seen_at and
 *     keeps created_at; a token registered by user A moves to user B when B registers it; a user's 21st token drops the
 *     least recently seen; an invalid platform or token is refused (22023); no signed-in user is refused (42501);
 *     unregister removes only the caller's own token;
 *   - the API role cannot SELECT or INSERT the table directly, and authenticated cannot call the functions;
 *   - the file run again is a no-op (the rows kept) and the tool refuses a re-apply;
 *   - the file refuses (55000 sql171_unexpected_table), and changes nothing, when a device_push_tokens table with other
 *     columns exists, and (55000 sql171_prerequisite_missing) without auth.uid().
 *
 * Run: node --test aws/tests/sql171-device-push-tokens-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers run the
 * server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql171';
const TABLE = 'public.device_push_tokens';
const FNS = Object.freeze(['public.aws_push_register_device(text, text)', 'public.aws_push_unregister_device(text)']);
/** The expected pre-state: the table and both functions absent. */
const ABSENT = releaseStateHash(KEY, {});
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const USER_A = 'a1710000-0000-4000-8000-00000000000a';
const USER_B = 'a1710000-0000-4000-8000-00000000000b';
const USER_C = 'a1710000-0000-4000-8000-00000000000c';
const TOKEN_1 = 'fcm:token-one_AbC123';
const TOKEN_2 = 'apns-0123456789abcdef0123456789abcdef';

/** Default privileges that grant new tables to the API roles: the file must leave none on its table. */
const DEFAULT_PRIVILEGES = 'ALTER DEFAULT PRIVILEGES FOR ROLE checksops_admin IN SCHEMA public GRANT ALL ON TABLES TO checksops, authenticated;';

const authorized = (pin, live) => Object.freeze({
  ...pin,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${pin.migration}-pg-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${pin.migration}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-19T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql171-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

async function withPg(t, prefix, port, extra, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The file as the owner; returns the error or null. */
async function runFile(connectAs) {
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
    return null;
  } catch (error) {
    return error;
  } finally {
    await owner.end();
  }
}

/** Every row, timestamps as microseconds since the epoch (exact), ordered by token. */
const rows = async (admin) => (await admin.query(`SELECT id::text, user_id::text, platform, token,
  (EXTRACT(EPOCH FROM created_at) * 1000000)::bigint::text AS created_us, (EXTRACT(EPOCH FROM last_seen_at) * 1000000)::bigint::text AS seen_us
  FROM ${TABLE} ORDER BY token`)).rows;
const tokensOf = async (admin, user) => (await admin.query(`SELECT token FROM ${TABLE} WHERE user_id = $1::uuid ORDER BY token`, [user])).rows.map((r) => r.token);
const catalog = async (admin) => (await admin.query(`SELECT
  (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE proname IN ('aws_push_register_device', 'aws_push_unregister_device')) AS functions,
  (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = pg_catalog.to_regclass('${TABLE}') AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT count(*)::int FROM pg_catalog.pg_index i WHERE i.indrelid = pg_catalog.to_regclass('${TABLE}')) AS indexes,
  (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass('${TABLE}')) AS rls`)).rows[0];

test('PostgreSQL 16: SQL 171 through its production tool: the table and functions as intended; the API role registers, refreshes, moves, caps and unregisters tokens only through the functions; re-run a no-op', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql171-prod-', 61271, [DEFAULT_PRIVILEGES], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.deepEqual(s.release_sql_inspect.prerequisites_missing, []);
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, ABSENT);
  const pin = authorized(PIN, s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ABSENT);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  // The table: owned by the login, RLS on, no policy, no trigger, no grant left from the default privileges.
  const table = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
    (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies,
    (SELECT count(*)::int FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal) AS triggers,
    ARRAY(SELECT a.grantee::regrole::text FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee <> c.relowner ORDER BY 1)::text[] AS grants
    FROM pg_catalog.pg_class c WHERE c.oid = '${TABLE}'::regclass`)).rows[0];
  assert.deepEqual(table, { owner: 'checksops_admin', rls: true, forced: false, policies: 0, triggers: 0, grants: [] });
  for (const fn of FNS) {
    const f = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
      has_function_privilege('checksops', p.oid, 'EXECUTE') AS api, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [fn])).rows[0];
    assert.deepEqual(f, { owner: 'checksops_admin', definer: true, api: true, authenticated: false }, fn);
  }

  // The API login, one transaction per call (as the API runs them), for an application user (or none).
  const api = await connectAs('checksops');
  const as = async (user, sql, params = []) => {
    await api.query('BEGIN');
    try {
      if (user !== undefined) await api.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
      const res = await api.query(sql, params);
      await api.query('COMMIT');
      return { rows: res.rows, error: null };
    } catch (error) {
      await api.query('ROLLBACK');
      return { rows: null, error };
    }
  };
  const register = async (user, platform, token) => {
    const r = await as(user, 'SELECT public.aws_push_register_device($1, $2) AS id', [platform, token]);
    return r.error ? { error: r.error } : { id: r.rows[0].id };
  };
  const unregister = async (user, token) => {
    const r = await as(user, 'SELECT public.aws_push_unregister_device($1) AS removed', [token]);
    return r.error ? { error: r.error } : { removed: r.rows[0].removed };
  };
  const refused = (r, code, message) => {
    assert.ok(r.error, `expected ${code} ${message}`);
    assert.equal(r.error.code, code, r.error.message);
    assert.equal(r.error.message, message);
  };
  try {
    // Register: one row for the caller.
    const first = await register(USER_A, 'ios', TOKEN_1);
    assert.equal(first.error, undefined, first.error?.message);
    assert.match(first.id, /^[0-9a-f-]{36}$/);
    const [r1] = await rows(admin);
    assert.deepEqual([r1.id, r1.user_id, r1.platform, r1.token], [first.id, USER_A, 'ios', TOKEN_1]);
    assert.equal(r1.created_us, r1.seen_us);

    // The same user again: the same row, last_seen_at refreshed, created_at kept; the platform follows the call.
    const again = await register(USER_A, 'android', TOKEN_1);
    assert.equal(again.id, first.id);
    const [r2] = await rows(admin);
    assert.equal((await rows(admin)).length, 1);
    assert.equal(r2.platform, 'android');
    assert.equal(r2.created_us, r1.created_us);
    assert.ok(BigInt(r2.seen_us) > BigInt(r1.seen_us), 'last_seen_at refreshed');

    // Another user signs in on the same phone: the token moves to them (the same row), created_at reset.
    const moved = await register(USER_B, 'ios', TOKEN_1);
    assert.equal(moved.id, first.id);
    const [r3] = await rows(admin);
    assert.equal((await rows(admin)).length, 1);
    assert.deepEqual([r3.user_id, r3.platform], [USER_B, 'ios']);
    assert.ok(BigInt(r3.created_us) > BigInt(r2.created_us), 'created_at reset on the move');
    assert.ok(BigInt(r3.seen_us) > BigInt(r2.seen_us));
    assert.deepEqual(await tokensOf(admin, USER_A), []);
    assert.deepEqual(await tokensOf(admin, USER_B), [TOKEN_1]);

    // At most 20 per user: the 21st drops the least recently seen (not the first created: token 01 is seen again).
    const cap = (i) => `cap-token-${String(i).padStart(2, '0')}`;
    for (let i = 1; i <= 20; i += 1) assert.equal((await register(USER_C, 'android', cap(i))).error, undefined, cap(i));
    assert.equal((await tokensOf(admin, USER_C)).length, 20);
    assert.equal((await register(USER_C, 'android', cap(1))).error, undefined);
    assert.equal((await register(USER_C, 'android', cap(21))).error, undefined);
    const capped = await tokensOf(admin, USER_C);
    assert.equal(capped.length, 20);
    assert.ok(!capped.includes(cap(2)), 'the least recently seen token is dropped');
    assert.ok(capped.includes(cap(1)) && capped.includes(cap(21)));
    // Another user's tokens are not counted or touched.
    assert.deepEqual(await tokensOf(admin, USER_B), [TOKEN_1]);

    // Invalid input: 22023, nothing written.
    const before = await rows(admin);
    refused(await register(USER_A, 'windows', TOKEN_2), '22023', 'invalid_platform');
    refused(await register(USER_A, 'IOS', TOKEN_2), '22023', 'invalid_platform');
    refused(await register(USER_A, null, TOKEN_2), '22023', 'invalid_platform');
    refused(await register(USER_A, 'ios', ''), '22023', 'invalid_token');
    refused(await register(USER_A, 'ios', null), '22023', 'invalid_token');
    refused(await register(USER_A, 'ios', 'has a space'), '22023', 'invalid_token');
    refused(await register(USER_A, 'ios', 'tab\there'), '22023', 'invalid_token');
    refused(await register(USER_A, 'ios', 'x'.repeat(4097)), '22023', 'invalid_token');
    assert.equal((await register(USER_A, 'ios', 'y'.repeat(4096))).error, undefined, 'a 4096-character token is accepted');
    assert.equal((await unregister(USER_A, 'y'.repeat(4096))).removed, true);
    // No signed-in user: 42501, for both functions (no setting, or an empty one).
    refused(await register(undefined, 'ios', TOKEN_2), '42501', 'not_authorized');
    refused(await register('', 'ios', TOKEN_2), '42501', 'not_authorized');
    refused(await unregister(undefined, TOKEN_1), '42501', 'not_authorized');
    refused(await unregister('', TOKEN_1), '42501', 'not_authorized');
    assert.deepEqual(await rows(admin), before);

    // Unregister removes only the caller's own token.
    assert.equal((await register(USER_A, 'ios', TOKEN_2)).error, undefined);
    assert.deepEqual(await unregister(USER_B, TOKEN_2), { removed: false });
    assert.deepEqual(await tokensOf(admin, USER_A), [TOKEN_2]);
    assert.deepEqual(await unregister(USER_A, TOKEN_1), { removed: false }, 'TOKEN_1 is user B\'s now');
    assert.deepEqual(await tokensOf(admin, USER_B), [TOKEN_1]);
    assert.deepEqual(await unregister(USER_A, TOKEN_2), { removed: true });
    assert.deepEqual(await tokensOf(admin, USER_A), []);
    assert.deepEqual(await unregister(USER_A, TOKEN_2), { removed: false });
    assert.deepEqual(await unregister(USER_A, null), { removed: false });

    // The API role never reads or writes the table itself.
    for (const sql of [`SELECT * FROM ${TABLE}`, `INSERT INTO ${TABLE} (user_id, platform, token) VALUES ('${USER_A}', 'ios', 'direct')`,
      `UPDATE ${TABLE} SET user_id = '${USER_A}'`, `DELETE FROM ${TABLE}`]) {
      const r = await as(USER_A, sql);
      assert.equal(r.error?.code, '42501', sql);
    }
  } finally {
    await api.end();
  }
  // authenticated cannot call the functions either.
  const authed = await admin.query(`SELECT has_table_privilege('authenticated', '${TABLE}', 'SELECT') AS t,
    has_function_privilege('authenticated', '${FNS[0]}', 'EXECUTE') AS r, has_function_privilege('authenticated', '${FNS[1]}', 'EXECUTE') AS u`);
  assert.deepEqual(authed.rows[0], { t: false, r: false, u: false });

  // The file again is a no-op (the rows kept); the tool sees it in place and refuses a re-apply.
  const kept = await rows(admin);
  assert.equal(await runFile(connectAs), null);
  assert.deepEqual(await rows(admin), kept);
  const inspected = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(inspected.already_applied, true);
  assert.deepEqual(inspected.precondition_failures, []);
  assert.equal(inspected.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: the file refuses, and changes nothing, when a device_push_tokens table with other columns exists or auth.uid() is missing', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql171-refuse-', 61371, [
  `CREATE TABLE ${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, token text NOT NULL);
   INSERT INTO ${TABLE} (user_id, token) VALUES ('${USER_A}', 'kept');`,
], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await catalog(admin);
  assert.deepEqual(before, { functions: 0, columns: ['id', 'user_id', 'token'], indexes: 1, rls: false });
  // The engine refuses the pre-state too: the table is not the intended one.
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.ok(s.precondition_failures.includes('created_tables_absent_or_intended'), JSON.stringify(s.precondition_failures));
  assert.equal(s.already_applied, false);

  const error = await runFile(connectAs);
  assert.equal(error?.code, '55000', error?.message);
  assert.equal(error.message, 'sql171_unexpected_table: public.device_push_tokens has columns {id,token,user_id}');
  assert.deepEqual(await catalog(admin), before);
  assert.deepEqual((await admin.query(`SELECT token FROM ${TABLE}`)).rows, [{ token: 'kept' }]);

  // Without auth.uid() (and with the other table gone) it refuses on the prerequisite, before creating anything.
  await admin.query(`DROP TABLE ${TABLE}`);
  await admin.query('ALTER FUNCTION auth.uid() RENAME TO uid_sql171_test');
  try {
    const missing = await runFile(connectAs);
    assert.equal(missing?.code, '55000', missing?.message);
    assert.equal(missing.message, 'sql171_prerequisite_missing: auth.uid()');
    assert.deepEqual(await catalog(admin), { functions: 0, columns: null, indexes: 0, rls: null });
  } finally {
    await admin.query('ALTER FUNCTION auth.uid_sql171_test() RENAME TO uid');
  }
  // With everything in place the file applies.
  assert.equal(await runFile(connectAs), null);
  assert.deepEqual(await catalog(admin), { functions: 2, columns: ['id', 'user_id', 'platform', 'token', 'created_at', 'last_seen_at'], indexes: 3, rls: true });
}));
