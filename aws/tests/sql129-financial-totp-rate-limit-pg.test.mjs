/**
 * SQL 129 (aws/workflows/sql/129_financial_totp_rate_limit_code_check.sql) on PostgreSQL 16, as
 * production has the function: the proposed financial TOTP file
 * (aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql, the live
 * definition per the read-only inspect of 2026-10-30) with EXECUTE for PUBLIC, checksops and the
 * owner, owned by a non-superuser checksops_admin, auth.uid() from aws/identity/sql/02_auth_uid_guc.sql,
 * called as checksops the way the API calls it ($1::uuid, $2, $3::int, $4::int with 5 and 300):
 *
 *   - before SQL 129: 'code_check' raises invalid_rate_limit_action; enroll_start works;
 *   - SQL 129 applied as the owner: 'code_check' is accepted and limited at 5 per 300 s, per user
 *     and per action (a new window starts after 300 s); enroll_start, enroll_confirm and step_up
 *     still work on buckets of their own; another user's bucket is independent; an unknown or
 *     NULL action still raises; the caller check still holds;
 *   - the function keeps its owner, EXECUTE ACL (PUBLIC, checksops, owner), SECURITY DEFINER and
 *     search_path; no other function, table or grant changes; running the file again changes
 *     nothing. The executor's refusal of a second apply is release-sql129-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL129 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/129_financial_totp_rate_limit_code_check.sql'), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql'), 'utf8');
const AUTH_UID = fs.readFileSync(path.join(ROOT, 'aws/identity/sql/02_auth_uid_guc.sql'), 'utf8');
const IDENTITY = 'public.consume_financial_totp_rate_limit(uuid, text, integer, integer)';
// The API's call (aws/functions/api/auth-financial-totp.mjs, providers/production/checkalt-register.mjs).
const CALL = 'SELECT allowed, count, retry_after_seconds FROM public.consume_financial_totp_rate_limit($1::uuid, $2, $3::int, $4::int)';
const LIMIT = 5;
const WINDOW = 300;
const USER_A = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c';
const USER_B = '1c9a7a2f-3a1d-4d8f-8b62-7b4a2e3f5c6d';

const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
CREATE TABLE public.financial_stepup_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid NOT NULL, tenant_id uuid,
  action_key text NOT NULL, factor_type text NOT NULL DEFAULT 'totp', succeeded boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.financial_stepup_log OWNER TO checksops_admin;
`;
// Every function in schema public with its owner, ACL, SECURITY DEFINER, config and body; the
// rate-limit table's ACL and policies; the rate-limit function's ACL as rows.
const CATALOG = `SELECT
  (SELECT pg_catalog.json_agg(json_build_object('f', p.oid::regprocedure::text, 'owner', pg_catalog.pg_get_userbyid(p.proowner),
     'acl', p.proacl::text, 'secdef', p.prosecdef, 'config', p.proconfig, 'body', pg_catalog.md5(p.prosrc)) ORDER BY p.oid::regprocedure::text)
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS functions,
  (SELECT c.relacl::text FROM pg_catalog.pg_class c WHERE c.oid = 'public.financial_totp_rate_limits'::regclass) AS table_acl,
  (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_policy WHERE polrelid = 'public.financial_totp_rate_limits'::regclass) AS policies`;
const RATE_LIMIT_FN = `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile, (SELECT l.lanname FROM pg_catalog.pg_language l WHERE l.oid = p.prolang) AS lang,
    pg_catalog.pg_get_function_result(p.oid) AS result,
    (SELECT pg_catalog.array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type
       ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
     FROM pg_catalog.aclexplode(p.proacl) a) AS acl
  FROM pg_catalog.pg_proc p WHERE p.oid = '${IDENTITY}'::regprocedure`;

test('PostgreSQL 16: SQL 129 lets code_check through the financial TOTP rate limit at 5 per 300 s per user and action; the other actions, the caller check, the ACL, SECURITY DEFINER and search_path unchanged', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-sql129-totp-', 61950);
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
    await su.query('GRANT USAGE ON SCHEMA auth TO checksops_admin, checksops');
    await su.query(PROPOSED);
    // Production's ACL (read-only inspect 2026-10-30): PUBLIC as well as checksops and the owner.
    await su.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO PUBLIC`);

    const api = await open('checksops');
    const as = async (user) => api.query("SELECT pg_catalog.set_config('request.app_user_id', $1, false)", [user]);
    const consume = async (user, action, limit = LIMIT, windowSeconds = WINDOW) => (await api.query(CALL, [user, action, limit, windowSeconds])).rows[0];
    const raises = async (user, action, message, code = '22023') => {
      await assert.rejects(consume(user, action), (error) => {
        assert.equal(error.message, message);
        assert.equal(error.code, code);
        return true;
      });
    };
    const rows = async () => (await su.query('SELECT user_id::text, action, request_count FROM public.financial_totp_rate_limits ORDER BY user_id, action')).rows;

    // Before SQL 129 (the live definition): code_check is refused; the older actions work.
    await as(USER_A);
    await raises(USER_A, 'code_check', 'invalid_rate_limit_action');
    assert.deepEqual(await consume(USER_A, 'enroll_start'), { allowed: true, count: 1, retry_after_seconds: 0 });
    const before = (await su.query(CATALOG)).rows[0];
    const fnBefore = (await su.query(RATE_LIMIT_FN)).rows[0];
    assert.deepEqual(fnBefore, {
      owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], provolatile: 'v', lang: 'plpgsql',
      result: 'TABLE(allowed boolean, count integer, retry_after_seconds integer)',
      acl: ['PUBLIC EXECUTE', 'checksops EXECUTE', 'checksops_admin EXECUTE'],
    });

    // SQL 129, run by the owner as the executor runs it.
    const owner = await open('checksops_admin');
    await owner.query(SQL129);
    const after = (await su.query(CATALOG)).rows[0];
    const changed = after.functions.filter((fn, i) => JSON.stringify(fn) !== JSON.stringify(before.functions[i]));
    assert.equal(after.functions.length, before.functions.length);
    assert.deepEqual(changed.map((fn) => fn.f), ['consume_financial_totp_rate_limit(uuid,text,integer,integer)']);
    const [b, a] = [before, after].map((s) => s.functions.find((fn) => fn.f === changed[0].f));
    assert.deepEqual({ ...a, body: null }, { ...b, body: null }, 'owner, ACL, SECURITY DEFINER and config as before');
    assert.notEqual(a.body, b.body);
    assert.equal(after.table_acl, before.table_acl);
    assert.equal(after.policies, before.policies);
    assert.deepEqual((await su.query(RATE_LIMIT_FN)).rows[0], fnBefore);
    const prosrc = (await su.query(`SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = '${IDENTITY}'::regprocedure`)).rows[0].prosrc;
    const proposedBody = PROPOSED.slice(PROPOSED.indexOf('AS $$', PROPOSED.indexOf('consume_financial_totp_rate_limit(')) + 5);
    assert.equal(prosrc, proposedBody.slice(0, proposedBody.indexOf('$$')).replace(
      "NOT IN ('enroll_start', 'enroll_confirm', 'step_up')", "NOT IN ('enroll_start', 'enroll_confirm', 'step_up', 'code_check')"));

    // code_check: 5 allowed in the window, then refused with a retry-after inside it.
    for (let n = 1; n <= LIMIT; n += 1) assert.deepEqual(await consume(USER_A, 'code_check'), { allowed: true, count: n, retry_after_seconds: 0 });
    const over = await consume(USER_A, 'code_check');
    assert.equal(over.allowed, false);
    assert.equal(over.count, LIMIT + 1);
    assert.ok(over.retry_after_seconds >= 1 && over.retry_after_seconds <= WINDOW, String(over.retry_after_seconds));
    assert.equal((await consume(USER_A, 'code_check')).allowed, false);
    // The other actions keep buckets of their own.
    assert.deepEqual(await consume(USER_A, 'enroll_start'), { allowed: true, count: 2, retry_after_seconds: 0 });
    assert.deepEqual(await consume(USER_A, 'step_up'), { allowed: true, count: 1, retry_after_seconds: 0 });
    assert.deepEqual(await consume(USER_A, 'enroll_confirm'), { allowed: true, count: 1, retry_after_seconds: 0 });
    // Another user's code_check bucket is independent.
    await as(USER_B);
    assert.deepEqual(await consume(USER_B, 'code_check'), { allowed: true, count: 1, retry_after_seconds: 0 });
    // The caller check, an unknown and a NULL action, the bounds: as before.
    await raises(USER_A, 'code_check', 'rate_limit_caller_mismatch', '42501');
    await raises(USER_B, 'Code_Check', 'invalid_rate_limit_action');
    await raises(USER_B, 'code_check_all', 'invalid_rate_limit_action');
    await raises(USER_B, null, 'invalid_rate_limit_action');
    await assert.rejects(consume(USER_B, 'code_check', 101), /invalid_rate_limit_bound/);
    await assert.rejects(consume(USER_B, 'code_check', LIMIT, 3601), /invalid_rate_limit_window/);
    assert.deepEqual(await rows(), [
      { user_id: USER_A, action: 'code_check', request_count: LIMIT + 2 },
      { user_id: USER_A, action: 'enroll_confirm', request_count: 1 },
      { user_id: USER_A, action: 'enroll_start', request_count: 2 },
      { user_id: USER_A, action: 'step_up', request_count: 1 },
      { user_id: USER_B, action: 'code_check', request_count: 1 },
    ]);
    // After 300 s a new window starts.
    await su.query(`UPDATE public.financial_totp_rate_limits SET window_started_at = now() - interval '${WINDOW} seconds'
      WHERE user_id = $1 AND action = 'code_check'`, [USER_A]);
    await as(USER_A);
    assert.deepEqual(await consume(USER_A, 'code_check'), { allowed: true, count: 1, retry_after_seconds: 0 });

    // Running the file again changes nothing.
    await owner.query(SQL129);
    assert.deepEqual((await su.query(CATALOG)).rows[0], after);
  } finally {
    for (const c of clients) await c.end().catch(() => {});
    server.stop();
  }
});
