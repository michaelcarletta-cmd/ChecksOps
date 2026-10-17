/**
 * SQL 100 (Mortgage Desk access as live in production) against PostgreSQL 16.
 *
 * Builds the repository's sequence for public.mortgage_handling_requests (the
 * real AWS RLS helpers through the shared stakeholder fixture, the
 * aws_select_ block of 12_final_select_policies.sql, the aws_write_ block of
 * 24_complete_write_policies.sql, the table's grants from
 * 50_tranche5_write_grants.sql, SQL 90), then applies
 * aws/workflows/sql/100_mortgage_desk_live_access.sql and SQL 99 as a
 * non-superuser owner login (like checksops_admin), and:
 *
 *   1. runs the production inspect library (inspectMortgageDeskAccess) on that
 *      database and checks that policies, grants and helper prosrc hashes are
 *      the production values of the 2026-10-17 inspect (SSM
 *      ee5c42a3-fe1b-4da8-bb84-106766285bfa, 45d46a8f-beeb-4ea7-9b1e-598fe6b980b4,
 *      041bc13d-70fa-4f43-805a-e4d7b22afd19): the repository reproduces production;
 *   2. re-applies SQL 100 on that state (production's) and checks the catalog
 *      did not change: on production it is a no-op;
 *   3. drives the Mortgage Desk as the API does (checksops, RLS on,
 *      request.app_user_id), through workflow-rpc.mjs: an agent sees and accepts
 *      an unassigned requested request, updates only their own, cannot reassign
 *      it or send it back to requested; a non-agent non-member sees nothing;
 *   4. completes the accepted request as the agent with SQL 99 on: the trigger
 *      posts the completion note and the return marker under these policies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import { buildRepoIndex, inspectMortgageDeskAccess, loadInspectConfig } from '../../scripts/deployment-guard/lib/mortgage-desk-access-inspect.mjs';
import { buildMortgageDeskCompletedMessage, buildReturnMessage } from '../../src/lib/mortgageDeskReturn.ts';

const ROOT = path.join(AWS_ROOT, '..');
const SQL_100_REL = 'aws/workflows/sql/100_mortgage_desk_live_access.sql';
const SQL_100 = path.join(ROOT, SQL_100_REL);
const SQL_99 = path.join(AWS_ROOT, 'workflows/sql/99_mortgage_desk_completion_messages.sql');
const SQL_90 = path.join(AWS_ROOT, 'workflows/sql/90_users_only_tenant_roles.sql');
const SQL_50 = path.join(AWS_ROOT, 'workflows/sql/50_tranche5_write_grants.sql');

/** The text from `start` through the end of the first `end` after it, exactly as the repo file has it. */
const sliceFrom = (file, start, end) => {
  const text = fs.readFileSync(file, 'utf8');
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} not found in ${file}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `${end} not found after ${start} in ${file}`);
  return text.slice(from, to + end.length);
};

/** Production, 2026-10-17 inspect: public.mortgage_handling_requests. */
const PRODUCTION = Object.freeze({
  owner: 'checksops_admin',
  rls_enabled: true,
  rls_forced: false,
  policies: {
    aws_delete_mortgage_handling_requests: {
      command: 'DELETE', roles: ['authenticated'],
      using: '(public.aws_is_cross_tenant_reader() OR public.aws_can_write_tenant(tenant_id))',
      with_check: null,
    },
    aws_insert_mortgage_handling_requests: {
      command: 'INSERT', roles: ['authenticated'],
      using: null,
      with_check: "(public.aws_is_cross_tenant_reader() OR (public.aws_can_write_tenant(tenant_id) AND (status = 'requested'::text) AND (assigned_employee_id IS NULL)))",
    },
    aws_select_mortgage_handling_requests: {
      command: 'SELECT', roles: ['authenticated'],
      using: '(public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id) OR public.aws_mortgage_agent_queue_visible(status, assigned_employee_id))',
      with_check: null,
    },
    aws_select_mortgage_ops_agent_queue: {
      command: 'SELECT', roles: ['authenticated', 'checksops'],
      using: 'public.aws_is_mortgage_ops_agent()',
      with_check: null,
    },
    aws_update_mortgage_ops_accept_complete: {
      command: 'UPDATE', roles: ['authenticated', 'checksops'],
      using: "(public.aws_is_mortgage_ops_agent() AND (((status = 'requested'::text) AND (assigned_employee_id IS NULL)) OR (assigned_employee_id = auth.uid())))",
      with_check: "(public.aws_is_mortgage_ops_agent() AND (assigned_employee_id = auth.uid()) AND (status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'cancelled'::text])) AND (((status = 'in_progress'::text) AND (accepted_at IS NOT NULL)) OR (status = ANY (ARRAY['completed'::text, 'cancelled'::text]))))",
    },
  },
  grants: {
    checksops: {
      table: ['DELETE', 'INSERT', 'SELECT'],
      column_update: ['accepted_at', 'assigned_employee_id', 'cancelled_at', 'claim_number', 'completed_at', 'homeowner_email',
        'homeowner_name', 'homeowner_phone', 'insurance_company', 'loan_number', 'mortgage_company', 'mortgage_servicer', 'note',
        'property_address', 'status', 'updated_at', 'work_notes'],
    },
    authenticated: { table: [], column_update: ['accepted_at', 'assigned_employee_id', 'completed_at'] },
  },
  functions: {
    'public.aws_is_mortgage_ops_agent': {
      signature: 'public.aws_is_mortgage_ops_agent()',
      prosrc_sha256: '787bad580adace93c661f60d4486e6623fbd4c6004c8e42b38e3bb9c0ff957ba',
      functiondef_sha256: '9a0fd53811d4bfaf8f06fe530eddea5b9c6b3fb69d8371d5608b0a8b2635b007',
    },
    'public.aws_mortgage_agent_queue_visible': {
      signature: 'public.aws_mortgage_agent_queue_visible(p_status text, p_assigned_employee_id uuid)',
      prosrc_sha256: 'b9f70c8b1421f264b4537d4eac9e7ad18f81281648a33197b55aa826ff6b6711',
      functiondef_sha256: 'e8012bab7455679ba9a53341cd679b063cc6d7b9df977a35d5d92933b34bc6d2',
    },
    'public.aws_is_active_mortgage_agent': {
      signature: 'public.aws_is_active_mortgage_agent(_user_id uuid)',
      // The inspect's live value starts 2bba15b2 and equals the SQL 47 test fixture's body.
      prosrc_sha256: '2bba15b20b7e43c60fadf7032e834ec1937183af865d14ab1985a5bdd4f12117',
      functiondef_sha256: 'd8846afb599babf83e5657ec63e54a7cd8a6e950bec96096ab5925972b37c98b',
    },
  },
});

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const MEMBER = 'a1000000-0000-4000-8000-000000000001';
const AGENT = 'a1000000-0000-4000-8000-000000000003';
const OTHER_AGENT = 'a1000000-0000-4000-8000-000000000004';
const OUTSIDER = 'a1000000-0000-4000-8000-000000000005';
const INACTIVE_AGENT = 'a1000000-0000-4000-8000-000000000006';
const CHECK_Q = 'c1000000-0000-4000-8000-000000000001';
const CHECK_OTHER = 'c1000000-0000-4000-8000-000000000002';
const CHECK_B = 'c1000000-0000-4000-8000-000000000003';
const REQ_Q = 'd1000000-0000-4000-8000-000000000001';
const REQ_OTHER = 'd1000000-0000-4000-8000-000000000002';
const REQ_B = 'd1000000-0000-4000-8000-000000000003';
const REQ_B_DONE = 'd1000000-0000-4000-8000-000000000004';
const REQ_NEW = 'd1000000-0000-4000-8000-000000000005';

/** As the superuser, after applyBaseSchema: the owner login and the Desk tables it owns. */
const SCHEMA = `
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
GRANT USAGE ON SCHEMA auth TO checksops_admin;
CREATE TABLE public.check_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 5000),
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, claim_id uuid,
  mortgage_company text, mortgage_servicer text, loan_number text, note text, work_notes text,
  property_address text, claim_number text, insurance_company text,
  homeowner_name text, homeowner_email text, homeowner_phone text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_progress', 'completed', 'cancelled')),
  assigned_employee_id uuid,
  accepted_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
-- SQL 47's roster table (aws/tests/fixtures/mortgage-agent-compensation/47_mortgage_agent_compensation.sql).
CREATE TABLE public.mortgage_agent_accounts (
  application_user_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')));
ALTER TABLE public.check_messages OWNER TO checksops_admin;
ALTER TABLE public.mortgage_handling_requests OWNER TO checksops_admin;
ALTER TABLE public.mortgage_agent_accounts OWNER TO checksops_admin;
-- aws/write-path/sql/35_tranche3_write_grants.sql and 50_tranche5_write_grants.sql.
GRANT SELECT, INSERT, DELETE ON TABLE public.check_messages TO checksops, authenticated;
GRANT UPDATE (is_deleted, updated_at) ON TABLE public.check_messages TO checksops, authenticated;
ALTER TABLE public.check_messages ENABLE ROW LEVEL SECURITY;
-- aws/rls/sql/26_enable_rls.sql.
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
`;

const SEED = `
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${MEMBER}', 'm@example.com', 'active'), ('${AGENT}', 'agent@example.com', 'active'),
  ('${OTHER_AGENT}', 'agent2@example.com', 'active'), ('${OUTSIDER}', 'o@example.com', 'active'),
  ('${INACTIVE_AGENT}', 'agent3@example.com', 'active');
INSERT INTO public.profiles (id, email) SELECT application_user_id, email FROM public.identity_accounts;
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${AGENT}', 'mortgage_agent'), ('${OTHER_AGENT}', 'mortgage_agent'), ('${INACTIVE_AGENT}', 'mortgage_agent');
INSERT INTO public.mortgage_agent_accounts (application_user_id, status) VALUES
  ('${AGENT}', 'active'), ('${OTHER_AGENT}', 'active'), ('${INACTIVE_AGENT}', 'inactive');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${MEMBER}', 'viewer');
INSERT INTO public.check_intake_items (id, tenant_id) VALUES
  ('${CHECK_Q}', '${TENANT_A}'), ('${CHECK_OTHER}', '${TENANT_A}'), ('${CHECK_B}', '${TENANT_B}');
INSERT INTO public.mortgage_handling_requests
  (id, tenant_id, check_intake_item_id, mortgage_company, status, assigned_employee_id, accepted_at, completed_at)
VALUES
  ('${REQ_Q}', '${TENANT_A}', '${CHECK_Q}', 'Rocket Mortgage', 'requested', NULL, NULL, NULL),
  ('${REQ_OTHER}', '${TENANT_A}', '${CHECK_OTHER}', 'Other Bank', 'in_progress', '${OTHER_AGENT}', now(), NULL),
  ('${REQ_B}', '${TENANT_B}', '${CHECK_B}', 'B Bank', 'requested', NULL, NULL, NULL),
  ('${REQ_B_DONE}', '${TENANT_B}', NULL, 'B Bank', 'completed', '${OTHER_AGENT}', now(), now());
`;

test('SQL 100 has its own migration number, compared as a number (not two digits, not text order)', () => {
  const dir = path.join(AWS_ROOT, 'workflows/sql');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sql'));
  const prefixOf = (name) => Number(name.match(/^(\d+)_/)?.[1]);
  assert.deepEqual(files.filter((name) => prefixOf(name) === 100), [path.basename(SQL_100)]);
  // After SQL 99 (the Desk completion trigger) numerically, although '100_' sorts before '10_' / '99_' as text.
  assert.ok(prefixOf(path.basename(SQL_100)) > prefixOf('99_mortgage_desk_completion_messages.sql'));
  assert.ok(files.includes('99_mortgage_desk_completion_messages.sql'));
  assert.ok(!files.some((name) => /^98_mortgage_desk/.test(name)), 'the old SQL 98 name is gone');
  assert.match(fs.readFileSync(SQL_100, 'utf8'), /^-- AWS: Mortgage Desk access as it is live in production \(SQL 100\)\./);
});

/** What applying SQL 100 could change: policies, table / column ACLs, RLS flags, the helpers. */
const catalogSnapshot = async (c) => (await c.query(`SELECT
  (SELECT json_agg(json_build_object('name', polname, 'cmd', polcmd, 'permissive', polpermissive,
      'roles', (SELECT array_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE r::regrole::text END ORDER BY 1) FROM unnest(polroles) AS r),
      'using', pg_get_expr(polqual, polrelid), 'check', pg_get_expr(polwithcheck, polrelid)) ORDER BY polname)
     FROM pg_policy WHERE polrelid = 'public.mortgage_handling_requests'::regclass) AS policies,
  (SELECT json_build_object('acl', relacl::text, 'rls', relrowsecurity, 'force', relforcerowsecurity, 'owner', relowner::regrole::text)
     FROM pg_class WHERE oid = 'public.mortgage_handling_requests'::regclass) AS mhr,
  (SELECT json_agg(json_build_object('col', attname, 'acl', attacl::text) ORDER BY attnum)
     FROM pg_attribute WHERE attrelid = 'public.mortgage_handling_requests'::regclass AND attnum > 0 AND NOT attisdropped) AS columns,
  (SELECT json_agg(json_build_object('fn', p.oid::regprocedure::text, 'src', p.prosrc, 'cfg', p.proconfig, 'definer', p.prosecdef,
      'vol', p.provolatile, 'owner', p.proowner::regrole::text, 'acl', p.proacl::text, 'def', pg_get_functiondef(p.oid)) ORDER BY p.proname)
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('aws_is_mortgage_ops_agent', 'aws_mortgage_agent_queue_visible', 'aws_is_active_mortgage_agent')) AS functions`)).rows[0];

test('PostgreSQL 16: the repository plus SQL 100 reproduces production Mortgage Desk access; agents work the queue and SQL 99 posts under it', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql100-desk-', 62400);
  const open = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const client = await open('ubuntu');
  const clients = [client];
  try {
    await applyBaseSchema(client);
    await client.query(SCHEMA);
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_check_messages'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_check_messages'));
    // The repository's sequence for mortgage_handling_requests: 12, 24, SQL 50, SQL 90.
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_mortgage_handling_requests'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_mortgage_handling_requests'));
    await client.query(sliceFrom(SQL_50,
      'GRANT SELECT, INSERT, DELETE ON TABLE public.mortgage_handling_requests',
      ') ON TABLE public.mortgage_handling_requests TO checksops, authenticated;'));
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    // Production's checksops_admin owns the helpers it calls; here the superuser does.
    await client.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checksops_admin');
    await client.query(SEED);

    const owner = await open('checksops_admin');
    clients.push(owner);
    const sql100 = fs.readFileSync(SQL_100, 'utf8');
    await owner.query(sql100);

    // --- Applied again on the state it produces (production's): nothing changes.
    const applied = await catalogSnapshot(owner);
    await owner.query(sql100);
    assert.deepEqual(await catalogSnapshot(owner), applied);

    await owner.query(fs.readFileSync(SQL_99, 'utf8'));
    assert.deepEqual(await catalogSnapshot(owner), applied, 'SQL 99 changes no policy, grant or helper');

    // --- The production inspect on this database reports production's values.
    const config = loadInspectConfig(ROOT);
    // The inspect run SQL 100 records is the one in the configuration.
    assert.equal(config.production_inspect.date, '2026-10-17');
    assert.equal(config.production_inspect.source_commit, '09aa7ab00');
    assert.equal(config.production_inspect.drift_recorded_in, SQL_100_REL);
    for (const id of config.production_inspect.ssm_command_ids) assert.ok(sql100.includes(id), id);
    assert.equal(config.production_inspect.ssm_command_ids.length, 3);
    const inspected = await inspectMortgageDeskAccess({ connect: () => open('checksops_admin'), root: ROOT, config });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const report = inspected.details;
    const mhr = report.tables.mortgage_handling_requests;
    assert.equal(mhr.owner, PRODUCTION.owner);
    assert.equal(mhr.rls_enabled, PRODUCTION.rls_enabled);
    assert.equal(mhr.rls_forced, PRODUCTION.rls_forced);

    // Exactly the five live policies; aws_write_mortgage_handling_requests (24) is gone.
    assert.equal(mhr.policy_count, 5);
    const policies = Object.fromEntries(mhr.policies.map((p) => [p.policy, {
      command: p.command, roles: p.roles, using: p.using.text, with_check: p.with_check.text,
    }]));
    assert.deepEqual(policies, PRODUCTION.policies);
    for (const p of mhr.policies) {
      assert.equal(p.permissive, true, p.policy);
      assert.equal(p.using.text_withheld, undefined, p.policy);
      assert.equal(p.with_check.text_withheld, undefined, p.policy);
      assert.ok(p.repo_sources.includes(SQL_100_REL), p.policy);
    }
    assert.ok(!mhr.policies.some((p) => p.policy === 'aws_write_mortgage_handling_requests'));

    // Grants.
    const g = mhr.grants;
    assert.deepEqual(g.checksops.table_acl.map((a) => a.privilege).sort(), PRODUCTION.grants.checksops.table);
    assert.deepEqual(g.checksops.column_acl, { UPDATE: PRODUCTION.grants.checksops.column_update });
    assert.deepEqual(g.checksops.effective_table_privileges, PRODUCTION.grants.checksops.table);
    assert.deepEqual(g.authenticated.table_acl, PRODUCTION.grants.authenticated.table);
    assert.deepEqual(g.authenticated.column_acl, { UPDATE: PRODUCTION.grants.authenticated.column_update });
    assert.deepEqual(g.authenticated.effective_table_privileges, []);
    assert.deepEqual(g.authenticated.effective_any_column_privileges, ['UPDATE']);
    assert.deepEqual(g.PUBLIC, { role_exists: true, table_acl: [], column_acl: {}, column_acl_entry_count: 0, column_acl_entries: [], column_acl_grantors: [] });
    for (const a of [...g.checksops.table_acl]) assert.equal(a.grantable, false);
    // No-op on production also means the same grantor: every table and column ACL entry is
    // checksops_admin's (production's owner). A re-GRANT by another grantor would add entries.
    for (const grantee of ['checksops', 'authenticated']) {
      for (const a of g[grantee].table_acl) assert.equal(a.grantor, 'checksops_admin', `${grantee} ${a.privilege}`);
      assert.deepEqual(g[grantee].column_acl_grantors, ['checksops_admin'], grantee);
      assert.equal(g[grantee].column_acl_entries.length, g[grantee].column_acl_entry_count, grantee);
      for (const e of g[grantee].column_acl_entries) {
        assert.equal(e.grantor, 'checksops_admin', `${grantee} ${e.privilege} ${e.column}`);
        assert.equal(e.grantable, false, `${grantee} ${e.column}`);
      }
    }
    assert.deepEqual(g.checksops.column_acl_entries.map((e) => e.column), PRODUCTION.grants.checksops.column_update);
    assert.deepEqual(g.authenticated.column_acl_entries.map((e) => e.column), PRODUCTION.grants.authenticated.column_update);
    // ... and no policy comment (DROP POLICY + CREATE POLICY would lose one).
    for (const p of mhr.policies) assert.deepEqual(p.comment, { present: false, sha256: null }, p.policy);

    // Helpers: prosrc hash equal to production's, SECURITY DEFINER sql STABLE, row_security + search_path.
    const fnReport = (key) => (report.functions[key] || report.policy_dependency_functions[key]);
    for (const [key, want] of Object.entries(PRODUCTION.functions)) {
      const r = fnReport(key);
      assert.equal(r?.present, true, key);
      assert.equal(r.overloads.length, 1, key);
      const [f] = r.overloads;
      assert.equal(f.function, want.signature);
      assert.equal(f.prosrc_sha256, want.prosrc_sha256, key);
      assert.equal(f.owner, 'checksops_admin', key);
      assert.equal(f.security_definer, true, key);
      assert.equal(f.language, 'sql', key);
      assert.equal(f.volatility, 'STABLE', key);
      assert.deepEqual(f.proconfig_names, ['row_security', 'search_path'], key);
      assert.equal(f.sets_row_security, true, key);
      assert.equal(f.repo_match, 'exact', key);
      assert.ok(f.matched_sources.includes(SQL_100_REL), key);
      assert.ok(f.matched_kinds.includes('aws_sql'), key);
      // pg_get_functiondef (attributes and SET values included): confirmed equal to the production inspect output.
      assert.equal(f.functiondef_sha256, want.functiondef_sha256, key);
      // EXECUTE: SQL 100 grants and revokes nothing on its helpers, so a function it creates has the
      // default ACL (PUBLIC and the owner, granted by the owner).
      assert.equal(f.execute_acl_default, true, key);
      assert.equal(f.public_execute, true, key);
      assert.deepEqual(f.execute_acl, [
        { grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false, grantor: 'checksops_admin' },
        { grantee: 'checksops_admin', privilege: 'EXECUTE', grantable: false, grantor: 'checksops_admin' },
      ], key);
    }
    assert.deepEqual(mhr.policies.find((p) => p.policy === 'aws_select_mortgage_ops_agent_queue').depends_on_functions,
      ['public.aws_is_mortgage_ops_agent']);
    assert.deepEqual([...mhr.policies.find((p) => p.policy === 'aws_select_mortgage_handling_requests').depends_on_functions].sort(),
      ['public.aws_can_access_tenant', 'public.aws_is_cross_tenant_reader', 'public.aws_mortgage_agent_queue_visible']);
    assert.deepEqual(mhr.triggers.map((x) => x.trigger), ['tr_mortgage_desk_completion_messages']);

    // The repository index (what the inspect's created_in_repo uses) names SQL 100 for every live policy.
    const index = buildRepoIndex(ROOT);
    for (const name of Object.keys(PRODUCTION.policies)) {
      assert.ok((index.policies.get(`mortgage_handling_requests\u0000${name}`) || []).includes(SQL_100_REL), name);
    }

    // aws_is_active_mortgage_agent: the roster's inactive flag.
    const active = async (id) => (await owner.query('SELECT public.aws_is_active_mortgage_agent($1::uuid) AS v', [id])).rows[0].v;
    assert.equal(await active(AGENT), true);
    assert.equal(await active(INACTIVE_AGENT), false);
    assert.equal(await active(OUTSIDER), false);

    // --- Behaviour, as the API runs it: checksops with RLS on and request.app_user_id set.
    /** One committed API transaction as checksops for this user. */
    const as = async (user, fn) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const rpc = (user, name, args) => as(user, () => executeSafeWriteRpc({
      client, mapping: { application_user_id: user }, name, args,
    }));
    const sql = (user, text, params = []) => as(user, () => client.query(text, params));
    const visible = async (user) => (await sql(user, 'SELECT id FROM public.mortgage_handling_requests ORDER BY id')).rows.map((r) => r.id);
    const row = async (id) => (await client.query(
      'SELECT status, assigned_employee_id, accepted_at, completed_at, tenant_id FROM public.mortgage_handling_requests WHERE id = $1', [id],
    )).rows[0];
    const rlsDenied = (error) => error.code === '42501' && /row-level security/.test(error.message);
    const permissionDenied = (error) => error.code === '42501' && /permission denied/.test(error.message);

    // Visibility: an agent sees every request (the agent queue policy); a tenant member its own
    // tenant's; a non-agent non-member nothing.
    assert.deepEqual(await visible(AGENT), [REQ_Q, REQ_OTHER, REQ_B, REQ_B_DONE]);
    assert.deepEqual(await visible(MEMBER), [REQ_Q, REQ_OTHER]);
    assert.deepEqual(await visible(OUTSIDER), []);

    // A non-agent non-member: no read, accept, update, insert or delete.
    assert.equal((await rpc(OUTSIDER, 'accept_mortgage_handling_request', { _request_id: REQ_Q })).error, 'not_authorized');
    assert.equal((await sql(OUTSIDER, `UPDATE public.mortgage_handling_requests SET status = 'in_progress', assigned_employee_id = $1, accepted_at = now() WHERE id = $2`,
      [OUTSIDER, REQ_Q])).rowCount, 0);
    assert.equal((await sql(OUTSIDER, 'DELETE FROM public.mortgage_handling_requests')).rowCount, 0);
    await assert.rejects(sql(OUTSIDER, `INSERT INTO public.mortgage_handling_requests (id, tenant_id) VALUES ($1, $2)`, [REQ_NEW, TENANT_A]), rlsDenied);

    // Accept: the agent takes the unassigned requested request through the API bridge.
    const accepted = await rpc(AGENT, 'accept_mortgage_handling_request', { _request_id: REQ_Q });
    assert.equal(accepted.error, undefined, JSON.stringify(accepted));
    assert.equal(accepted.data.status, 'in_progress');
    assert.equal(accepted.data.assigned_employee_id, AGENT);
    assert.ok(accepted.data.accepted_at);
    assert.equal((await row(REQ_Q)).assigned_employee_id, AGENT);
    // Taken: another agent cannot accept it, directly or through the API.
    assert.equal((await rpc(OTHER_AGENT, 'accept_mortgage_handling_request', { _request_id: REQ_Q })).error, 'already_taken');
    assert.equal((await sql(OTHER_AGENT, `UPDATE public.mortgage_handling_requests SET assigned_employee_id = $1 WHERE id = $2`,
      [OTHER_AGENT, REQ_Q])).rowCount, 0);

    // Only their own: another agent's request is not updatable by this agent.
    assert.equal((await rpc(AGENT, 'update_mortgage_handling_request_status',
      { _request_id: REQ_OTHER, _status: 'completed', _notes: 'not mine' })).error, 'not_assigned_to_you');
    assert.equal((await sql(AGENT, `UPDATE public.mortgage_handling_requests SET status = 'completed', completed_at = now() WHERE id = $1`,
      [REQ_OTHER])).rowCount, 0);
    assert.equal((await sql(AGENT, `UPDATE public.mortgage_handling_requests SET status = 'cancelled' WHERE id = $1`,
      [REQ_B_DONE])).rowCount, 0);
    assert.equal((await row(REQ_OTHER)).status, 'in_progress');
    assert.equal((await row(REQ_B_DONE)).status, 'completed');

    // Own request: no reassignment, no release, no return to requested, no in_progress without accepted_at.
    for (const [label, set, params] of [
      ['reassign', 'assigned_employee_id = $2', [REQ_Q, OTHER_AGENT]],
      ['release', 'assigned_employee_id = NULL', [REQ_Q]],
      ['back to requested', "status = 'requested', assigned_employee_id = NULL", [REQ_Q]],
      ['requested while assigned', "status = 'requested'", [REQ_Q]],
      ['in_progress without accepted_at', 'accepted_at = NULL', [REQ_Q]],
    ]) {
      await assert.rejects(sql(AGENT, `UPDATE public.mortgage_handling_requests SET ${set} WHERE id = $1`, params), rlsDenied, label);
    }
    // ... no move to another tenant (no UPDATE on tenant_id for checksops), no insert, no delete.
    await assert.rejects(sql(AGENT, 'UPDATE public.mortgage_handling_requests SET tenant_id = $2 WHERE id = $1', [REQ_Q, TENANT_B]), permissionDenied);
    await assert.rejects(sql(AGENT, `INSERT INTO public.mortgage_handling_requests (id, tenant_id) VALUES ($1, $2)`, [REQ_NEW, TENANT_B]), rlsDenied);
    assert.equal((await sql(AGENT, 'DELETE FROM public.mortgage_handling_requests WHERE id = $1', [REQ_Q])).rowCount, 0);
    const stillMine = await row(REQ_Q);
    assert.equal(stillMine.status, 'in_progress');
    assert.equal(stillMine.assigned_employee_id, AGENT);
    assert.equal(stillMine.tenant_id, TENANT_A);
    assert.ok(stillMine.accepted_at);

    // A tenant member: inserts only a requested, unassigned request for its own tenant; live has no
    // tenant UPDATE policy, so a member's update matches no row.
    await assert.rejects(sql(MEMBER, `INSERT INTO public.mortgage_handling_requests (id, tenant_id, status, assigned_employee_id) VALUES ($1, $2, 'in_progress', $3)`,
      [REQ_NEW, TENANT_A, AGENT]), rlsDenied);
    await assert.rejects(sql(MEMBER, `INSERT INTO public.mortgage_handling_requests (id, tenant_id) VALUES ($1, $2)`, [REQ_NEW, TENANT_B]), rlsDenied);
    assert.equal((await sql(MEMBER, `INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id) VALUES ($1, $2, $3)`,
      [REQ_NEW, TENANT_A, CHECK_Q])).rowCount, 1);
    assert.equal((await sql(MEMBER, `UPDATE public.mortgage_handling_requests SET status = 'completed' WHERE id = $1`, [REQ_OTHER])).rowCount, 0);
    assert.equal((await sql(MEMBER, 'DELETE FROM public.mortgage_handling_requests WHERE id = $1', [REQ_NEW])).rowCount, 1);

    // --- SQL 99 end to end under these policies: the agent completes its own request through the API.
    assert.deepEqual((await owner.query('SELECT count(*)::int AS n FROM public.check_messages')).rows[0].n, 0);
    const done = await rpc(AGENT, 'update_mortgage_handling_request_status',
      { _request_id: REQ_Q, _status: 'completed', _notes: 'Endorsed and mailed back' });
    assert.equal(done.error, undefined, JSON.stringify(done));
    assert.equal(done.data.status, 'completed');
    assert.ok(done.data.completed_at);
    const messages = (await owner.query(
      'SELECT check_id, sender_id, body, is_deleted FROM public.check_messages ORDER BY created_at, id')).rows;
    assert.deepEqual(messages, [
      { check_id: CHECK_Q, sender_id: AGENT, body: buildMortgageDeskCompletedMessage('Rocket Mortgage', 'Endorsed and mailed back'), is_deleted: false },
      { check_id: CHECK_Q, sender_id: AGENT, body: buildReturnMessage(REQ_Q), is_deleted: false },
    ]);
    // The agent still cannot write the thread directly, and the tenant member reads both messages.
    await assert.rejects(sql(AGENT, 'INSERT INTO public.check_messages (check_id, sender_id, body) VALUES ($1, $2, $3)',
      [CHECK_Q, AGENT, 'direct']), rlsDenied);
    assert.equal((await sql(MEMBER, 'SELECT id FROM public.check_messages WHERE check_id = $1', [CHECK_Q])).rowCount, 2);
    // A completed request stays the agent's: it can cancel it but not hand it back.
    await assert.rejects(sql(AGENT, `UPDATE public.mortgage_handling_requests SET status = 'requested', assigned_employee_id = NULL WHERE id = $1`, [REQ_Q]), rlsDenied);
    assert.equal((await rpc(AGENT, 'update_mortgage_handling_request_status', { _request_id: REQ_Q, _status: 'cancelled', _notes: null })).error, undefined);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.check_messages')).rows[0].n, 2);
    // Nothing else changed.
    assert.equal((await row(REQ_B)).status, 'requested');
    assert.equal((await row(REQ_B)).assigned_employee_id, null);
  } finally {
    for (const c of clients.reverse()) {
      try { await c.end(); } catch { /* ignore */ }
    }
    server.stop();
  }
});
