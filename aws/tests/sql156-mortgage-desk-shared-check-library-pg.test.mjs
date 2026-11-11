/**
 * SQL 156 (aws/workflows/sql/156_mortgage_desk_shared_check_library_documents.sql) on PostgreSQL 16: the Mortgage
 * Desk sees the auto-shared library documents of every tenant on a request's check (owner 2026-11-11: "It should be
 * everybody shared on that check"). Every object is owned by the non-superuser checksops_admin login (production's
 * admin login, which applies the file); the functions are called as checksops, the API login, with
 * request.app_user_id set as withIdentity sets it. auth.uid(), aws_is_authenticated() and aws_is_mortgage_ops_agent()
 * are main's own text; has_role() and is_platform_owner() are stubs on test tables.
 *
 * Proves: the file refuses without its prerequisites and from a login that does not own the tables it reads; it
 * installs two SECURITY DEFINER functions (EXECUTE checksops and the owner only); the list returns the requesting
 * tenant's and every unrevoked partner's auto-shared library:mortgage:% documents (requesting tenant first), never a
 * revoked partner's, an unrelated tenant's, a document not auto-shared or another library category; a partner who
 * turns auto-share on later appears and a revoked share disappears; it answers a mortgage agent on an open request
 * (requested or in progress) or one assigned to them and the platform owner, and refuses a tenant member, another agent
 * once the request is completed, and an unknown request; the path check follows the same rule; a re-run changes nothing.
 *
 * Run: node --test aws/tests/sql156-mortgage-desk-shared-check-library-pg.test.mjs (needs PostgreSQL 16; as root the
 * PG helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const SQL156 = path.join(AWS_ROOT, 'workflows/sql/156_mortgage_desk_shared_check_library_documents.sql');

const T_OWNER = '11111111-1111-4111-8111-111111111111';
const T_PARTNER = '22222222-2222-4222-8222-222222222222';
const T_REVOKED = '33333333-3333-4333-8333-333333333333';
const T_OTHER = '44444444-4444-4444-8444-444444444444';
const CHECK = 'c1560000-0000-4000-8000-000000000001';
const REQ = 'r1560000-0000-4000-8000-000000000001'.replace('r', 'd');
const AGENT_X = 'a1560000-0000-4000-8000-000000000001';
const AGENT_Y = 'a1560000-0000-4000-8000-000000000002';
const MEMBER = 'a1560000-0000-4000-8000-000000000003';
const OWNER = 'a1560000-0000-4000-8000-000000000004';
const LIST = 'public.aws_mortgage_desk_shared_library_documents(uuid)';
const PATH_FN = 'public.aws_mortgage_agent_can_read_shared_library_path(text[], text, uuid)';

const AUTH_UID = sliceFrom('aws/identity/sql/02_auth_uid_guc.sql', 'CREATE OR REPLACE FUNCTION auth.uid()', '$$;');
const AWS_IS_AUTHENTICATED = sliceFrom('aws/rls/sql/20_write_helpers.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_authenticated()', '$$;');
const AWS_IS_AGENT = sliceFrom('aws/workflows/sql/100_mortgage_desk_live_access.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent()', '$$;');

const ROLES = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE other_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
${AUTH_UID}
GRANT USAGE ON SCHEMA auth TO checksops_admin, other_admin, checksops, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO checksops_admin, other_admin, checksops, authenticated;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin, other_admin;
GRANT USAGE ON SCHEMA public TO checksops, authenticated;
`;

const SCHEMA = `
SET ROLE checksops_admin;
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.platform_owners (user_id uuid PRIMARY KEY);
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.tenant_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL DEFAULT 'member');
CREATE TABLE public.tenant_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  doc_type text NOT NULL, file_path text NOT NULL, file_name text NOT NULL, mime_type text, file_size bigint,
  auto_share_mortgage_ops boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.shared_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, source_tenant_id uuid NOT NULL,
  target_tenant_id uuid NOT NULL, revoked_at timestamptz);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, status text NOT NULL DEFAULT 'requested',
  assigned_employee_id uuid);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role) $$;
CREATE FUNCTION public.is_platform_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_owners WHERE user_id = auth.uid()) $$;
${AWS_IS_AUTHENTICATED}
${AWS_IS_AGENT}
INSERT INTO public.tenants VALUES ('${T_OWNER}', 'Owner Co'), ('${T_PARTNER}', 'Partner Co'), ('${T_REVOKED}', 'Revoked Co'), ('${T_OTHER}', 'Other Co');
INSERT INTO public.tenant_users (tenant_id, user_id) VALUES ('${T_OWNER}', '${MEMBER}');
INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT_X}', 'mortgage_agent'), ('${AGENT_Y}', 'mortgage_agent');
INSERT INTO public.platform_owners VALUES ('${OWNER}');
INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name, auto_share_mortgage_ops, created_at) VALUES
  ('${T_OWNER}', 'library:mortgage:w9', '${T_OWNER}/w9.pdf', 'w9.pdf', true, '2026-11-01'),
  ('${T_OWNER}', 'library:mortgage:coi', '${T_OWNER}/coi.pdf', 'coi.pdf', false, '2026-11-01'),
  ('${T_OWNER}', 'library:template:estimate', '${T_OWNER}/tpl.pdf', 'tpl.pdf', true, '2026-11-01'),
  ('${T_PARTNER}', 'library:mortgage:contractor_license', '${T_PARTNER}/license.pdf', 'license.pdf', true, '2026-11-02'),
  ('${T_PARTNER}', 'library:mortgage:w9', '${T_PARTNER}/w9.pdf', 'w9.pdf', false, '2026-11-02'),
  ('${T_REVOKED}', 'library:mortgage:w9', '${T_REVOKED}/w9.pdf', 'w9.pdf', true, '2026-11-03'),
  ('${T_OTHER}', 'library:mortgage:w9', '${T_OTHER}/w9.pdf', 'w9.pdf', true, '2026-11-03');
INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, revoked_at) VALUES
  ('${CHECK}', '${T_OWNER}', '${T_PARTNER}', NULL),
  ('${CHECK}', '${T_OWNER}', '${T_REVOKED}', '2026-11-05'),
  ('c1560000-0000-4000-8000-000000000099', '${T_OTHER}', '${T_OWNER}', NULL);
INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id) VALUES ('${REQ}', '${T_OWNER}', '${CHECK}');
RESET ROLE;
`;

test('SQL 156: the Desk lists and opens the auto-shared library documents of every tenant on the check, for the agents who may work the request (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('sql156-', 54950);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  const clients = [admin];
  try {
    await admin.query(ROLES);
    const fileText = fs.readFileSync(SQL156, 'utf8');
    const owner = await connect('checksops_admin');
    clients.push(owner);

    // Without its prerequisites the file refuses and installs nothing.
    await assert.rejects(owner.query(fileText), /sql156_prerequisite_missing: public\.mortgage_handling_requests\.tenant_id/);
    await admin.query(SCHEMA);
    // A login that does not own the tables cannot install the DEFINERs (row_security off would refuse).
    const other = await connect('other_admin');
    clients.push(other);
    await assert.rejects(other.query(fileText), /sql156_definer_cannot_read: public\.mortgage_handling_requests/);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'aws_mortgage%shared_library%'`)).rows[0].n, 0);

    await owner.query(fileText);
    const fns = async () => (await admin.query(`
      SELECT p.proname, p.oid, r.rolname AS owner, p.prosecdef, p.provolatile, p.proconfig, p.prosrc,
             ARRAY(SELECT coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type
                     FROM aclexplode(p.proacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee ORDER BY 1) AS acl
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('aws_mortgage_desk_shared_library_documents', 'aws_mortgage_agent_can_read_shared_library_path')
      ORDER BY p.proname`)).rows;
    const first = await fns();
    assert.deepEqual(first.map((f) => [f.proname, f.owner, f.prosecdef, f.provolatile, f.proconfig, f.acl]), [
      ['aws_mortgage_agent_can_read_shared_library_path', 'checksops_admin', true, 's', ['search_path=public', 'row_security=off'], ['checksops EXECUTE', 'checksops_admin EXECUTE']],
      ['aws_mortgage_desk_shared_library_documents', 'checksops_admin', true, 's', ['search_path=public', 'row_security=off'], ['checksops EXECUTE', 'checksops_admin EXECUTE']],
    ]);
    // Re-runnable: replaced in place with the same text.
    await owner.query(fileText);
    assert.deepEqual((await fns()).map((f) => [f.oid, f.prosrc, f.acl]), first.map((f) => [f.oid, f.prosrc, f.acl]));
    // Nothing else changed: no trigger, no policy.
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`)).rows[0].n, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_policy`)).rows[0].n, 0);

    const api = await connect('checksops');
    clients.push(api);
    const as = async (user, sql, params) => {
      await api.query('BEGIN');
      try {
        await api.query(`SELECT set_config('request.app_user_id', $1, true)`, [user ?? '']);
        const res = await api.query(sql, params);
        await api.query('COMMIT');
        return res.rows;
      } catch (error) {
        await api.query('ROLLBACK');
        throw error;
      }
    };
    const list = (user) => as(user, `SELECT tenant_name, requesting_tenant, doc_type, file_path FROM ${LIST.replace('(uuid)', '($1::uuid)')}`, [REQ]);
    const canRead = async (user, rel, asUser = user) => (await as(user,
      `SELECT ${PATH_FN.replace('(text[], text, uuid)', '($1::text[], $2::text, $3::uuid)')} AS ok`, [[rel], rel, asUser]))[0].ok;
    const denied = (e) => e.code === '42501' && /not_authorized/.test(e.message);

    // Open request: the requesting tenant first, then the unrevoked partner; nothing else.
    const expected = [
      { tenant_name: 'Owner Co', requesting_tenant: true, doc_type: 'library:mortgage:w9', file_path: `${T_OWNER}/w9.pdf` },
      { tenant_name: 'Partner Co', requesting_tenant: false, doc_type: 'library:mortgage:contractor_license', file_path: `${T_PARTNER}/license.pdf` },
    ];
    assert.deepEqual(await list(AGENT_X), expected);
    assert.deepEqual(await list(OWNER), expected);
    await assert.rejects(list(MEMBER), denied, 'member');
    await assert.rejects(list(null), denied, 'no user');
    await assert.rejects(as(AGENT_X, `SELECT * FROM public.aws_mortgage_desk_shared_library_documents('d1560000-0000-4000-8000-0000000000ff'::uuid)`), denied, 'unknown request');

    // The path check follows the list.
    assert.equal(await canRead(AGENT_X, `${T_PARTNER}/license.pdf`), true);
    assert.equal(await canRead(AGENT_X, `${T_OWNER}/w9.pdf`), true);
    for (const rel of [`${T_REVOKED}/w9.pdf`, `${T_OTHER}/w9.pdf`, `${T_PARTNER}/w9.pdf`, `${T_OWNER}/tpl.pdf`, `${T_OWNER}/coi.pdf`, '']) {
      assert.equal(await canRead(AGENT_X, rel), false, rel);
    }
    assert.equal(await canRead(AGENT_X, `${T_PARTNER}/license.pdf`, AGENT_Y), false, 'another user id');
    assert.equal(await canRead(MEMBER, `${T_PARTNER}/license.pdf`), false, 'not a mortgage agent');

    // Live: a partner who turns auto-share on later appears; a revoked share disappears.
    await admin.query(`UPDATE public.tenant_documents SET auto_share_mortgage_ops = true WHERE file_path = '${T_PARTNER}/w9.pdf'`);
    assert.deepEqual((await list(AGENT_X)).map((r) => r.file_path), [`${T_OWNER}/w9.pdf`, `${T_PARTNER}/license.pdf`, `${T_PARTNER}/w9.pdf`]);
    await admin.query(`UPDATE public.shared_checks SET revoked_at = now() WHERE target_tenant_id = '${T_PARTNER}'`);
    assert.deepEqual((await list(AGENT_X)).map((r) => r.file_path), [`${T_OWNER}/w9.pdf`]);
    assert.equal(await canRead(AGENT_X, `${T_PARTNER}/license.pdf`), false);
    await admin.query(`UPDATE public.shared_checks SET revoked_at = NULL WHERE target_tenant_id = '${T_PARTNER}'`);

    // Taken by agent Y: while in progress it is still open, so every agent sees it (the rule
    // aws_mortgage_agent_can_read_library_path already uses); once completed only Y (and the owner) does.
    await admin.query(`UPDATE public.mortgage_handling_requests SET status = 'in_progress', assigned_employee_id = '${AGENT_Y}'`);
    assert.equal((await list(AGENT_X)).length, 3);
    assert.equal((await list(AGENT_Y)).length, 3);
    assert.equal(await canRead(AGENT_Y, `${T_PARTNER}/license.pdf`), true);
    await admin.query(`UPDATE public.mortgage_handling_requests SET status = 'completed'`);
    await assert.rejects(list(AGENT_X), denied, 'completed by Y');
    assert.equal(await canRead(AGENT_X, `${T_PARTNER}/license.pdf`), false);
    assert.equal((await list(AGENT_Y)).length, 3);
    assert.equal(await canRead(AGENT_Y, `${T_PARTNER}/license.pdf`), true);
    assert.equal((await list(OWNER)).length, 3);
    // A request with no check lists its own tenant's documents only.
    await admin.query(`UPDATE public.mortgage_handling_requests SET check_intake_item_id = NULL`);
    assert.deepEqual((await list(AGENT_Y)).map((r) => r.file_path), [`${T_OWNER}/w9.pdf`]);

    // Not callable by authenticated or PUBLIC.
    const privs = (await admin.query(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS a, has_function_privilege('authenticated', $2, 'EXECUTE') AS b`, [LIST, PATH_FN])).rows[0];
    assert.deepEqual(privs, { a: false, b: false });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    server.stop();
  }
});
