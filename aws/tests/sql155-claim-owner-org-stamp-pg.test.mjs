/**
 * SQL 155 (aws/workflows/sql/155_claim_owner_org_stamp.sql) on PostgreSQL 16: the claim owner stamp production already
 * runs (claims.trg_aws_stamp_claim_org_id, applied there directly on 2026-09-22 from the unmerged PR #429), adopted as
 * a numbered migration. Every object is owned by the non-superuser checksops_admin login (production's admin login,
 * which applies the file); claims are written as checksops, the API login, with request.app_user_id set as withIdentity
 * sets it. auth.uid() and aws_is_cross_tenant_reader() are main's own text; is_platform_owner() / is_master_owner() are
 * stubs on a test table (main's read identity_accounts / profiles by mailbox).
 *
 * Proves: the file refuses without its prerequisites and from a login that does not own tenants / tenant_users;
 * it installs both DEFINER functions (STABLE / VOLATILE, search_path public, row_security off, EXECUTE checksops,
 * authenticated and the owner, nothing for PUBLIC) and the BEFORE INSERT OR UPDATE row trigger; a re-run changes
 * nothing (same oids, same text); a one-tenant member's claim is stamped with that tenant whatever org_id the client
 * sends; a member of two tenants must name one by a slug they belong to (a UUID slug, another tenant's slug or none is
 * 22023 claim_owner_tenant_required); an UPDATE cannot move a claim to another tenant; a write with no signed-in user
 * needs an explicit org_id (23502 claim_org_id_required); a signed-in user with no membership cannot pick an owner
 * (42501) unless they are a cross-tenant reader.
 *
 * Run: node --test aws/tests/sql155-claim-owner-org-stamp-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers run
 * the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const SQL155 = path.join(AWS_ROOT, 'workflows/sql/155_claim_owner_org_stamp.sql');

const T_FREEDOM = '11111111-1111-4111-8111-111111111111';
const T_C1C = '33333333-3333-4333-8333-333333333333';
const ONLY_FREEDOM = 'a1550000-0000-4000-8000-000000000001';
const BOTH = 'a1550000-0000-4000-8000-000000000002';
const NOBODY = 'a1550000-0000-4000-8000-000000000003';
const OWNER = 'a1550000-0000-4000-8000-000000000004';

const AUTH_UID = sliceFrom('aws/identity/sql/02_auth_uid_guc.sql', 'CREATE OR REPLACE FUNCTION auth.uid()', '$$;');
const CROSS_TENANT_READER = sliceFrom('aws/rls/sql/02_helpers.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_cross_tenant_reader()', '$$;');

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
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text, slug text UNIQUE);
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
  UNIQUE (tenant_id, user_id));
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_number text, status text, org_id uuid);
CREATE TABLE public.platform_owners (user_id uuid PRIMARY KEY);
CREATE FUNCTION public.is_platform_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_owners WHERE user_id = auth.uid()) $$;
CREATE FUNCTION public.is_master_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_platform_owner() $$;
GRANT INSERT, UPDATE, SELECT ON public.claims TO checksops;
INSERT INTO public.tenants VALUES ('${T_FREEDOM}', 'Freedom', 'freedom'), ('${T_C1C}', 'C1C', 'c1c');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${T_FREEDOM}', '${ONLY_FREEDOM}', 'admin'), ('${T_FREEDOM}', '${BOTH}', 'admin'), ('${T_C1C}', '${BOTH}', 'staff');
INSERT INTO public.platform_owners VALUES ('${OWNER}');
RESET ROLE;
`;

test('SQL 155: the claim owner stamp is installed as production runs it, re-runnable, and stamps claims.org_id from the signed-in membership (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('sql155-', 54850);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  const clients = [admin];
  try {
    await admin.query(ROLES);
    const fileText = fs.readFileSync(SQL155, 'utf8');
    const owner = await connect('checksops_admin');
    clients.push(owner);

    // Without its prerequisites the file refuses and installs nothing.
    await assert.rejects(owner.query(fileText), /sql155_prerequisite_missing: public\.claims\.org_id, public\.tenants\.slug, public\.tenant_users\(tenant_id, user_id\), public\.aws_is_cross_tenant_reader\(\)/);
    await admin.query(SCHEMA);
    await admin.query(`SET ROLE checksops_admin; ${CROSS_TENANT_READER} RESET ROLE;`);

    // A login that does not own tenants / tenant_users cannot install the DEFINERs (row_security off would refuse).
    const other = await connect('other_admin');
    clients.push(other);
    await assert.rejects(other.query(fileText), /sql155_definer_cannot_read: public\.tenants/);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('aws_claim_owner_tenant_id', 'aws_stamp_claim_org_id')`)).rows[0].n, 0);

    await owner.query(fileText);
    const fns = async () => (await admin.query(`
      SELECT p.proname, p.oid, r.rolname AS owner, p.prosecdef, p.provolatile, p.proconfig, p.prosrc,
             pg_get_function_result(p.oid) AS result,
             ARRAY(SELECT coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type
                     FROM aclexplode(p.proacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee ORDER BY 1) AS acl
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('aws_claim_owner_tenant_id', 'aws_stamp_claim_org_id')
      ORDER BY p.proname`)).rows;
    const first = await fns();
    assert.deepEqual(first.map((f) => [f.proname, f.owner, f.prosecdef, f.provolatile, f.proconfig, f.result, f.acl]), [
      ['aws_claim_owner_tenant_id', 'checksops_admin', true, 's', ['search_path=public', 'row_security=off'], 'uuid',
        ['authenticated EXECUTE', 'checksops EXECUTE', 'checksops_admin EXECUTE']],
      ['aws_stamp_claim_org_id', 'checksops_admin', true, 'v', ['search_path=public', 'row_security=off'], 'trigger',
        ['authenticated EXECUTE', 'checksops EXECUTE', 'checksops_admin EXECUTE']],
    ]);
    const trigger = async () => (await admin.query(`
      SELECT t.oid, t.tgenabled, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
      WHERE t.tgrelid = 'public.claims'::regclass AND NOT t.tgisinternal`)).rows;
    const trig = await trigger();
    assert.equal(trig.length, 1);
    assert.equal(trig[0].tgenabled, 'O');
    assert.equal(trig[0].def, 'CREATE TRIGGER trg_aws_stamp_claim_org_id BEFORE INSERT OR UPDATE ON public.claims FOR EACH ROW EXECUTE FUNCTION aws_stamp_claim_org_id()');

    // Re-runnable: the functions are replaced in place with the same text; the trigger is recreated the same.
    await owner.query(fileText);
    const again = await fns();
    assert.deepEqual(again.map((f) => [f.oid, f.prosrc, f.acl]), first.map((f) => [f.oid, f.prosrc, f.acl]));
    assert.deepEqual((await trigger()).map((t) => [t.tgenabled, t.def]), trig.map((t) => [t.tgenabled, t.def]));

    // Claims written as the API login, signed in as withIdentity signs in.
    const api = await connect('checksops');
    clients.push(api);
    const as = async (user, slug, sql, params) => {
      await api.query('BEGIN');
      try {
        await api.query(`SELECT set_config('request.app_user_id', $1, true), set_config('request.active_tenant_slug', $2, true)`, [user ?? '', slug ?? '']);
        const res = await api.query(sql, params);
        await api.query('COMMIT');
        return res.rows;
      } catch (error) {
        await api.query('ROLLBACK');
        throw error;
      }
    };
    const insert = (user, slug, orgId) => as(user, slug, `INSERT INTO public.claims (claim_number, status, org_id) VALUES ('C', 'open', $1) RETURNING id, org_id`, [orgId]);

    // One membership: stamped with that tenant whatever the client sends.
    assert.equal((await insert(ONLY_FREEDOM, null, T_C1C))[0].org_id, T_FREEDOM);
    assert.equal((await insert(ONLY_FREEDOM, null, null))[0].org_id, T_FREEDOM);
    // Another tenant's slug is ignored for a one-tenant member.
    assert.equal((await insert(ONLY_FREEDOM, 'c1c', T_C1C))[0].org_id, T_FREEDOM);

    // Two memberships: the slug picks one they belong to; anything else is refused.
    assert.equal((await insert(BOTH, 'c1c', T_FREEDOM))[0].org_id, T_C1C);
    assert.equal((await insert(BOTH, 'FREEDOM', null))[0].org_id, T_FREEDOM);
    for (const slug of [null, T_C1C, 'not-a-member', 'bad slug!']) {
      await assert.rejects(insert(BOTH, slug, T_C1C), (e) => e.code === '22023' && /claim_owner_tenant_required/.test(e.message), String(slug));
    }

    // UPDATE cannot move a claim to another tenant.
    const [claim] = await insert(ONLY_FREEDOM, null, null);
    const [moved] = await as(BOTH, 'c1c', `UPDATE public.claims SET org_id = $2, claim_number = 'C2' WHERE id = $1 RETURNING org_id, claim_number`, [claim.id, T_C1C]);
    assert.deepEqual(moved, { org_id: T_FREEDOM, claim_number: 'C2' });

    // No signed-in user (an admin or server write): org_id must be given.
    await assert.rejects(insert(null, null, null), (e) => e.code === '23502' && /claim_org_id_required/.test(e.message));
    assert.equal((await insert(null, null, T_C1C))[0].org_id, T_C1C);
    // A legacy claim with no owner gets one on its next UPDATE by a member.
    await admin.query(`ALTER TABLE public.claims DISABLE TRIGGER trg_aws_stamp_claim_org_id`);
    const [orphan] = (await admin.query(`INSERT INTO public.claims (claim_number) VALUES ('legacy') RETURNING id`)).rows;
    await admin.query(`ALTER TABLE public.claims ENABLE TRIGGER trg_aws_stamp_claim_org_id`);
    assert.equal((await as(ONLY_FREEDOM, null, `UPDATE public.claims SET status = 'open' WHERE id = $1 RETURNING org_id`, [orphan.id]))[0].org_id, T_FREEDOM);

    // A signed-in user with no membership cannot name an owner, unless they are a cross-tenant reader.
    await assert.rejects(insert(NOBODY, null, T_FREEDOM), (e) => e.code === '42501' && /claim_owner_tenant_required/.test(e.message));
    await assert.rejects(insert(NOBODY, null, null), (e) => e.code === '23502');
    assert.equal((await insert(OWNER, null, T_C1C))[0].org_id, T_C1C);
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    server.stop();
  }
});
