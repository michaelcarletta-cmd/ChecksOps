/**
 * SQL 157 (aws/workflows/sql/157_mortgage_desk_oversight_and_agent_notes.sql) on PostgreSQL 16: Tenant Management (the
 * platform owner) sees every tenant's Mortgage Desk work by status with how long it has waited, assigns a queued request
 * to an agent (it starts, as the agent's accept does), and writes private notes to the assigned agent (owner 2026-11-12:
 * "Tenant management and the agent assigned can see the notes", "If no agent then tenant management can assign", "Note
 * is only visible to agent"). Every object is owned by the non-superuser checksops_admin login (production's admin
 * login, which applies the file); the functions are called as checksops, the API login, with request.app_user_id set
 * as withIdentity sets it. auth.uid(), aws_is_authenticated() and aws_is_mortgage_ops_agent() are main's own text;
 * has_role() and is_platform_owner() are stubs on test tables.
 *
 * Proves: the file refuses without its prerequisites and from a login that does not own the tables it reads; it adds
 * one table (RLS on, no policy, no grant) and six SECURITY DEFINER functions (EXECUTE checksops and the owner only);
 * a re-run changes nothing; the overview orders queued oldest first, then in progress, then completed newest first,
 * with seconds in status, turnaround, note counts and the total, for the platform owner only; assigning starts a queued
 * request for an active agent with an audit row and refuses a taken request, an inactive agent or a non-agent; notes go
 * only to the assigned agent, are read only by the platform owner and that agent (not another agent, not a tenant
 * member), never touch check_messages, are rate limited, and record their email outcome once.
 *
 * Run: node --test aws/tests/sql157-mortgage-desk-oversight-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers
 * run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const SQL157 = path.join(AWS_ROOT, 'workflows/sql/157_mortgage_desk_oversight_and_agent_notes.sql');

const T_A = '11111111-1111-4111-8111-111111111111';
const T_B = '22222222-2222-4222-8222-222222222222';
const REQ_Q1 = 'd1570000-0000-4000-8000-000000000001';
const REQ_Q2 = 'd1570000-0000-4000-8000-000000000002';
const REQ_P = 'd1570000-0000-4000-8000-000000000003';
const REQ_C = 'd1570000-0000-4000-8000-000000000004';
const REQ_X = 'd1570000-0000-4000-8000-000000000005';
const AGENT_X = 'a1570000-0000-4000-8000-000000000001';
const AGENT_Y = 'a1570000-0000-4000-8000-000000000002';
const AGENT_OFF = 'a1570000-0000-4000-8000-000000000003';
const MEMBER = 'a1570000-0000-4000-8000-000000000004';
const OWNER = 'a1570000-0000-4000-8000-000000000005';
const FUNCTIONS = [
  'aws_mortgage_desk_add_agent_note',
  'aws_mortgage_desk_agent_notes',
  'aws_mortgage_desk_assign_agent',
  'aws_mortgage_desk_assignable_agents',
  'aws_mortgage_desk_overview',
  'aws_mortgage_desk_record_agent_note_email',
];

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
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text NOT NULL, full_name text);
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text);
CREATE TABLE public.mortgage_agent_accounts (application_user_id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')));
CREATE TABLE public.check_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, sender_id uuid NOT NULL, body text NOT NULL);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'in_progress', 'completed', 'cancelled')),
  assigned_employee_id uuid, mortgage_company text, mortgage_servicer text, loan_number text, claim_number text,
  homeowner_name text, created_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz, completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mortgage_ops_request_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mortgage_request_id uuid NOT NULL, actor_id uuid, action text NOT NULL,
  previous_agent_id uuid, reason text NOT NULL, from_status text, to_status text, accepted_at_preserved timestamptz,
  tenant_billing_event_id uuid, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_ops_request_audit ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role) $$;
CREATE FUNCTION public.is_platform_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_owners WHERE user_id = auth.uid()) $$;
${AWS_IS_AUTHENTICATED}
${AWS_IS_AGENT}
INSERT INTO public.tenants VALUES ('${T_A}', 'Alpha Roofing'), ('${T_B}', 'Beta Builders');
INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT_X}', 'mortgage_agent'), ('${AGENT_Y}', 'mortgage_agent'), ('${AGENT_OFF}', 'mortgage_agent'), ('${MEMBER}', 'contractor');
INSERT INTO public.mortgage_agent_accounts VALUES ('${AGENT_X}', 'active'), ('${AGENT_OFF}', 'inactive');
INSERT INTO public.profiles VALUES ('${AGENT_X}', 'x-profile@example.test', 'Xavier Agent'), ('${AGENT_Y}', 'y@example.test', 'Yolanda Agent'), ('${AGENT_OFF}', 'off@example.test', 'Off Agent');
INSERT INTO public.identity_accounts VALUES ('${AGENT_X}', 'x@example.test', 'active');
INSERT INTO public.platform_owners VALUES ('${OWNER}');
INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, status, assigned_employee_id, mortgage_company, loan_number, created_at, accepted_at, completed_at) VALUES
  ('${REQ_Q1}', '${T_A}', 'c1570000-0000-4000-8000-000000000001', 'requested', NULL, 'Lender One', 'L-1', now() - interval '3 days', NULL, NULL),
  ('${REQ_Q2}', '${T_B}', 'c1570000-0000-4000-8000-000000000002', 'requested', NULL, 'Lender Two', 'L-2', now() - interval '1 day', NULL, NULL),
  ('${REQ_P}', '${T_A}', 'c1570000-0000-4000-8000-000000000003', 'in_progress', '${AGENT_Y}', 'Lender Three', 'L-3', now() - interval '5 days', now() - interval '2 hours', NULL),
  ('${REQ_C}', '${T_B}', 'c1570000-0000-4000-8000-000000000004', 'completed', '${AGENT_Y}', 'Lender Four', 'L-4', now() - interval '10 days', now() - interval '9 days', now() - interval '8 days'),
  ('${REQ_X}', '${T_A}', 'c1570000-0000-4000-8000-000000000005', 'cancelled', NULL, 'Lender Five', 'L-5', now() - interval '4 days', NULL, NULL);
RESET ROLE;
`;

test('SQL 157: Tenant Management sees all Desk work with its age, assigns queued requests, and writes notes only the assigned agent reads (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('sql157-', 54960);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  const clients = [admin];
  try {
    await admin.query(ROLES);
    const fileText = fs.readFileSync(SQL157, 'utf8');
    const owner = await connect('checksops_admin');
    clients.push(owner);

    // Without its prerequisites the file refuses and installs nothing.
    await assert.rejects(owner.query(fileText), /sql157_prerequisite_missing: public\.mortgage_handling_requests\.id/);
    await admin.query(SCHEMA);
    // A login that does not own the tables cannot install the DEFINERs (row_security off would refuse).
    const other = await connect('other_admin');
    clients.push(other);
    await assert.rejects(other.query(fileText), /sql157_definer_cannot_read: public\.mortgage_handling_requests/);
    assert.equal((await admin.query(`SELECT to_regclass('public.mortgage_desk_agent_notes') IS NULL AS absent`)).rows[0].absent, true);

    await owner.query(fileText);
    const fns = async () => (await admin.query(`
      SELECT p.proname, p.oid, r.rolname AS owner, p.prosecdef, p.proconfig, p.prosrc,
             ARRAY(SELECT coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type
                     FROM aclexplode(p.proacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee ORDER BY 1) AS acl
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)
      ORDER BY p.proname`, [FUNCTIONS])).rows;
    const first = await fns();
    assert.deepEqual(first.map((f) => [f.proname, f.owner, f.prosecdef, f.proconfig, f.acl]), FUNCTIONS.map((name) => (
      [name, 'checksops_admin', true, ['search_path=public', 'row_security=off'], ['checksops EXECUTE', 'checksops_admin EXECUTE']])));
    const table = async () => (await admin.query(`
      SELECT c.oid, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS policies,
             ARRAY(SELECT coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type
                     FROM aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
                    WHERE a.grantee <> c.relowner ORDER BY 1) AS grants
        FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'public.mortgage_desk_agent_notes'::regclass`)).rows[0];
    const t1 = await table();
    assert.deepEqual({ ...t1, oid: undefined }, { oid: undefined, owner: 'checksops_admin', relrowsecurity: true, relforcerowsecurity: false, policies: 0, grants: [] });
    // Re-runnable: replaced in place with the same text, the table kept.
    await owner.query(fileText);
    assert.deepEqual((await fns()).map((f) => [f.oid, f.prosrc, f.acl]), first.map((f) => [f.oid, f.prosrc, f.acl]));
    assert.deepEqual(await table(), t1);
    // Nothing else changed: no trigger, no policy anywhere.
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`)).rows[0].n, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_policy`)).rows[0].n, 0);
    // The API login reads the table only through the functions.
    const api = await connect('checksops');
    clients.push(api);
    await assert.rejects(api.query('SELECT * FROM public.mortgage_desk_agent_notes'), (e) => e.code === '42501');

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
    const code = (c, msg) => (e) => e.code === c && (!msg || new RegExp(msg).test(e.message));
    const denied = code('42501', 'not_authorized');

    // a) Overview: platform owner only; queued oldest first, then in progress, then completed; cancelled never.
    const overview = (user, ...args) => as(user, `SELECT * FROM public.aws_mortgage_desk_overview($1::uuid, $2::text, $3::int, $4::int)`, [args[0] ?? null, args[1] ?? null, args[2] ?? null, args[3] ?? null]);
    const all = await overview(OWNER);
    assert.deepEqual(all.map((r) => [r.request_id, r.status]), [[REQ_Q1, 'requested'], [REQ_Q2, 'requested'], [REQ_P, 'in_progress'], [REQ_C, 'completed']]);
    assert.ok(all.every((r) => Number(r.total_count) === 4));
    const byId = Object.fromEntries(all.map((r) => [r.request_id, r]));
    assert.equal(byId[REQ_Q1].tenant_name, 'Alpha Roofing');
    assert.ok(Math.abs(Number(byId[REQ_Q1].seconds_in_status) - 3 * 86400) < 120, 'queued 3 days');
    assert.ok(Math.abs(Number(byId[REQ_P].seconds_in_status) - 2 * 3600) < 120, 'in progress since accepted 2 hours ago');
    assert.equal(byId[REQ_P].assigned_agent_name, 'Yolanda Agent');
    assert.equal(byId[REQ_P].turnaround_seconds, null);
    assert.ok(Math.abs(Number(byId[REQ_C].turnaround_seconds) - 2 * 86400) < 120, 'completed 2 days after it was sent');
    assert.equal(byId[REQ_Q1].note_count, 0);
    assert.deepEqual((await overview(OWNER, T_B)).map((r) => r.request_id), [REQ_Q2, REQ_C]);
    const queuedPage = await overview(OWNER, null, 'requested', 1, 1);
    assert.deepEqual(queuedPage.map((r) => [r.request_id, Number(r.total_count)]), [[REQ_Q2, 2]]);
    await assert.rejects(overview(OWNER, null, 'cancelled'), code('22023', 'invalid_status'));
    for (const user of [AGENT_X, AGENT_Y, MEMBER, null]) await assert.rejects(overview(user), denied, String(user));

    // b) Assignable agents: active agents (no roster row counts as active), not inactive ones, with their load.
    const agents = await as(OWNER, 'SELECT * FROM public.aws_mortgage_desk_assignable_agents()');
    assert.deepEqual(agents.map((a) => [a.agent_id, a.agent_name, a.in_progress_count]), [[AGENT_X, 'Xavier Agent', 0], [AGENT_Y, 'Yolanda Agent', 1]]);
    await assert.rejects(as(AGENT_X, 'SELECT * FROM public.aws_mortgage_desk_assignable_agents()'), denied);

    // c) Assign: a queued request starts for the agent, with an audit row; refusals change nothing.
    const assign = (user, req, agent) => as(user, 'SELECT * FROM public.aws_mortgage_desk_assign_agent($1::uuid, $2::uuid)', [req, agent]);
    await assert.rejects(assign(AGENT_X, REQ_Q1, AGENT_X), denied, 'an agent cannot assign');
    await assert.rejects(assign(MEMBER, REQ_Q1, AGENT_X), denied, 'a tenant member cannot assign');
    await assert.rejects(assign(OWNER, REQ_Q1, AGENT_OFF), code('22023', 'agent_not_assignable'), 'inactive agent');
    await assert.rejects(assign(OWNER, REQ_Q1, MEMBER), code('22023', 'agent_not_assignable'), 'not an agent');
    await assert.rejects(assign(OWNER, REQ_P, AGENT_X), code('55000', 'already_taken'), 'in progress');
    await assert.rejects(assign(OWNER, REQ_C, AGENT_X), code('55000', 'already_taken'), 'completed');
    await assert.rejects(assign(OWNER, 'd1570000-0000-4000-8000-0000000000ff', AGENT_X), code('P0002', 'not_found'));
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.mortgage_ops_request_audit')).rows[0].n, 0);
    const [assigned] = await assign(OWNER, REQ_Q1, AGENT_X);
    assert.deepEqual({ ...assigned, accepted_at: undefined }, {
      request_id: REQ_Q1, agent_id: AGENT_X, agent_name: 'Xavier Agent', agent_email: 'x@example.test', accepted_at: undefined,
      tenant_name: 'Alpha Roofing', mortgage_company: 'Lender One', loan_number: 'L-1',
    });
    const row = (await admin.query('SELECT status, assigned_employee_id, accepted_at FROM public.mortgage_handling_requests WHERE id = $1', [REQ_Q1])).rows[0];
    assert.deepEqual([row.status, row.assigned_employee_id], ['in_progress', AGENT_X]);
    assert.ok(row.accepted_at);
    const audit = (await admin.query('SELECT mortgage_request_id, actor_id, action, from_status, to_status, payload FROM public.mortgage_ops_request_audit')).rows;
    assert.deepEqual(audit, [{ mortgage_request_id: REQ_Q1, actor_id: OWNER, action: 'assign', from_status: 'requested', to_status: 'in_progress', payload: { agent_id: AGENT_X, source: 'sql157' } }]);
    await assert.rejects(assign(OWNER, REQ_Q1, AGENT_Y), code('55000', 'already_taken'), 'assigned once');
    // The email falls back to the profile when there is no identity row.
    const [y] = await assign(OWNER, REQ_Q2, AGENT_Y);
    assert.equal(y.agent_email, 'y@example.test');

    // d) Notes: only the platform owner writes, only to an assigned agent; never on the check thread.
    const addNote = (user, req, body) => as(user, 'SELECT * FROM public.aws_mortgage_desk_add_agent_note($1::uuid, $2::text)', [req, body]);
    const notes = (user, req) => as(user, 'SELECT * FROM public.aws_mortgage_desk_agent_notes($1::uuid)', [req]);
    await assert.rejects(addNote(AGENT_Y, REQ_P, 'hi'), denied, 'an agent cannot write');
    await assert.rejects(addNote(MEMBER, REQ_P, 'hi'), denied, 'a tenant member cannot write');
    await assert.rejects(addNote(OWNER, REQ_P, '   '), code('22023', 'invalid_body'));
    await assert.rejects(addNote(OWNER, REQ_P, 'x'.repeat(2001)), code('22023', 'invalid_body'));
    await assert.rejects(addNote(OWNER, REQ_X, 'cancelled, nobody assigned'), code('55000', 'no_assigned_agent'));
    const [note] = await addNote(OWNER, REQ_P, '  Please call the lender today.  ');
    assert.equal(note.agent_id, AGENT_Y);
    assert.equal(note.agent_email, 'y@example.test');
    assert.equal(note.tenant_name, 'Alpha Roofing');
    await addNote(OWNER, REQ_C, 'Completed work: one question.');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.check_messages')).rows[0].n, 0, 'not a check message');

    // f) Read: the platform owner and the assigned agent only.
    const ownerView = await notes(OWNER, REQ_P);
    assert.deepEqual(ownerView.map((n) => [n.body, n.author_id, n.agent_id, n.email_status]), [['Please call the lender today.', OWNER, AGENT_Y, 'pending']]);
    assert.deepEqual((await notes(AGENT_Y, REQ_P)).map((n) => n.note_id), [note.note_id]);
    assert.equal((await notes(AGENT_Y, REQ_C)).length, 1, 'the assigned agent still reads it after completion');
    for (const user of [AGENT_X, MEMBER, null]) await assert.rejects(notes(user, REQ_P), denied, String(user));
    await assert.rejects(notes(OWNER, 'd1570000-0000-4000-8000-0000000000ff'), denied, 'unknown request');
    // Reassigned (returned to the queue and taken by X): the note follows the request; Y no longer reads it.
    await admin.query(`UPDATE public.mortgage_handling_requests SET assigned_employee_id = '${AGENT_X}' WHERE id = '${REQ_P}'`);
    await assert.rejects(notes(AGENT_Y, REQ_P), denied, 'no longer assigned');
    assert.equal((await notes(AGENT_X, REQ_P)).length, 1);
    await admin.query(`UPDATE public.mortgage_handling_requests SET assigned_employee_id = '${AGENT_Y}' WHERE id = '${REQ_P}'`);

    // e) The email outcome is recorded once, by the platform owner.
    const record = (user, id, status) => as(user, 'SELECT public.aws_mortgage_desk_record_agent_note_email($1::uuid, $2::text) AS ok', [id, status]);
    await assert.rejects(record(AGENT_Y, note.note_id, 'sent'), denied);
    await assert.rejects(record(OWNER, note.note_id, 'pending'), code('22023', 'invalid_status'));
    assert.equal((await record(OWNER, note.note_id, 'sent'))[0].ok, true);
    assert.equal((await record(OWNER, note.note_id, 'failed'))[0].ok, false, 'once');
    const recorded = (await notes(OWNER, REQ_P))[0];
    assert.equal(recorded.email_status, 'sent');
    assert.ok(recorded.emailed_at);
    assert.equal((await overview(OWNER, null, 'in_progress')).find((r) => r.request_id === REQ_P).note_count, 1);

    // Rate limit: 10 notes per request per hour.
    for (let i = 1; i < 10; i += 1) await addNote(OWNER, REQ_P, `note ${i}`);
    await assert.rejects(addNote(OWNER, REQ_P, 'eleventh'), code('54000', 'rate_limited'));
    await admin.query(`UPDATE public.mortgage_desk_agent_notes SET created_at = created_at - interval '2 hours' WHERE request_id = '${REQ_P}'`);
    await addNote(OWNER, REQ_P, 'after an hour');

    // Not callable by authenticated or PUBLIC.
    for (const fn of FUNCTIONS) {
      const oid = first.find((f) => f.proname === fn).oid;
      const priv = (await admin.query(`SELECT has_function_privilege('authenticated', $1::oid, 'EXECUTE') AS a`, [oid])).rows[0].a;
      assert.equal(priv, false, fn);
    }
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    server.stop();
  }
});
