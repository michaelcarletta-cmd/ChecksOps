/**
 * SQL 148 (aws/workflows/sql/148_second_mortgagee_link.sql) on PostgreSQL 16, called through the API's own code
 * (aws/functions/api/workflow-rpc.mjs executeSafeWriteRpc, RPC link_second_mortgagee) as checksops, the API login,
 * with request.app_user_id set as withIdentity sets it. Every object is owned by the non-superuser checksops_admin
 * login (production's admin login, which applies the file). checksops holds SELECT and INSERT on
 * public.mortgage_handling_requests and no UPDATE on the order columns (SQL 100's live grants do not name them), so
 * the link is written by the DEFINER alone.
 *
 * The per-check unique index is the Supabase one, verbatim (supabase/migrations/20260715110727...); SQL 90's
 * membership helpers are verbatim. The table carries the columns SQL 148 and the Send to Mortgage Desk insert name.
 *
 * Proves: before SQL 148 the 2nd mortgagee's INSERT is refused while the 1st is open (the unique index); after it the
 * 2nd is accepted, a 3rd open request for either place is still refused; the link marks the 1st 1 of 2 and the 2nd 2 of
 * 2 with the 1st as predecessor, is idempotent, and fills in a 2nd request inserted without order columns; another
 * tenant's member, a missing user, requests of different checks, a cancelled request, a request already in 2nd place
 * and a 2nd place already taken are refused and change nothing; checksops cannot update the columns directly; only
 * checksops (and the owner) may execute the function; the file is re-runnable, refuses a login that does not own the
 * table, an unexpected index of that name, another per-check unique index and duplicate open requests when the index
 * is absent.
 *
 * Run: node --test aws/tests/sql148-second-mortgagee-link-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers
 * run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { SQL90_WRITE_HELPERS, sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const SQL148 = path.join(AWS_ROOT, 'workflows/sql/148_second_mortgagee_link.sql');

const T_A = '11111111-1111-4111-8111-111111111111';
const T_B = '33333333-3333-4333-8333-333333333333';
const MEMBER_A = 'a1000000-0000-4000-8000-000000000001';
const MEMBER_B = 'a1000000-0000-4000-8000-000000000009';
const CHECK = 'c1480000-0000-4000-8000-000000000001';
const CHECK_2 = 'c1480000-0000-4000-8000-000000000002';
const CHECK_B = 'c1480000-0000-4000-8000-000000000003';
const FIRST = 'e1480000-0000-4000-8000-000000000001';
const OTHER_CHECK_REQ = 'e1480000-0000-4000-8000-000000000002';
const B_REQ = 'e1480000-0000-4000-8000-000000000003';
const CHECK_2_FIRST = 'e1480000-0000-4000-8000-000000000004';

const SUPABASE_TABLE = 'supabase/migrations/20260715110727_2bb7c7e2-f94a-476f-87fa-db5f47ccc030.sql';
const SUPABASE_INDEX = sliceFrom(SUPABASE_TABLE, 'CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check', ');');
const AUTH_UID = sliceFrom('aws/identity/sql/02_auth_uid_guc.sql', 'CREATE OR REPLACE FUNCTION auth.uid()', '$$;');
const AWS_IS_AUTHENTICATED = sliceFrom('aws/rls/sql/20_write_helpers.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_authenticated()', '$$;');

const NEW_INDEX_DEF = "CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check ON public.mortgage_handling_requests USING btree (check_intake_item_id, COALESCE(endorsement_order, 1)) WHERE (status = ANY (ARRAY['requested'::text, 'in_progress'::text]))";
const OLD_INDEX_DEF = "CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check ON public.mortgage_handling_requests USING btree (check_intake_item_id) WHERE (status = ANY (ARRAY['requested'::text, 'in_progress'::text]))";

const ROLES = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE other_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE plain LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
GRANT authenticated TO checksops;
`;

const schema = ({ withIndex = true } = {}) => `
CREATE SCHEMA auth;
${AUTH_UID}
GRANT USAGE ON SCHEMA auth TO checksops_admin, other_admin, checksops, authenticated, plain;
GRANT EXECUTE ON FUNCTION auth.uid() TO checksops_admin, checksops, authenticated;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin, other_admin;
GRANT USAGE ON SCHEMA public TO checksops, authenticated, plain;
SET ROLE checksops_admin;
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
  UNIQUE (tenant_id, user_id));
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  mortgage_company text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','in_progress','completed','cancelled')),
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS endorsement_order integer,
  ADD COLUMN IF NOT EXISTS predecessor_request_id uuid REFERENCES public.mortgage_handling_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS total_mortgagees integer;
${withIndex ? SUPABASE_INDEX : ''}
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER mortgage_handling_requests_set_updated_at
  BEFORE UPDATE ON public.mortgage_handling_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
${AWS_IS_AUTHENTICATED}
${SQL90_WRITE_HELPERS}
ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.tenant_users, public.check_intake_items TO checksops, authenticated;
-- SQL 100's live grants: no UPDATE on endorsement_order, total_mortgagees or predecessor_request_id.
GRANT SELECT, INSERT, DELETE ON TABLE public.mortgage_handling_requests TO checksops;
GRANT UPDATE (status, mortgage_company, updated_at) ON TABLE public.mortgage_handling_requests TO checksops;
CREATE POLICY member_read ON public.mortgage_handling_requests FOR SELECT TO authenticated USING (public.aws_can_write_tenant(tenant_id));
CREATE POLICY member_insert ON public.mortgage_handling_requests FOR INSERT TO authenticated
  WITH CHECK (public.aws_can_write_tenant(tenant_id) AND status = 'requested');
INSERT INTO public.tenants VALUES ('${T_A}', 'A'), ('${T_B}', 'B');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${T_A}', '${MEMBER_A}', 'admin'), ('${T_B}', '${MEMBER_B}', 'admin');
INSERT INTO public.check_intake_items VALUES ('${CHECK}', '${T_A}'), ('${CHECK_2}', '${T_A}'), ('${CHECK_B}', '${T_B}');
RESET ROLE;
`;

test('SQL 148: a 2nd mortgagee can be sent while the 1st is open, and the two requests are linked 1 of 2 / 2 of 2 (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('sql148-', 54800);
  const connect = async (user, database = 'postgres') => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  const clients = [admin];
  try {
    await admin.query(ROLES);
    await admin.query(schema());
    const owner = await connect('checksops_admin');
    clients.push(owner);
    const fileText = fs.readFileSync(SQL148, 'utf8');
    const indexDef = async (c = admin) => (await c.query(`SELECT pg_get_indexdef('public.mortgage_handling_requests_one_open_per_check'::regclass) AS d`)).rows[0].d;
    assert.equal(await indexDef(), OLD_INDEX_DEF, 'the Supabase index renders as SQL 148 expects it');

    const api = await connect('checksops');
    clients.push(api);
    /** One API request as the verified sign-in, in its own transaction (withIdentity commits only an ok answer). */
    const asUser = async (user, fn) => {
      await api.query('BEGIN');
      if (user) await api.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
      try {
        const result = await fn();
        await api.query(result?.error ? 'ROLLBACK' : 'COMMIT');
        return result;
      } catch (error) {
        await api.query('ROLLBACK');
        throw error;
      }
    };
    const insert = (values, user = MEMBER_A) => asUser(user, async () => {
      const cols = Object.keys(values);
      const rows = (await api.query(
        `INSERT INTO public.mortgage_handling_requests (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((c) => values[c]),
      )).rows;
      return { id: rows[0].id };
    });
    const link = (user, first, second) => asUser(user, () => executeSafeWriteRpc({
      client: api, mapping: { application_user_id: user }, name: 'link_second_mortgagee',
      args: { p_first_request_id: first, p_second_request_id: second },
    }));
    const row = async (id) => (await admin.query(
      'SELECT endorsement_order, total_mortgagees, predecessor_request_id, status FROM public.mortgage_handling_requests WHERE id = $1', [id])).rows[0];
    const snapshot = async () => (await admin.query(
      'SELECT id, endorsement_order, total_mortgagees, predecessor_request_id, status, updated_at FROM public.mortgage_handling_requests ORDER BY id')).rows;

    // The 1st request, as Send to Mortgage Desk inserts it (no order).
    await insert({ id: FIRST, tenant_id: T_A, check_intake_item_id: CHECK, mortgage_company: 'First Bank' });
    await insert({ id: CHECK_2_FIRST, tenant_id: T_A, check_intake_item_id: CHECK_2, mortgage_company: 'Other Bank' });
    await insert({ id: B_REQ, tenant_id: T_B, check_intake_item_id: CHECK_B, mortgage_company: 'B Bank' }, MEMBER_B);

    // Before SQL 148: the 2nd mortgagee is refused while the 1st is open, and the link function does not exist.
    const secondValues = { tenant_id: T_A, check_intake_item_id: CHECK, mortgage_company: 'Second Bank', endorsement_order: 2, total_mortgagees: 2, predecessor_request_id: FIRST };
    await assert.rejects(insert(secondValues), (error) => error.code === '23505' && /mortgage_handling_requests_one_open_per_check/.test(error.message));
    const missing = await link(MEMBER_A, FIRST, CHECK_2_FIRST);
    assert.equal(missing.error, 'mortgagee_link_unavailable');
    assert.equal(missing.statusCode, 503);

    // Tenants cannot write the order columns directly (no UPDATE grant on them, SQL 100).
    await assert.rejects(
      asUser(MEMBER_A, () => api.query('UPDATE public.mortgage_handling_requests SET endorsement_order = 1, total_mortgagees = 2 WHERE id = $1', [FIRST])),
      /permission denied for table mortgage_handling_requests/,
    );

    // A login that does not own the table cannot install it.
    const other = await connect('other_admin');
    clients.push(other);
    await assert.rejects(other.query(fileText), /sql148_definer_cannot_write/);

    await owner.query(fileText);
    assert.equal(await indexDef(), NEW_INDEX_DEF);
    await owner.query(fileText); // re-runnable
    assert.equal(await indexDef(), NEW_INDEX_DEF);

    // After SQL 148: the 2nd mortgagee is accepted while the 1st is open.
    const second = (await insert(secondValues)).id;
    // Check 2's own pair (its 2nd in 2nd place).
    await insert({ id: OTHER_CHECK_REQ, tenant_id: T_A, check_intake_item_id: CHECK_2, mortgage_company: 'Second on check 2', endorsement_order: 2, total_mortgagees: 2, predecessor_request_id: CHECK_2_FIRST });
    // Still one open request per place: a plain re-send (the 1st place) and another 2nd are refused.
    await assert.rejects(insert({ tenant_id: T_A, check_intake_item_id: CHECK, mortgage_company: 'Again' }), (error) => error.code === '23505');
    await assert.rejects(insert({ ...secondValues, mortgage_company: 'Third Bank' }), (error) => error.code === '23505');

    // The link: the 1st becomes 1 of 2; the 2nd already carries 2 of 2 and its predecessor.
    const linked = await link(MEMBER_A, FIRST, second);
    assert.equal(linked.error, undefined, JSON.stringify(linked));
    assert.deepEqual(linked.data, {
      first_request_id: FIRST, second_request_id: second, check_intake_item_id: CHECK, first_changed: true, second_changed: false,
    });
    assert.deepEqual(await row(FIRST), { endorsement_order: 1, total_mortgagees: 2, predecessor_request_id: null, status: 'requested' });
    assert.deepEqual(await row(second), { endorsement_order: 2, total_mortgagees: 2, predecessor_request_id: FIRST, status: 'requested' });
    // Idempotent: a repeat changes nothing.
    const stable = await snapshot();
    const again = await link(MEMBER_A, FIRST, second);
    assert.deepEqual(again.data, {
      first_request_id: FIRST, second_request_id: second, check_intake_item_id: CHECK, first_changed: false, second_changed: false,
    });
    assert.deepEqual(await snapshot(), stable);

    // Refusals change nothing.
    const refused = async (user, first, secondId, expect) => {
      const before = await snapshot();
      const result = await link(user, first, secondId);
      for (const [key, value] of Object.entries(expect)) assert.equal(result[key], value, `${key}: ${JSON.stringify(result)}`);
      assert.deepEqual(await snapshot(), before);
    };
    // Another tenant's member, on A's requests: the same answer as a request that does not exist.
    await refused(MEMBER_B, FIRST, second, { error: 'rls_denied' });
    await refused(MEMBER_B, B_REQ, second, { error: 'rls_denied' });
    await refused(MEMBER_A, FIRST, 'e1480000-0000-4000-8000-0000000000ff', { error: 'rls_denied' });
    // No verified user.
    await refused(null, FIRST, second, { error: 'mortgagee_link_forbidden' });
    // Requests of two different checks.
    await refused(MEMBER_A, FIRST, CHECK_2_FIRST, { error: 'invalid_field', message: 'Cannot link these requests: different check' });
    // The 2nd place of check 2 already belongs to another request; a request in 2nd place cannot be a 1st.
    await refused(MEMBER_A, OTHER_CHECK_REQ, CHECK_2_FIRST, { error: 'invalid_field', message: 'Cannot link these requests: first request order' });
    // Same request twice, malformed ids: refused before any SQL.
    await refused(MEMBER_A, FIRST, FIRST, { error: 'invalid_field' });
    await refused(MEMBER_A, 'not-a-uuid', second, { error: 'invalid_uuid' });

    // A cancelled request cannot be linked.
    await admin.query("UPDATE public.mortgage_handling_requests SET status = 'cancelled' WHERE id = $1", [second]);
    await refused(MEMBER_A, FIRST, second, { error: 'invalid_field', message: 'Cannot link these requests: cancelled request' });
    // The 2nd place is held by another request that is not cancelled (a completed 2nd): refused.
    const done = (await admin.query(`INSERT INTO public.mortgage_handling_requests
      (tenant_id, check_intake_item_id, mortgage_company, status, endorsement_order, total_mortgagees, predecessor_request_id)
      VALUES ($1, $2, 'Done Bank', 'completed', 2, 2, $3) RETURNING id`, [T_A, CHECK, FIRST])).rows[0].id;
    // A 2nd request inserted with its order only (no total, no predecessor) while the 1st is open.
    const partial = (await insert({ tenant_id: T_A, check_intake_item_id: CHECK, mortgage_company: 'Partial Second', endorsement_order: 2 })).id;
    await refused(MEMBER_A, FIRST, partial, { error: 'mortgagee_link_conflict', statusCode: 409 });
    await admin.query("UPDATE public.mortgage_handling_requests SET status = 'cancelled' WHERE id = $1", [done]);
    // The link fills in what the insert left out.
    const filled = await link(MEMBER_A, FIRST, partial);
    assert.deepEqual(filled.data, {
      first_request_id: FIRST, second_request_id: partial, check_intake_item_id: CHECK, first_changed: false, second_changed: true,
    });
    assert.deepEqual(await row(partial), { endorsement_order: 2, total_mortgagees: 2, predecessor_request_id: FIRST, status: 'requested' });
    // A 2nd inserted with no order at all takes the 1st place and is refused while the 1st is open: the order
    // columns must reach the INSERT (write-check-workflow.mjs since #1739).
    await assert.rejects(insert({ tenant_id: T_A, check_intake_item_id: CHECK, mortgage_company: 'No order' }), (error) => error.code === '23505');

    // Only checksops and the owner may execute the function.
    const plain = await connect('plain');
    clients.push(plain);
    await assert.rejects(
      plain.query('SELECT public.aws_link_second_mortgagee($1, $2)', [FIRST, partial]),
      /permission denied for function aws_link_second_mortgagee/,
    );
    const acl = (await admin.query(`SELECT r.rolname FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE p.oid = 'public.aws_link_second_mortgagee(uuid, uuid)'::regprocedure ORDER BY 1`)).rows.map((r) => r.rolname);
    assert.deepEqual(acl, ['checksops', 'checksops_admin']);
    const fn = (await admin.query(`SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p WHERE p.oid = 'public.aws_link_second_mortgagee(uuid, uuid)'::regprocedure`)).rows[0];
    assert.deepEqual(fn, { prosecdef: true, provolatile: 'v', proconfig: ['search_path=public, pg_temp'], owner: 'checksops_admin' });

    // The index gates, on a database without the Supabase index.
    await admin.query('CREATE DATABASE gates');
    const gatesAdmin = await connect('ubuntu', 'gates');
    clients.push(gatesAdmin);
    await gatesAdmin.query(schema({ withIndex: false }));
    const gatesOwner = await connect('checksops_admin', 'gates');
    clients.push(gatesOwner);
    // Duplicate open requests under the new key: refused, nothing created.
    await gatesAdmin.query(`INSERT INTO public.mortgage_handling_requests (tenant_id, check_intake_item_id, mortgage_company)
      VALUES ($1, $2, 'one'), ($1, $2, 'two')`, [T_A, CHECK]);
    await assert.rejects(gatesOwner.query(fileText), (error) => error.code === '23505' && /sql148_duplicate_open_requests: 1/.test(error.message));
    assert.equal(await gatesAdmin.query("SELECT 1 FROM pg_proc WHERE proname = 'aws_link_second_mortgagee'").then((r) => r.rowCount), 0);
    await gatesAdmin.query("UPDATE public.mortgage_handling_requests SET status = 'cancelled' WHERE mortgage_company = 'two'");
    // Another unique index keyed on the check alone would keep refusing the 2nd mortgagee.
    await gatesAdmin.query(`CREATE UNIQUE INDEX other_open_per_check ON public.mortgage_handling_requests (check_intake_item_id)
      WHERE status = 'requested'`);
    await assert.rejects(gatesOwner.query(fileText), /sql148_other_per_check_unique: other_open_per_check/);
    await gatesAdmin.query('DROP INDEX public.other_open_per_check');
    // An index of that name with another definition: refused.
    await gatesAdmin.query('CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check ON public.mortgage_handling_requests (id)');
    await assert.rejects(gatesOwner.query(fileText), /sql148_unexpected_index/);
    await gatesAdmin.query('DROP INDEX public.mortgage_handling_requests_one_open_per_check');
    // Absent: created with SQL 148's definition.
    await gatesOwner.query(fileText);
    assert.equal(await indexDef(gatesAdmin), NEW_INDEX_DEF);
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    server.stop();
  }
});
