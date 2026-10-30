/**
 * SQL 132 (aws/workflows/sql/132_financial_totp_code_check_lockout.sql) on PostgreSQL 16, from the
 * pre-state both databases have: the proposed financial TOTP file
 * (aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql, the live definition)
 * owned by a non-superuser checksops_admin, SQL 130 applied by that owner (the predecessor),
 * auth.uid() from aws/identity/sql/02_auth_uid_guc.sql, and the function called as checksops the way
 * the API calls it ($1::uuid; the existence check through pg_catalog.to_regprocedure).
 *
 *   - before SQL 132: the function is absent (the API's existence check reads NULL);
 *   - the file refuses without the enrollment table (55000 sql132_prerequisite_missing) and when the
 *     applying login could not write the table as a DEFINER owner (FORCE ROW LEVEL SECURITY: 55000
 *     sql132_definer_cannot_write), and creates nothing then;
 *   - SQL 132 applied as the owner: one check counted per call; the tenth consecutive check locks
 *     the row for 15 minutes; while locked, allowed false with the seconds left and no change;
 *     another user's row is independent; a user without an enrollment gets no row; the caller check
 *     (NULL, no identity, another user's id) raises; two concurrent checks at nine serialize on the
 *     row lock and the second sees the lock; after the lock expires a check is counted again and
 *     locks the row again at once; a correct code (financial_totp_mark_verified, unchanged) clears
 *     the count and the lock;
 *   - right people can: checksops (the API) and the owner execute it; wrong people can't: a fresh
 *     login holding nothing but PUBLIC gets permission denied, before any argument is looked at;
 *   - nothing else changes: every other function in schema public and auth (the four proposed-file
 *     functions and SQL 130's rate limit included) keeps its ACL, owner and body; every table ACL,
 *     RLS flag and policy is unchanged; SQL 130's rate limit still answers;
 *   - running the file again changes nothing.
 * The executor's fingerprints and refusals are release-sql132-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL132 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/132_financial_totp_code_check_lockout.sql'), 'utf8');
const SQL130 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql'), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql'), 'utf8');
const AUTH_UID = fs.readFileSync(path.join(ROOT, 'aws/identity/sql/02_auth_uid_guc.sql'), 'utf8');
const IDENTITY = 'public.financial_totp_count_code_check(uuid)';
// The API's calls (aws/functions/api/auth-financial-totp.mjs, providers/production/checkalt-register.mjs).
const PRESENT = 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present';
const CALL = 'SELECT allowed, failed_attempts, retry_after_seconds FROM public.financial_totp_count_code_check($1::uuid)';
const MARK = 'SELECT public.financial_totp_mark_verified($1::uuid, $2::bigint) AS claimed';
const RATE = 'SELECT allowed, count, retry_after_seconds FROM public.consume_financial_totp_rate_limit($1::uuid, $2, $3::int, $4::int)';
const THRESHOLD = 10;
const LOCK_SECONDS = 15 * 60;
const USER_A = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c';
const USER_B = '1c9a7a2f-3a1d-4d8f-8b62-7b4a2e3f5c6d';
const USER_C = '2d0b8b3a-4b2e-4e9a-9c73-8c5b3f4a6d7e';

const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE stranger LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
CREATE TABLE public.financial_stepup_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid NOT NULL, tenant_id uuid,
  action_key text NOT NULL, factor_type text NOT NULL DEFAULT 'totp', succeeded boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.financial_stepup_log OWNER TO checksops_admin;
`;
// Every function in schema public and auth with its owner, ACL, SECURITY DEFINER, config and body;
// every relation's ACL and RLS flags in schema public; every policy.
const CATALOG = `SELECT
  (SELECT pg_catalog.json_agg(json_build_object('f', p.oid::regprocedure::text, 'owner', pg_catalog.pg_get_userbyid(p.proowner),
     'acl', p.proacl::text, 'secdef', p.prosecdef, 'config', p.proconfig, 'vol', p.provolatile, 'body', pg_catalog.md5(p.prosrc)) ORDER BY p.oid::regprocedure::text)
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'auth')) AS functions,
  (SELECT pg_catalog.json_agg(json_build_object('r', c.relname, 'acl', c.relacl::text, 'rls', c.relrowsecurity, 'force', c.relforcerowsecurity) ORDER BY c.relname)
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations,
  (SELECT pg_catalog.json_agg(json_build_object('t', polrelid::regclass::text, 'p', polname, 'cmd', polcmd, 'roles', polroles::text,
     'qual', pg_catalog.pg_get_expr(polqual, polrelid), 'check', pg_catalog.pg_get_expr(polwithcheck, polrelid)) ORDER BY polrelid::regclass::text, polname)
   FROM pg_catalog.pg_policy) AS policies`;
const COUNT_FN = `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile, (SELECT l.lanname FROM pg_catalog.pg_language l WHERE l.oid = p.prolang) AS lang,
    pg_catalog.pg_get_function_result(p.oid) AS result, pg_catalog.md5(p.prosrc) AS body,
    (SELECT pg_catalog.array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type
       ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
     FROM pg_catalog.aclexplode(p.proacl) a) AS acl
  FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('${IDENTITY}')`;
const fileBody = () => {
  const start = SQL132.indexOf('AS $$', SQL132.indexOf('financial_totp_count_code_check(')) + 5;
  return SQL132.slice(start, SQL132.indexOf('$$', start));
};
const newFunction = 'financial_totp_count_code_check(uuid)';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('PostgreSQL 16: SQL 132 on the proposed schema with SQL 130 applied: refuses without its prerequisites; counts one check per call, locks at ten for 15 minutes, refuses while locked, per user and atomic; checksops and the owner can execute, a PUBLIC-only login cannot; mark_verified clears it; nothing else changes; a second run is a no-op', {
  timeout: 240000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-sql132-totp-lockout-', 62250);
  const clients = [];
  const open = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    clients.push(c);
    return c;
  };
  try {
    const su = await open('ubuntu');
    await su.query(SETUP);
    await su.query(AUTH_UID);
    await su.query('GRANT USAGE ON SCHEMA auth TO checksops_admin, checksops, stranger');
    await su.query(PROPOSED);
    const owner = await open('checksops_admin');
    await owner.query(SQL130);
    const api = await open('checksops');
    const api2 = await open('checksops');
    const stranger = await open('stranger');
    const as = async (client, user) => client.query("SELECT pg_catalog.set_config('request.app_user_id', $1, false)", [user]);
    const present = async (client) => (await client.query(PRESENT, [IDENTITY])).rows[0].present;
    const countAs = async (client, user) => (await client.query(CALL, [user])).rows;
    const count = async (user) => (await countAs(api, user))[0];
    const rowOf = async (user) => (await su.query('SELECT failed_attempts, locked_until FROM public.financial_totp_enrollments WHERE application_user_id = $1', [user])).rows[0];
    const secondsLeft = async (user) => Number((await su.query('SELECT EXTRACT(EPOCH FROM (locked_until - now())) AS s FROM public.financial_totp_enrollments WHERE application_user_id = $1', [user])).rows[0].s);
    const raises = async (fn, code, message) => {
      await assert.rejects(fn(), (error) => {
        assert.equal(error.code, code);
        assert.match(error.message, message);
        return true;
      });
    };
    for (const user of [USER_A, USER_B]) {
      await su.query(`INSERT INTO public.financial_totp_enrollments (application_user_id, ciphertext, nonce, key_id)
        VALUES ($1, '\\x01'::bytea, '\\x02'::bytea, 'financial-totp-v1')`, [user]);
    }

    // Before SQL 132: the function is absent; the API's existence check reads NULL (as checksops too).
    assert.equal(await present(su), false);
    assert.equal(await present(api), false);
    const before = (await su.query(CATALOG)).rows[0];
    assert.ok(before.functions.some((fn) => fn.f === 'consume_financial_totp_rate_limit(uuid,text,integer,integer)'));
    assert.ok(!before.functions.some((fn) => fn.f === newFunction));

    // Refused without the table, and when the owner could not write it as a DEFINER: nothing created.
    await owner.query('ALTER TABLE public.financial_totp_enrollments RENAME TO financial_totp_enrollments_moved');
    await raises(() => owner.query(SQL132), '55000', /^sql132_prerequisite_missing: .*public\.financial_totp_enrollments/);
    await owner.query('ALTER TABLE public.financial_totp_enrollments_moved RENAME TO financial_totp_enrollments');
    assert.equal(await present(su), false);
    await owner.query('ALTER TABLE public.financial_totp_enrollments FORCE ROW LEVEL SECURITY');
    await raises(() => owner.query(SQL132), '55000', /^sql132_definer_cannot_write: /);
    await owner.query('ALTER TABLE public.financial_totp_enrollments NO FORCE ROW LEVEL SECURITY');
    assert.equal(await present(su), false);
    assert.deepEqual((await su.query(CATALOG)).rows[0], before, 'the refusals changed nothing');

    // SQL 132, run by the owner as the executor runs it.
    await owner.query(SQL132);
    assert.equal(await present(api), true);
    const after = (await su.query(CATALOG)).rows[0];
    // One function added; every other function, every relation and every policy unchanged.
    assert.equal(after.functions.length, before.functions.length + 1);
    assert.deepEqual(after.functions.filter((fn) => fn.f !== newFunction), before.functions);
    assert.deepEqual(after.relations, before.relations);
    assert.deepEqual(after.policies, before.policies);
    const fnAfter = (await su.query(COUNT_FN)).rows[0];
    assert.deepEqual(fnAfter, {
      owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], provolatile: 'v', lang: 'plpgsql',
      result: 'TABLE(allowed boolean, failed_attempts integer, retry_after_seconds integer)',
      body: (await su.query('SELECT pg_catalog.md5($1) AS h', [fileBody()])).rows[0].h,
      acl: ['checksops EXECUTE', 'checksops_admin EXECUTE'],
    });

    // Wrong people can't: a login with only PUBLIC is denied, before any argument is looked at.
    await as(stranger, USER_A);
    await raises(() => countAs(stranger, USER_A), '42501', /^permission denied for function financial_totp_count_code_check$/);
    assert.equal((await su.query("SELECT pg_catalog.has_function_privilege('stranger', $1, 'EXECUTE') AS ok", [IDENTITY])).rows[0].ok, false);
    assert.equal((await su.query("SELECT pg_catalog.has_function_privilege('authenticated', $1, 'EXECUTE') AS ok", [IDENTITY])).rows[0].ok, false);
    assert.equal((await su.query("SELECT pg_catalog.has_function_privilege('checksops', $1, 'EXECUTE') AS ok", [IDENTITY])).rows[0].ok, true);

    // The caller check: no identity, another user's identity, NULL.
    await raises(() => countAs(api, USER_A), '42501', /^enrollment_caller_mismatch$/);
    await as(api, USER_B);
    await raises(() => countAs(api, USER_A), '42501', /^enrollment_caller_mismatch$/);
    await raises(() => countAs(api, null), '22023', /^invalid_enrollment$/);
    assert.deepEqual(await rowOf(USER_A), { failed_attempts: 0, locked_until: null }, 'nothing counted by a refused call');

    // Right people can: checksops (the API). Nine checks count; the tenth locks the row for 15 minutes.
    await as(api, USER_A);
    for (let n = 1; n < THRESHOLD; n += 1) {
      assert.deepEqual(await count(USER_A), { allowed: true, failed_attempts: n, retry_after_seconds: 0 }, `check ${n}`);
      assert.deepEqual(await rowOf(USER_A), { failed_attempts: n, locked_until: null }, `check ${n}`);
    }
    assert.deepEqual(await count(USER_A), { allowed: true, failed_attempts: THRESHOLD, retry_after_seconds: 0 }, 'the tenth check is still answered (its code is compared) and locks the row');
    const lockedRow = await rowOf(USER_A);
    assert.equal(lockedRow.failed_attempts, THRESHOLD);
    assert.ok(lockedRow.locked_until, 'locked_until set');
    const left = await secondsLeft(USER_A);
    assert.ok(left > LOCK_SECONDS - 60 && left <= LOCK_SECONDS, String(left));
    // While locked: refused with the seconds left, nothing changes, however many times.
    for (let i = 0; i < 3; i += 1) {
      const locked = await count(USER_A);
      assert.equal(locked.allowed, false);
      assert.equal(locked.failed_attempts, THRESHOLD);
      assert.ok(locked.retry_after_seconds >= 1 && locked.retry_after_seconds <= LOCK_SECONDS, String(locked.retry_after_seconds));
    }
    assert.deepEqual(await rowOf(USER_A), lockedRow, 'a locked check is not counted and does not extend the lock');
    // Another user's row is independent; a user without an enrollment gets no row.
    await as(api, USER_B);
    assert.deepEqual(await count(USER_B), { allowed: true, failed_attempts: 1, retry_after_seconds: 0 });
    await as(api, USER_C);
    assert.deepEqual(await countAs(api, USER_C), []);
    // The owner can execute it too (USER_B's row, as that user).
    await as(owner, USER_B);
    assert.deepEqual((await countAs(owner, USER_B))[0], { allowed: true, failed_attempts: 2, retry_after_seconds: 0 });
    // SQL 130's rate limit still answers next to it.
    await as(api, USER_B);
    assert.deepEqual((await api.query(RATE, [USER_B, 'code_check', 5, 300])).rows[0], { allowed: true, count: 1, retry_after_seconds: 0 });

    // Atomic: two checks at nine, concurrently. The first (in an open transaction) counts the tenth
    // and locks the row; the second waits on the row lock, then sees the lock and is refused.
    await su.query('UPDATE public.financial_totp_enrollments SET failed_attempts = $2, locked_until = NULL WHERE application_user_id = $1', [USER_B, THRESHOLD - 1]);
    await as(api2, USER_B);
    await api.query('BEGIN');
    assert.deepEqual((await countAs(api, USER_B))[0], { allowed: true, failed_attempts: THRESHOLD, retry_after_seconds: 0 });
    let secondSettled = false;
    const second = countAs(api2, USER_B).then((rows) => { secondSettled = true; return rows; });
    await sleep(300);
    assert.equal(secondSettled, false, 'the second check waits for the row lock');
    await api.query('COMMIT');
    const [secondRow] = await second;
    assert.equal(secondRow.allowed, false);
    assert.equal(secondRow.failed_attempts, THRESHOLD);
    assert.equal((await rowOf(USER_B)).failed_attempts, THRESHOLD, 'the waiting check did not count an eleventh');

    // After the lock expires a check is counted again and, with no success in between, locks again at once.
    await su.query("UPDATE public.financial_totp_enrollments SET locked_until = now() - interval '1 second' WHERE application_user_id = $1", [USER_A]);
    await as(api, USER_A);
    assert.deepEqual(await count(USER_A), { allowed: true, failed_attempts: THRESHOLD + 1, retry_after_seconds: 0 });
    assert.ok((await secondsLeft(USER_A)) > LOCK_SECONDS - 60, 'locked again');
    assert.equal((await count(USER_A)).allowed, false);
    // A correct code (financial_totp_mark_verified, unchanged) clears the count and the lock.
    assert.deepEqual((await api.query(MARK, [USER_A, 4242])).rows[0], { claimed: true });
    assert.deepEqual(await rowOf(USER_A), { failed_attempts: 0, locked_until: null });
    assert.deepEqual(await count(USER_A), { allowed: true, failed_attempts: 1, retry_after_seconds: 0 });

    // Running the file again changes nothing.
    await owner.query(SQL132);
    assert.deepEqual((await su.query(CATALOG)).rows[0], after);
    assert.deepEqual((await su.query(COUNT_FN)).rows[0], fnAfter);
    t.diagnostic(`SQL 132: ${newFunction} ACL ${fnAfter.acl.join(', ')}; lock ${Math.round(left)} s at ${THRESHOLD} checks`);
  } finally {
    for (const c of clients) await c.end().catch(() => {});
    server.stop();
  }
});
