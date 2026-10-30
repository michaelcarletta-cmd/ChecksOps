/**
 * SQL 133 (aws/workflows/sql/133_financial_totp_admin_reset_enrollment.sql) on PostgreSQL 16, from the
 * pre-state both databases have: the proposed financial TOTP file
 * (aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql, the live definition)
 * owned by a non-superuser checksops_admin, tenant_users / identity_accounts / profiles owned by the
 * same login with RLS on (as the AWS databases have them), auth.uid() from
 * aws/identity/sql/02_auth_uid_guc.sql, and the function called as checksops the way the API calls it
 * ($1::uuid, $2::uuid; the existence check through pg_catalog.to_regprocedure).
 *
 *   - before SQL 133: the function is absent (the API's existence check reads NULL);
 *   - the file refuses without the enrollment table (55000 sql133_prerequisite_missing) and when the
 *     applying login could not reach one of the four relations as a DEFINER owner (FORCE ROW LEVEL
 *     SECURITY on tenant_users: 55000 sql133_definer_cannot_reach), and creates nothing then;
 *   - SQL 133 applied as the owner. Right people can: a member of the target's tenant (the stored
 *     role is not read: a viewer resets an owner) deletes the target's verified row (cleared true),
 *     after which the target's enrollment start (financial_totp_upsert_enrollment, which raised
 *     verified_enrollment_exists before) succeeds again; a target without a row answers cleared false,
 *     no error; the owner login can execute it too. Wrong people can't: self (cannot_reset_own_totp),
 *     a member of another tenant (reset_target_not_teammate), the platform owner as target by identity
 *     email and by profile email alone (platform_owner_protected), a caller that is not auth.uid() or
 *     has no identity (enrollment_caller_mismatch), a NULL id (invalid_reset): each raises and deletes
 *     nothing; a fresh login holding nothing but PUBLIC gets permission denied before any argument is
 *     looked at;
 *   - nothing else changes: every other function in schema public and auth (the four proposed-file
 *     functions and SQL 130 / 132's included) keeps its ACL, owner and body; every table ACL, RLS flag
 *     and policy is unchanged; the other users' rows are untouched;
 *   - running the file again changes nothing.
 * The executor's fingerprints and refusals are release-sql133-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL133 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/133_financial_totp_admin_reset_enrollment.sql'), 'utf8');
const SQL132 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/132_financial_totp_code_check_lockout.sql'), 'utf8');
const SQL130 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql'), 'utf8');
const PROPOSED = fs.readFileSync(path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql'), 'utf8');
const AUTH_UID = fs.readFileSync(path.join(ROOT, 'aws/identity/sql/02_auth_uid_guc.sql'), 'utf8');
const IDENTITY = 'public.financial_totp_admin_reset_enrollment(uuid, uuid)';
// The API's calls (aws/functions/api/admin-reset-totp.mjs; the enrollment start is auth-financial-totp.mjs's).
const PRESENT = 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present';
const CALL = 'SELECT cleared FROM public.financial_totp_admin_reset_enrollment($1::uuid, $2::uuid)';
const ENROLL = 'SELECT public.financial_totp_upsert_enrollment($1::uuid, $2::bytea, $3::bytea, $4)';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const ADMIN_A = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c'; // tenant A, stored role viewer
const TARGET_A = '1c9a7a2f-3a1d-4d8f-8b62-7b4a2e3f5c6d'; // tenant A, stored role owner, verified enrollment
const OTHER_A = '2d0b8b3a-4b2e-4e9a-9c73-8c5b3f4a6d7e'; // tenant A, no enrollment
const MEMBER_B = '3e1c9c4b-5c3f-4fab-8d84-9d6c4a5b7e8f'; // tenant B, verified enrollment
const PLATFORM_OWNER = '4f2dad5c-6d4a-4abc-9e95-ae7d5b6c8f9a'; // tenant A, identity email checksopsadmin@gmail.com
const PROFILE_OWNER = '5a3ebe6d-7e5b-4bcd-8fa6-bf8e6c7d9a0b'; // tenant A, profile email checksopsadmin@gmail.com only
const NOBODY = '6b4fcf7e-8f6c-4cde-9ab7-ca9f7d8e0b1c'; // no tenant

const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE stranger LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
GRANT USAGE ON SCHEMA public TO checksops, stranger;
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, UNIQUE (tenant_id, user_id));
CREATE TABLE public.financial_stepup_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid NOT NULL, tenant_id uuid,
  action_key text NOT NULL, factor_type text NOT NULL DEFAULT 'totp', succeeded boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.identity_accounts OWNER TO checksops_admin;
ALTER TABLE public.profiles OWNER TO checksops_admin;
ALTER TABLE public.tenant_users OWNER TO checksops_admin;
ALTER TABLE public.financial_stepup_log OWNER TO checksops_admin;
ALTER TABLE public.identity_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tenant_users, public.identity_accounts, public.profiles TO checksops, authenticated;
`;
// Policies that read auth.uid(): a gate run as the invoker would see one user's rows only; the DEFINER sees all.
const POLICIES = `
CREATE POLICY aws_select_tenant_users ON public.tenant_users FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY aws_select_profiles ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
`;
const SEED = `
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${ADMIN_A}', 'viewer'), ('${TENANT_A}', '${TARGET_A}', 'owner'), ('${TENANT_A}', '${OTHER_A}', 'operator'),
  ('${TENANT_A}', '${PLATFORM_OWNER}', 'admin'), ('${TENANT_A}', '${PROFILE_OWNER}', 'admin'),
  ('${TENANT_B}', '${MEMBER_B}', 'owner');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${ADMIN_A}', 'admin-a@example.invalid', 'active'), ('${TARGET_A}', 'target-a@example.invalid', 'active'),
  ('${OTHER_A}', 'other-a@example.invalid', 'active'), ('${MEMBER_B}', 'member-b@example.invalid', 'active'),
  ('${PLATFORM_OWNER}', 'CheckSOpsAdmin@gmail.com', 'active'), ('${PROFILE_OWNER}', 'owner-alias@example.invalid', 'active');
INSERT INTO public.profiles (id, email) VALUES
  ('${ADMIN_A}', 'admin-a@example.invalid'), ('${TARGET_A}', 'target-a@example.invalid'), ('${OTHER_A}', 'other-a@example.invalid'),
  ('${MEMBER_B}', 'member-b@example.invalid'), ('${PLATFORM_OWNER}', 'CheckSOpsAdmin@gmail.com'), ('${PROFILE_OWNER}', 'checksopsadmin@gmail.com');
INSERT INTO public.financial_totp_enrollments (application_user_id, ciphertext, nonce, key_id, verified_at, last_used_timestep, failed_attempts)
  VALUES ('${TARGET_A}', '\\x01'::bytea, '\\x02'::bytea, 'financial-totp-v1', now(), 4242, 3),
         ('${MEMBER_B}', '\\x03'::bytea, '\\x04'::bytea, 'financial-totp-v1', now(), NULL, 0),
         ('${PLATFORM_OWNER}', '\\x05'::bytea, '\\x06'::bytea, 'financial-totp-v1', now(), NULL, 0),
         ('${PROFILE_OWNER}', '\\x07'::bytea, '\\x08'::bytea, 'financial-totp-v1', now(), NULL, 0),
         ('${ADMIN_A}', '\\x09'::bytea, '\\x0a'::bytea, 'financial-totp-v1', now(), NULL, 0);
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
const RESET_FN = `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile, (SELECT l.lanname FROM pg_catalog.pg_language l WHERE l.oid = p.prolang) AS lang,
    pg_catalog.pg_get_function_result(p.oid) AS result, pg_catalog.md5(p.prosrc) AS body,
    (SELECT pg_catalog.array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type
       ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
     FROM pg_catalog.aclexplode(p.proacl) a) AS acl
  FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('${IDENTITY}')`;
const fileBody = () => {
  const start = SQL133.indexOf('AS $$', SQL133.indexOf('financial_totp_admin_reset_enrollment(')) + 5;
  return SQL133.slice(start, SQL133.indexOf('$$', start));
};
const newFunction = 'financial_totp_admin_reset_enrollment(uuid,uuid)';

test('PostgreSQL 16: SQL 133 on the proposed schema: refuses without its prerequisites; a tenant-mate resets a teammate (row gone, enrollment start works again), no row answers cleared false; self, another tenant, the platform owner, a caller mismatch and a PUBLIC-only login are refused and delete nothing; nothing else changes; a second run is a no-op', {
  timeout: 240000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-sql133-totp-admin-reset-', 62350);
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
    await su.query('GRANT USAGE ON SCHEMA auth TO checksops_admin, checksops, stranger, authenticated');
    await su.query(POLICIES);
    await su.query(PROPOSED);
    const owner = await open('checksops_admin');
    // SQL 130 and SQL 132 as the owner: the function must not touch them, and the deleted row carries SQL 132's counters.
    await owner.query(SQL130);
    await owner.query(SQL132);
    await su.query(SEED);
    const api = await open('checksops');
    const stranger = await open('stranger');
    const as = async (client, user) => client.query("SELECT pg_catalog.set_config('request.app_user_id', $1, false)", [user]);
    const present = async (client) => (await client.query(PRESENT, [IDENTITY])).rows[0].present;
    const resetAs = async (client, actor, target) => (await client.query(CALL, [actor, target])).rows[0];
    const rows = async () => (await su.query('SELECT application_user_id, verified_at IS NOT NULL AS verified, failed_attempts FROM public.financial_totp_enrollments ORDER BY application_user_id')).rows;
    const raises = async (fn, code, message) => {
      await assert.rejects(fn(), (error) => {
        assert.equal(error.code, code, error.message);
        assert.match(error.message, message);
        return true;
      });
    };
    const seeded = await rows();
    assert.equal(seeded.length, 5);

    // Before SQL 133: the function is absent; the API's existence check reads NULL (as checksops too).
    assert.equal(await present(su), false);
    assert.equal(await present(api), false);
    const before = (await su.query(CATALOG)).rows[0];
    assert.ok(before.functions.some((fn) => fn.f === 'financial_totp_count_code_check(uuid)'));
    assert.ok(!before.functions.some((fn) => fn.f === newFunction));

    // Refused without the enrollment table, and when the owner could not reach a gate table as a DEFINER: nothing created.
    await owner.query('ALTER TABLE public.financial_totp_enrollments RENAME TO financial_totp_enrollments_moved');
    await raises(() => owner.query(SQL133), '55000', /^sql133_prerequisite_missing: .*public\.financial_totp_enrollments/);
    await owner.query('ALTER TABLE public.financial_totp_enrollments_moved RENAME TO financial_totp_enrollments');
    assert.equal(await present(su), false);
    await owner.query('ALTER TABLE public.tenant_users FORCE ROW LEVEL SECURITY');
    await raises(() => owner.query(SQL133), '55000', /^sql133_definer_cannot_reach: .*tenant_users/);
    await owner.query('ALTER TABLE public.tenant_users NO FORCE ROW LEVEL SECURITY');
    assert.equal(await present(su), false);
    assert.deepEqual((await su.query(CATALOG)).rows[0], before, 'the refusals changed nothing');

    // SQL 133, run by the owner as the executor runs it.
    await owner.query(SQL133);
    assert.equal(await present(api), true);
    const after = (await su.query(CATALOG)).rows[0];
    // One function added; every other function, every relation and every policy unchanged.
    assert.equal(after.functions.length, before.functions.length + 1);
    assert.deepEqual(after.functions.filter((fn) => fn.f !== newFunction), before.functions);
    assert.deepEqual(after.relations, before.relations);
    assert.deepEqual(after.policies, before.policies);
    const fnAfter = (await su.query(RESET_FN)).rows[0];
    assert.deepEqual(fnAfter, {
      owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], provolatile: 'v', lang: 'plpgsql',
      result: 'TABLE(cleared boolean)',
      body: (await su.query('SELECT pg_catalog.md5($1) AS h', [fileBody()])).rows[0].h,
      acl: ['checksops EXECUTE', 'checksops_admin EXECUTE'],
    });

    // Wrong people can't: a login with only PUBLIC is denied, before any argument is looked at.
    await as(stranger, ADMIN_A);
    await raises(() => resetAs(stranger, ADMIN_A, TARGET_A), '42501', /^permission denied for function financial_totp_admin_reset_enrollment$/);
    assert.equal((await su.query("SELECT pg_catalog.has_function_privilege('stranger', $1, 'EXECUTE') AS ok", [IDENTITY])).rows[0].ok, false);
    assert.equal((await su.query("SELECT pg_catalog.has_function_privilege('authenticated', $1, 'EXECUTE') AS ok", [IDENTITY])).rows[0].ok, false);
    assert.equal((await su.query("SELECT pg_catalog.has_function_privilege('checksops', $1, 'EXECUTE') AS ok", [IDENTITY])).rows[0].ok, true);

    // The caller check: no identity, another user's identity, NULL ids.
    await raises(() => resetAs(api, ADMIN_A, TARGET_A), '42501', /^enrollment_caller_mismatch$/);
    await as(api, OTHER_A);
    await raises(() => resetAs(api, ADMIN_A, TARGET_A), '42501', /^enrollment_caller_mismatch$/);
    await as(api, ADMIN_A);
    await raises(() => resetAs(api, null, TARGET_A), '22023', /^invalid_reset$/);
    await raises(() => resetAs(api, ADMIN_A, null), '22023', /^invalid_reset$/);
    // Self: refused, however the caller is enrolled.
    await raises(() => resetAs(api, ADMIN_A, ADMIN_A), '42501', /^cannot_reset_own_totp$/);
    // Another tenant's member, and someone in no tenant: refused.
    await raises(() => resetAs(api, ADMIN_A, MEMBER_B), '42501', /^reset_target_not_teammate$/);
    await raises(() => resetAs(api, ADMIN_A, NOBODY), '42501', /^reset_target_not_teammate$/);
    await as(api, MEMBER_B);
    await raises(() => resetAs(api, MEMBER_B, TARGET_A), '42501', /^reset_target_not_teammate$/);
    // The platform owner as target, by identity email (any case) and by profile email alone: refused, even from a shared tenant.
    await as(api, ADMIN_A);
    await raises(() => resetAs(api, ADMIN_A, PLATFORM_OWNER), '42501', /^platform_owner_protected$/);
    await raises(() => resetAs(api, ADMIN_A, PROFILE_OWNER), '42501', /^platform_owner_protected$/);
    assert.deepEqual(await rows(), seeded, 'nothing deleted by a refused call');

    // Right people can: a member of the target's tenant (stored role viewer; the target's is owner). Before the
    // reset the target's enrollment start is refused (verified_enrollment_exists); after it the row is gone and
    // the enrollment start inserts a fresh, unverified row.
    await as(api, TARGET_A);
    await raises(() => api.query(ENROLL, [TARGET_A, Buffer.from([0x11]), Buffer.from([0x12]), 'financial-totp-v1']), 'P0001', /^verified_enrollment_exists$/);
    await as(api, ADMIN_A);
    assert.deepEqual(await resetAs(api, ADMIN_A, TARGET_A), { cleared: true });
    assert.deepEqual((await rows()).map((row) => row.application_user_id), seeded.map((row) => row.application_user_id).filter((id) => id !== TARGET_A));
    // Idempotent: no row left, cleared false, no error.
    assert.deepEqual(await resetAs(api, ADMIN_A, TARGET_A), { cleared: false });
    assert.deepEqual(await resetAs(api, ADMIN_A, OTHER_A), { cleared: false }, 'a teammate who never enrolled');
    await as(api, TARGET_A);
    await api.query(ENROLL, [TARGET_A, Buffer.from([0x11]), Buffer.from([0x12]), 'financial-totp-v1']);
    const fresh = (await su.query('SELECT verified_at, last_used_timestep, failed_attempts, locked_until FROM public.financial_totp_enrollments WHERE application_user_id = $1', [TARGET_A])).rows[0];
    assert.deepEqual(fresh, { verified_at: null, last_used_timestep: null, failed_attempts: 0, locked_until: null }, 'the next enrollment starts clean');
    // The owner login can execute it too (the other direction: the owner-role teammate resets the viewer).
    await as(owner, TARGET_A);
    assert.deepEqual(await resetAs(owner, TARGET_A, ADMIN_A), { cleared: true });
    // The other tenant's row and the platform owner's rows are untouched.
    assert.deepEqual((await rows()).map((row) => row.application_user_id).sort(), [MEMBER_B, PLATFORM_OWNER, PROFILE_OWNER, TARGET_A].sort());

    // Running the file again changes nothing.
    await owner.query(SQL133);
    assert.deepEqual((await su.query(CATALOG)).rows[0], after);
    assert.deepEqual((await su.query(RESET_FN)).rows[0], fnAfter);
    t.diagnostic(`SQL 133: ${newFunction} ACL ${fnAfter.acl.join(', ')}`);
  } finally {
    for (const c of clients) await c.end().catch(() => {});
    server.stop();
  }
});
