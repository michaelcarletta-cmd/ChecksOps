/**
 * SQL 130 (aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql) on PostgreSQL 16,
 * from both pre-states the databases have: the proposed financial TOTP file
 * (aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql, the live definition)
 * owned by a non-superuser checksops_admin, auth.uid() from aws/identity/sql/02_auth_uid_guc.sql,
 * called as checksops the way the API calls it ($1::uuid, $2, $3::int, $4::int with 5 and 300), and
 *
 *   - production: EXECUTE for PUBLIC, checksops and the owner (read-only inspect 2026-10-30, SSM cfee4512);
 *   - staging: EXECUTE for checksops and the owner (SQL 129's read-live, run 41081764481).
 *
 * From each:
 *   - before SQL 130: 'code_check' raises invalid_rate_limit_action; enroll_start works; on production
 *     a fresh login role holding nothing but PUBLIC can call the function, on staging it cannot;
 *   - SQL 130 applied as the owner: 'code_check' is accepted and limited at 5 per 300 s, per user and
 *     per action (a new window starts after 300 s); enroll_start, enroll_confirm and step_up keep
 *     buckets of their own; another user's bucket is independent; an unknown, differently cased or
 *     NULL action still raises; the caller check and the bounds still hold;
 *   - checksops and the owner can execute it; a fresh login role with only PUBLIC gets permission
 *     denied; the function keeps its owner, SECURITY DEFINER, VOLATILE and search_path; EXECUTE is
 *     checksops and the owner;
 *   - nothing else changes: every other function in schema public (the other financial_totp_*
 *     functions included) keeps its ACL, owner and body; every table ACL and policy is unchanged;
 *   - running the file again changes nothing.
 * Both pre-states end in the identical function state. The executor's fingerprints and refusals are
 * release-sql130-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL130 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql'), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql'), 'utf8');
const AUTH_UID = fs.readFileSync(path.join(ROOT, 'aws/identity/sql/02_auth_uid_guc.sql'), 'utf8');
const IDENTITY = 'public.consume_financial_totp_rate_limit(uuid, text, integer, integer)';
// The API's call (aws/functions/api/auth-financial-totp.mjs, providers/production/checkalt-register.mjs).
const CALL = 'SELECT allowed, count, retry_after_seconds FROM public.consume_financial_totp_rate_limit($1::uuid, $2, $3::int, $4::int)';
const LIMIT = 5;
const WINDOW = 300;
const USER_A = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c';
const USER_B = '1c9a7a2f-3a1d-4d8f-8b62-7b4a2e3f5c6d';
const USER_C = '2d0b8b3a-4b2e-4e9a-9c73-8c5b3f4a6d7e';
const OLD_ALLOW_LIST = "NOT IN ('enroll_start', 'enroll_confirm', 'step_up')";
const NEW_ALLOW_LIST = "NOT IN ('enroll_start', 'enroll_confirm', 'step_up', 'code_check')";

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
// Every function in schema public with its owner, ACL, SECURITY DEFINER, config and body; every
// relation's ACL and RLS flags in schema public; every policy.
const CATALOG = `SELECT
  (SELECT pg_catalog.json_agg(json_build_object('f', p.oid::regprocedure::text, 'owner', pg_catalog.pg_get_userbyid(p.proowner),
     'acl', p.proacl::text, 'secdef', p.prosecdef, 'config', p.proconfig, 'vol', p.provolatile, 'body', pg_catalog.md5(p.prosrc)) ORDER BY p.oid::regprocedure::text)
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'auth')) AS functions,
  (SELECT pg_catalog.json_agg(json_build_object('r', c.relname, 'acl', c.relacl::text, 'rls', c.relrowsecurity, 'force', c.relforcerowsecurity) ORDER BY c.relname)
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations,
  (SELECT pg_catalog.json_agg(json_build_object('t', polrelid::regclass::text, 'p', polname, 'cmd', polcmd, 'roles', polroles::text,
     'qual', pg_catalog.pg_get_expr(polqual, polrelid), 'check', pg_catalog.pg_get_expr(polwithcheck, polrelid)) ORDER BY polrelid::regclass::text, polname)
   FROM pg_catalog.pg_policy) AS policies`;
const RATE_LIMIT_FN = `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile, (SELECT l.lanname FROM pg_catalog.pg_language l WHERE l.oid = p.prolang) AS lang,
    pg_catalog.pg_get_function_result(p.oid) AS result, pg_catalog.md5(p.prosrc) AS body,
    (SELECT pg_catalog.array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type
       ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
     FROM pg_catalog.aclexplode(p.proacl) a) AS acl
  FROM pg_catalog.pg_proc p WHERE p.oid = '${IDENTITY}'::regprocedure`;
const md5 = async (su, text) => (await su.query('SELECT pg_catalog.md5($1) AS h', [text])).rows[0].h;
const proposedBody = () => {
  const start = PROPOSED.indexOf('AS $$', PROPOSED.indexOf('consume_financial_totp_rate_limit(')) + 5;
  return PROPOSED.slice(start, PROPOSED.indexOf('$$', start));
};

/**
 * Loads the proposed file into a fresh server with `acl` as the function's EXECUTE grantees, applies
 * SQL 130 as the owner and checks the behavior; returns the function's state after.
 */
async function scenario(pg, t, { name, publicGranted, port }) {
  const server = startPg(`pg-sql130-totp-${name}-`, port);
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
    if (publicGranted) await su.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO PUBLIC`);

    const api = await open('checksops');
    const owner = await open('checksops_admin');
    const stranger = await open('stranger');
    const as = async (client, user) => client.query("SELECT pg_catalog.set_config('request.app_user_id', $1, false)", [user]);
    const consumeAs = async (client, user, action, limit = LIMIT, windowSeconds = WINDOW) => (await client.query(CALL, [user, action, limit, windowSeconds])).rows[0];
    const consume = (user, action, limit, windowSeconds) => consumeAs(api, user, action, limit, windowSeconds);
    const raises = async (user, action, message, code = '22023') => {
      await assert.rejects(consume(user, action), (error) => {
        assert.equal(error.message, message);
        assert.equal(error.code, code);
        return true;
      });
    };
    const strangerDenied = async () => {
      await assert.rejects(consumeAs(stranger, USER_C, 'code_check'), (error) => {
        assert.equal(error.code, '42501');
        assert.match(error.message, /^permission denied for function consume_financial_totp_rate_limit$/);
        return true;
      });
    };
    const rows = async () => (await su.query('SELECT user_id::text, action, request_count FROM public.financial_totp_rate_limits ORDER BY user_id, action')).rows;

    // Before SQL 130 (the live definition): code_check is refused; the older actions work.
    await as(api, USER_A);
    await raises(USER_A, 'code_check', 'invalid_rate_limit_action');
    assert.deepEqual(await consume(USER_A, 'enroll_start'), { allowed: true, count: 1, retry_after_seconds: 0 });
    const fnBefore = (await su.query(RATE_LIMIT_FN)).rows[0];
    assert.deepEqual(fnBefore, {
      owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], provolatile: 'v', lang: 'plpgsql',
      result: 'TABLE(allowed boolean, count integer, retry_after_seconds integer)', body: await md5(su, proposedBody()),
      acl: publicGranted ? ['PUBLIC EXECUTE', 'checksops EXECUTE', 'checksops_admin EXECUTE'] : ['checksops EXECUTE', 'checksops_admin EXECUTE'],
    });
    // A login holding nothing but PUBLIC: allowed in on production's ACL (the finding), denied on staging's.
    await as(stranger, USER_C);
    if (publicGranted) {
      await assert.rejects(consumeAs(stranger, USER_C, 'code_check'), /invalid_rate_limit_action/);
      assert.deepEqual(await consumeAs(stranger, USER_C, 'step_up'), { allowed: true, count: 1, retry_after_seconds: 0 });
      await su.query('DELETE FROM public.financial_totp_rate_limits WHERE user_id = $1', [USER_C]);
    } else {
      await strangerDenied();
    }
    const before = (await su.query(CATALOG)).rows[0];

    // SQL 130, run by the owner as the executor runs it.
    await owner.query(SQL130);
    const after = (await su.query(CATALOG)).rows[0];
    // Only the rate-limit function changed: body and (on production) the ACL; owner, SECURITY DEFINER,
    // VOLATILE and config as before. Every other function, relation and policy is unchanged.
    assert.equal(after.functions.length, before.functions.length);
    const changed = after.functions.filter((fn, i) => JSON.stringify(fn) !== JSON.stringify(before.functions[i]));
    assert.deepEqual(changed.map((fn) => fn.f), ['consume_financial_totp_rate_limit(uuid,text,integer,integer)']);
    const [b, a] = [before, after].map((s) => s.functions.find((fn) => fn.f === changed[0].f));
    assert.deepEqual({ ...a, body: null, acl: null }, { ...b, body: null, acl: null }, 'owner, SECURITY DEFINER, volatility and config as before');
    assert.notEqual(a.body, b.body);
    if (publicGranted) assert.notEqual(a.acl, b.acl);
    else assert.equal(a.acl, b.acl, 'staging: the REVOKE and the GRANT change nothing');
    for (const other of ['financial_totp_upsert_enrollment(uuid,bytea,bytea,text)', 'financial_totp_get_enrollment(uuid)',
      'financial_totp_mark_verified(uuid,bigint)', 'financial_totp_status(uuid)']) {
      const was = before.functions.find((fn) => fn.f === other);
      assert.ok(was, other);
      assert.deepEqual(after.functions.find((fn) => fn.f === other), was, other);
    }
    assert.deepEqual(after.relations, before.relations);
    assert.deepEqual(after.policies, before.policies);
    const fnAfter = (await su.query(RATE_LIMIT_FN)).rows[0];
    assert.deepEqual(fnAfter, {
      ...fnBefore, body: await md5(su, proposedBody().replace(OLD_ALLOW_LIST, NEW_ALLOW_LIST)),
      acl: ['checksops EXECUTE', 'checksops_admin EXECUTE'],
    });
    const prosrc = (await su.query(`SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = '${IDENTITY}'::regprocedure`)).rows[0].prosrc;
    assert.equal(prosrc, proposedBody().replace(OLD_ALLOW_LIST, NEW_ALLOW_LIST));

    // Wrong people can't: a login with only PUBLIC is denied, before any argument is looked at.
    await strangerDenied();
    await as(stranger, USER_A);
    await strangerDenied();
    assert.equal((await su.query("SELECT pg_catalog.has_function_privilege('stranger', $1, 'EXECUTE') AS ok", [IDENTITY])).rows[0].ok, false);
    assert.equal((await su.query("SELECT pg_catalog.has_function_privilege('authenticated', $1, 'EXECUTE') AS ok", [IDENTITY])).rows[0].ok, false);

    // Right people can: checksops (the API) and the owner.
    await as(api, USER_A);
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
    await as(api, USER_B);
    assert.deepEqual(await consume(USER_B, 'code_check'), { allowed: true, count: 1, retry_after_seconds: 0 });
    // The caller check, an unknown, a differently cased and a NULL action, the bounds: as before.
    await raises(USER_A, 'code_check', 'rate_limit_caller_mismatch', '42501');
    await raises(USER_B, 'Code_Check', 'invalid_rate_limit_action');
    await raises(USER_B, 'code_check_all', 'invalid_rate_limit_action');
    await raises(USER_B, 'lockout', 'invalid_rate_limit_action');
    await raises(USER_B, null, 'invalid_rate_limit_action');
    await assert.rejects(consume(USER_B, 'code_check', 101), /invalid_rate_limit_bound/);
    await assert.rejects(consume(USER_B, 'code_check', LIMIT, 3601), /invalid_rate_limit_window/);
    // The owner can execute it too (its own bucket for USER_C).
    await as(owner, USER_C);
    assert.deepEqual(await consumeAs(owner, USER_C, 'code_check'), { allowed: true, count: 1, retry_after_seconds: 0 });
    assert.deepEqual(await rows(), [
      { user_id: USER_A, action: 'code_check', request_count: LIMIT + 2 },
      { user_id: USER_A, action: 'enroll_confirm', request_count: 1 },
      { user_id: USER_A, action: 'enroll_start', request_count: 2 },
      { user_id: USER_A, action: 'step_up', request_count: 1 },
      { user_id: USER_B, action: 'code_check', request_count: 1 },
      { user_id: USER_C, action: 'code_check', request_count: 1 },
    ]);
    // After 300 s a new window starts.
    await su.query(`UPDATE public.financial_totp_rate_limits SET window_started_at = now() - interval '${WINDOW} seconds'
      WHERE user_id = $1 AND action = 'code_check'`, [USER_A]);
    await as(api, USER_A);
    assert.deepEqual(await consume(USER_A, 'code_check'), { allowed: true, count: 1, retry_after_seconds: 0 });

    // Running the file again changes nothing.
    await owner.query(SQL130);
    assert.deepEqual((await su.query(CATALOG)).rows[0], after);
    assert.deepEqual((await su.query(RATE_LIMIT_FN)).rows[0], fnAfter);
    t.diagnostic(`${name}: ACL ${fnBefore.acl.join(', ')} -> ${fnAfter.acl.join(', ')}`);
    return { fn: fnAfter, prosrc, catalog: after };
  } finally {
    for (const c of clients) await c.end().catch(() => {});
    server.stop();
  }
}

test('PostgreSQL 16: SQL 130 from production\'s pre-state (PUBLIC granted) and from staging\'s (no PUBLIC): code_check at 5 per 300 s per user and action, checksops and the owner can execute, a PUBLIC-only login cannot; nothing else changes; both end identical; a second run is a no-op', {
  timeout: 240000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const production = await scenario(pg, t, { name: 'production', publicGranted: true, port: 62050 });
  const staging = await scenario(pg, t, { name: 'staging', publicGranted: false, port: 62150 });
  assert.deepEqual(staging.fn, production.fn);
  assert.equal(staging.prosrc, production.prosrc);
  // The whole catalog after (functions, relations, policies) is the same from either pre-state.
  assert.deepEqual(staging.catalog, production.catalog);
});
