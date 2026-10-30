/**
 * SQL 131 (aws/workflows/sql/131_financial_totp_functions_no_public.sql) on PostgreSQL 16, from both
 * pre-states the databases have: the proposed financial TOTP file
 * (aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql, the live definition)
 * with SQL 130 applied as the owner, owned by a non-superuser checksops_admin, auth.uid() from
 * aws/identity/sql/02_auth_uid_guc.sql, the four functions called as checksops the way the API calls
 * them (aws/functions/api/auth-financial-totp.mjs, providers/production/checkalt-register.mjs), and
 *
 *   - production: EXECUTE for PUBLIC, checksops and the owner on each (read-only inspect 2026-10-30, SSM cfee4512);
 *   - staging: EXECUTE for checksops and the owner (the proposed-file load revoked PUBLIC; expected).
 *
 * From each:
 *   - before SQL 131: on production a fresh login role holding nothing but PUBLIC can call every one
 *     of the four (the finding); on staging it cannot; the API's calls work as checksops;
 *   - SQL 131 run as the owner: the right people can (checksops: enroll start / confirm, status,
 *     the step-up mark; the owner) and the wrong people can't (a PUBLIC-only login gets
 *     permission denied 42501 on each, before any argument is looked at; has_function_privilege is
 *     false for it and for authenticated); the caller check still holds;
 *   - nothing else changes: each function keeps its owner, SECURITY DEFINER, volatility, search_path,
 *     result and body; consume_financial_totp_rate_limit (SQL 130) and every other function in public
 *     and auth keep their ACL, owner and body; every table ACL, RLS flag and policy is unchanged;
 *   - running the file again changes nothing.
 * Both pre-states end in the identical state. The executor's fingerprints and refusals are
 * release-sql131-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL131 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/131_financial_totp_functions_no_public.sql'), 'utf8');
const SQL130 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql'), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql'), 'utf8');
const AUTH_UID = fs.readFileSync(path.join(ROOT, 'aws/identity/sql/02_auth_uid_guc.sql'), 'utf8');
const IDENTITIES = Object.freeze([
  'public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)',
  'public.financial_totp_get_enrollment(uuid)',
  'public.financial_totp_mark_verified(uuid, bigint)',
  'public.financial_totp_status(uuid)',
]);
// The API's calls (aws/functions/api/auth-financial-totp.mjs lines 145, 154, 239 and 298;
// providers/production/checkalt-register.mjs lines 226 and 227).
const STATUS = 'SELECT enrolled_at, verified_at FROM public.financial_totp_status($1::uuid)';
const GET = `SELECT ciphertext, nonce, key_id, last_used_timestep, verified_at, failed_attempts, locked_until
     FROM public.financial_totp_get_enrollment($1::uuid)`;
const UPSERT = 'SELECT public.financial_totp_upsert_enrollment($1::uuid, $2::bytea, $3::bytea, $4)';
const MARK = 'SELECT public.financial_totp_mark_verified($1::uuid, $2::bigint) AS claimed';
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
// Every function in schema public and auth with its owner, ACL, SECURITY DEFINER, config and body; every
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
const FOUR = `SELECT p.oid::regprocedure::text AS f, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile,
    (SELECT l.lanname FROM pg_catalog.pg_language l WHERE l.oid = p.prolang) AS lang, pg_catalog.pg_get_function_result(p.oid) AS result, pg_catalog.md5(p.prosrc) AS body,
    (SELECT pg_catalog.array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type
       ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
     FROM pg_catalog.aclexplode(p.proacl) a) AS acl
  FROM pg_catalog.pg_proc p WHERE p.oid IN (${IDENTITIES.map((i) => `'${i}'::regprocedure`).join(', ')}) ORDER BY 1`;
const shortName = (identity) => identity.replace('public.', '').replace(/\(.*$/, '');

/**
 * Loads the proposed file (and SQL 130) into a fresh server with `publicGranted` deciding whether PUBLIC
 * holds EXECUTE on the four, applies SQL 131 as the owner and checks the behavior; returns the state after.
 */
async function scenario(pg, t, { name, publicGranted, port }) {
  const server = startPg(`pg-sql131-totp-${name}-`, port);
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
    if (publicGranted) for (const identity of IDENTITIES) await su.query(`GRANT EXECUTE ON FUNCTION ${identity} TO PUBLIC`);

    const api = await open('checksops');
    const stranger = await open('stranger');
    const as = async (client, user) => client.query("SELECT pg_catalog.set_config('request.app_user_id', $1, false)", [user]);
    const status = async (client, user) => (await client.query(STATUS, [user])).rows[0] || null;
    const enrollment = async (client, user) => (await client.query(GET, [user])).rows[0] || null;
    const upsert = (client, user, keyId = 'kms-key-1') => client.query(UPSERT, [user, Buffer.from('ciphertext'), Buffer.from('nonce'), keyId]);
    const mark = async (client, user, timestep) => (await client.query(MARK, [user, timestep])).rows[0].claimed;
    const strangerDenied = async () => {
      await assert.rejects(status(stranger, USER_C), (e) => e.code === '42501' && /^permission denied for function financial_totp_status$/.test(e.message));
      await assert.rejects(enrollment(stranger, USER_C), (e) => e.code === '42501' && /^permission denied for function financial_totp_get_enrollment$/.test(e.message));
      await assert.rejects(upsert(stranger, USER_C), (e) => e.code === '42501' && /^permission denied for function financial_totp_upsert_enrollment$/.test(e.message));
      await assert.rejects(mark(stranger, USER_C, null), (e) => e.code === '42501' && /^permission denied for function financial_totp_mark_verified$/.test(e.message));
    };
    const privileges = async (role) => Object.fromEntries(await Promise.all(IDENTITIES.map(async (identity) => [identity,
      (await su.query('SELECT pg_catalog.has_function_privilege($1, $2, \'EXECUTE\') AS ok', [role, identity])).rows[0].ok])));

    // Before SQL 131: the API's calls work as checksops.
    await as(api, USER_A);
    assert.equal(await status(api, USER_A), null);
    const fourBefore = (await su.query(FOUR)).rows;
    assert.equal(fourBefore.length, 4);
    for (const row of fourBefore) {
      assert.equal(row.owner, 'checksops_admin', row.f);
      assert.equal(row.prosecdef, true, row.f);
      assert.deepEqual(row.proconfig, ['search_path=public, pg_temp'], row.f);
      assert.equal(row.lang, 'plpgsql', row.f);
      assert.deepEqual(row.acl, publicGranted ? ['PUBLIC EXECUTE', 'checksops EXECUTE', 'checksops_admin EXECUTE'] : ['checksops EXECUTE', 'checksops_admin EXECUTE'], row.f);
    }
    // A login holding nothing but PUBLIC: allowed in on production's ACL (the finding), denied on staging's.
    await as(stranger, USER_C);
    if (publicGranted) {
      assert.equal(await status(stranger, USER_C), null);
      assert.equal(await enrollment(stranger, USER_C), null);
      assert.equal(await mark(stranger, USER_C, null), false);
      await upsert(stranger, USER_C);
      assert.notEqual(await status(stranger, USER_C), null, 'a PUBLIC-only login enrolled a TOTP secret through the SECURITY DEFINER function');
      await su.query('DELETE FROM public.financial_totp_enrollments WHERE application_user_id = $1', [USER_C]);
      assert.deepEqual(Object.values(await privileges('stranger')), [true, true, true, true]);
    } else {
      await strangerDenied();
      assert.deepEqual(Object.values(await privileges('stranger')), [false, false, false, false]);
    }
    const before = (await su.query(CATALOG)).rows[0];

    // SQL 131, run by the owner as the executor runs it.
    await owner.query(SQL131);
    const after = (await su.query(CATALOG)).rows[0];
    // Only the four functions' ACLs changed (on production); nothing on staging. Every other function
    // (consume_financial_totp_rate_limit included), relation and policy is unchanged.
    assert.equal(after.functions.length, before.functions.length);
    const changed = after.functions.filter((fn, i) => JSON.stringify(fn) !== JSON.stringify(before.functions[i]));
    if (publicGranted) {
      assert.deepEqual(changed.map((fn) => fn.f).sort(), IDENTITIES.map((i) => i.replace('public.', '').replace(/, /g, ',')).sort());
      for (const a of changed) {
        const b = before.functions.find((fn) => fn.f === a.f);
        assert.deepEqual({ ...a, acl: null }, { ...b, acl: null }, `${a.f}: owner, SECURITY DEFINER, volatility, config and body as before`);
        assert.notEqual(a.acl, b.acl, a.f);
      }
    } else {
      assert.deepEqual(changed, [], 'staging: the REVOKEs and the GRANTs change nothing');
      assert.deepEqual(after, before);
    }
    const consume = after.functions.find((fn) => fn.f === 'consume_financial_totp_rate_limit(uuid,text,integer,integer)');
    assert.ok(consume);
    assert.deepEqual(consume, before.functions.find((fn) => fn.f === consume.f));
    assert.deepEqual(after.relations, before.relations);
    assert.deepEqual(after.policies, before.policies);
    const fourAfter = (await su.query(FOUR)).rows;
    assert.deepEqual(fourAfter, fourBefore.map((row) => ({ ...row, acl: ['checksops EXECUTE', 'checksops_admin EXECUTE'] })));

    // Wrong people can't: a login with only PUBLIC is denied on each, before any argument is looked at.
    await strangerDenied();
    await as(stranger, USER_A);
    await strangerDenied();
    assert.deepEqual(Object.values(await privileges('stranger')), [false, false, false, false]);
    assert.deepEqual(Object.values(await privileges('authenticated')), [false, false, false, false]);
    assert.deepEqual(Object.values(await privileges('checksops')), [true, true, true, true]);
    assert.deepEqual(Object.values(await privileges('checksops_admin')), [true, true, true, true]);

    // Right people can: the API's flows as checksops. Enroll start ...
    await as(api, USER_A);
    assert.equal(await status(api, USER_A), null);
    await upsert(api, USER_A);
    const enrolled = await status(api, USER_A);
    assert.ok(enrolled.enrolled_at instanceof Date);
    assert.equal(enrolled.verified_at, null);
    const row = await enrollment(api, USER_A);
    assert.equal(Buffer.from(row.ciphertext).toString(), 'ciphertext');
    assert.equal(Buffer.from(row.nonce).toString(), 'nonce');
    assert.equal(row.key_id, 'kms-key-1');
    assert.equal(row.last_used_timestep, null);
    assert.equal(row.verified_at, null);
    assert.equal(row.failed_attempts, 0);
    assert.equal(row.locked_until, null);
    // ... enroll confirm (the timestep is consumed once) ...
    assert.equal(await mark(api, USER_A, 1700000), true);
    assert.ok((await status(api, USER_A)).verified_at instanceof Date);
    assert.equal((await enrollment(api, USER_A)).last_used_timestep, '1700000');
    assert.equal(await mark(api, USER_A, 1700000), false, 'a replayed timestep is not claimed');
    assert.equal(await mark(api, USER_A, 1700001), true);
    // ... a step-up that marks without consuming a timestep (the API passes NULL) ...
    assert.equal(await mark(api, USER_A, null), true);
    // ... a verified enrollment cannot be overwritten, and the caller check still holds.
    await assert.rejects(upsert(api, USER_A), (e) => e.code === 'P0001' && /verified_enrollment_exists/.test(e.message));
    await assert.rejects(upsert(api, USER_B), (e) => e.code === '42501' && /enrollment_caller_mismatch/.test(e.message));
    await assert.rejects(status(api, USER_B), (e) => e.code === '42501' && /enrollment_caller_mismatch/.test(e.message));
    // Another user is independent.
    await as(api, USER_B);
    assert.equal(await status(api, USER_B), null);
    assert.equal(await mark(api, USER_B, 1700000), false);
    // The owner can execute them too.
    await as(owner, USER_C);
    assert.equal(await status(owner, USER_C), null);
    await su.query('DELETE FROM public.financial_totp_enrollments');

    // Running the file again changes nothing.
    await owner.query(SQL131);
    assert.deepEqual((await su.query(CATALOG)).rows[0], after);
    assert.deepEqual((await su.query(FOUR)).rows, fourAfter);
    t.diagnostic(`${name}: ${IDENTITIES.map(shortName).join(', ')} ACL ${fourBefore[0].acl.join(', ')} -> ${fourAfter[0].acl.join(', ')}`);
    return { four: fourAfter, catalog: after };
  } finally {
    for (const c of clients) await c.end().catch(() => {});
    server.stop();
  }
}

test('PostgreSQL 16: SQL 131 from production\'s pre-state (PUBLIC granted) and from staging\'s (no PUBLIC): checksops and the owner can execute the four and the API flows work, a PUBLIC-only login cannot; nothing else changes; both end identical; a second run is a no-op', {
  timeout: 240000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const production = await scenario(pg, t, { name: 'production', publicGranted: true, port: 62250 });
  const staging = await scenario(pg, t, { name: 'staging', publicGranted: false, port: 62350 });
  assert.deepEqual(staging.four, production.four);
  // The whole catalog after (functions, relations, policies) is the same from either pre-state.
  assert.deepEqual(staging.catalog, production.catalog);
});
