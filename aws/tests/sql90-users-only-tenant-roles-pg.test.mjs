/**
 * SQL 90 (users only, no tenant role tiers) against PostgreSQL 16: the real AWS
 * RLS helper files (aws/rls/sql), the real tenant_users / tenants / user_roles /
 * tax policies, the real SQL 80 Auto-Deposit function, then the real
 * aws/workflows/sql/90_users_only_tenant_roles.sql file.
 *
 * Owner policy: every member of a tenant (any tenant_users row, whatever role
 * value is stored, 'viewer' included) is a user with the same rights. Partners
 * (members of another tenant), other tenants and global user_roles admin/staff
 * without membership get nothing. Platform roles are set by the platform owner
 * only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';

const SQL_90 = path.join(AWS_ROOT, 'workflows/sql/90_users_only_tenant_roles.sql');
const SQL_93 = path.join(AWS_ROOT, 'workflows/sql/93_tenant_company_info.sql');
const SQL_96 = path.join(AWS_ROOT, 'workflows/sql/96_platform_owner_tenant_pricing.sql');
const SQL_80 = path.join(AWS_ROOT, 'workflows/sql/80_checkalt_member_auto_deposit.sql');
const SQL_35 = path.join(AWS_ROOT, 'rls/sql/35_manager_partner_parity.sql');

/** SQL 35 without tenants_public (its tenants columns are not in this fixture). */
const sql35ManagerViews = () => {
  const text = fs.readFileSync(SQL_35, 'utf8');
  const fnEnd = text.indexOf('-- Active-tenant public columns only.');
  const viewsStart = text.indexOf('-- Non-secret CheckAlt settings');
  assert.ok(fnEnd > 0 && viewsStart > fnEnd);
  return text.slice(0, fnEnd) + text.slice(viewsStart);
};

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const OPERATOR = 'a1000000-0000-4000-8000-000000000004';
const VIEWER = 'a1000000-0000-4000-8000-000000000005';
const GLOBAL_ADMIN_VIEWER = 'a1000000-0000-4000-8000-000000000006';
const GLOBAL_ADMIN = 'a1000000-0000-4000-8000-000000000007';
const GLOBAL_STAFF = 'a1000000-0000-4000-8000-000000000008';
const B_OWNER = 'a1000000-0000-4000-8000-000000000009';
const TEAMMATE = 'a1000000-0000-4000-8000-00000000000a';
const PLATFORM_OWNER = 'a1000000-0000-4000-8000-00000000000b';
const NEWCOMER = 'a1000000-0000-4000-8000-00000000000c';
const TENANT_EMPTY = '44444444-4444-4444-8444-444444444444';
const CHECK_A = '55555555-5555-4555-8555-555555555555';
const CLAIM_A = '66666666-6666-4666-8666-666666666666';
const DEPOSIT_PENDING = '77777777-7777-4777-8777-777777777777';
const DEPOSIT_ASSIGNED = '88888888-8888-4888-8888-888888888888';
const RACE_A = 'a1000000-0000-4000-8000-0000000000c1';
const RACE_B = 'a1000000-0000-4000-8000-0000000000c2';

const MEMBERS = [OWNER, OPERATOR, VIEWER, GLOBAL_ADMIN_VIEWER];
const OUTSIDERS = [GLOBAL_ADMIN, GLOBAL_STAFF, B_OWNER];

const SEED = `
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
CREATE TABLE public.checkalt_tenant_accounts (
  tenant_id uuid PRIMARY KEY, auto_approve_enabled boolean NOT NULL DEFAULT false,
  auto_approve_max_cents integer, updated_at timestamptz DEFAULT now());
CREATE TABLE public.tenant_email_settings (tenant_id uuid PRIMARY KEY, from_name text);
CREATE TABLE public.checkalt_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), singleton boolean NOT NULL DEFAULT true, base_url text, merchant text,
  fi_key text, business_unit text, depositor_account_id text, default_enabled boolean, auto_approve_enabled boolean,
  auto_approve_max_cents integer, notes text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  updated_by uuid);
CREATE TABLE public.deposit_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text, display_name text, is_active boolean, is_stubbed boolean,
  capabilities jsonb, config jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
INSERT INTO public.checkalt_config (merchant, fi_key, depositor_account_id) VALUES ('M-1', 'FI-1', '123456789');
INSERT INTO public.deposit_provider_config (provider, display_name, is_active, is_stubbed, capabilities, config)
  VALUES ('checkalt', 'Check Alt', true, false, '{"rdc": true}', '{"secret": "x"}');
ALTER TABLE public.identity_accounts ADD COLUMN cognito_sub text UNIQUE, ADD COLUMN linked_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.profiles ADD COLUMN full_name text;
CREATE TABLE public.pii_reveal_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, field_name text);
CREATE TABLE public.user_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, is_active boolean DEFAULT true);
CREATE TABLE public.contractor_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tier text DEFAULT 'basic');
CREATE TYPE public.deposit_provider AS ENUM ('checkalt', 'manual_branch');
ALTER TABLE public.deposit_items ADD COLUMN amount numeric, ADD COLUMN status text, ADD COLUMN batch_id uuid;
CREATE TABLE public.deposit_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider public.deposit_provider, total_items integer NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0, created_by uuid, updated_at timestamptz DEFAULT now());
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B'), ('${TENANT_EMPTY}', 'Empty');
INSERT INTO public.tenant_email_settings (tenant_id, from_name) VALUES ('${TENANT_A}', 'A');
INSERT INTO public.check_intake_items (id, tenant_id) VALUES ('${CHECK_A}', '${TENANT_A}');
INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM_A}', '${TENANT_A}');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${OWNER}', 'o@example.com', 'active'), ('${OPERATOR}', 'op@example.com', 'active'),
  ('${VIEWER}', 'v@example.com', 'active'), ('${GLOBAL_ADMIN_VIEWER}', 'gav@example.com', 'active'),
  ('${GLOBAL_ADMIN}', 'ga@example.com', 'active'), ('${GLOBAL_STAFF}', 'gs@example.com', 'active'),
  ('${B_OWNER}', 'b@example.com', 'active'), ('${TEAMMATE}', 't@example.com', 'active'),
  ('${PLATFORM_OWNER}', 'checksopsadmin@gmail.com', 'active'), ('${NEWCOMER}', 'n@example.com', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${GLOBAL_ADMIN_VIEWER}', 'admin'), ('${GLOBAL_ADMIN}', 'admin'), ('${GLOBAL_STAFF}', 'staff');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${OWNER}', 'owner'), ('${TENANT_A}', '${OPERATOR}', 'operator'),
  ('${TENANT_A}', '${VIEWER}', 'viewer'), ('${TENANT_A}', '${GLOBAL_ADMIN_VIEWER}', 'viewer'),
  ('${TENANT_A}', '${TEAMMATE}', 'viewer'), ('${TENANT_B}', '${B_OWNER}', 'owner');
INSERT INTO public.recipient_tax_profiles (tenant_id, recipient_key, tin) VALUES ('${TENANT_A}', 'acct:1', '12-3456789');
INSERT INTO public.checkalt_tenant_accounts (tenant_id) VALUES ('${TENANT_A}'), ('${TENANT_B}');
UPDATE public.identity_accounts SET cognito_sub = 'sub-' || application_user_id::text;
INSERT INTO public.profiles (id, email) SELECT application_user_id, email FROM public.identity_accounts;
INSERT INTO public.pii_reveal_logs (user_id, field_name) VALUES ('${TEAMMATE}', 'tin');
INSERT INTO public.user_sessions (user_id) VALUES ('${TEAMMATE}');
INSERT INTO public.contractor_profiles (user_id) VALUES ('${TEAMMATE}');
INSERT INTO public.deposit_items (id, check_id, amount, status) VALUES
  ('${DEPOSIT_PENDING}', '${CHECK_A}', 25, 'pending_assignment'),
  ('${DEPOSIT_ASSIGNED}', '${CHECK_A}', 30, 'provider_assigned');
`;

test('PostgreSQL 16: SQL 90 makes membership the only tenant gate and platform roles platform-owner only', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql90-roles-', 55400);
  const client = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  try {
    await applyBaseSchema(client);
    await client.query(SEED);
    for (const table of ['tenant_users', 'tenants', 'recipient_tax_profiles', 'user_roles', 'tenant_email_settings', 'checkalt_tenant_accounts',
      'profiles', 'pii_reveal_logs', 'user_sessions', 'contractor_profiles', 'deposit_batches']) {
      await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO checksops`);
    }
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_tenant_users'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_tenants'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_user_roles'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_tenant_users'));
    await client.query(policyBlock('21_proposed_write_policies.sql', 'aws_write_tenants'));
    await client.query(policyBlock('21_proposed_write_policies.sql', 'aws_write_user_roles'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_recipient_tax_profiles'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_recipient_tax_profiles'));
    await client.query(policyBlock('21_proposed_write_policies.sql', 'aws_write_tenant_email_settings'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_checkalt_tenant_accounts'));
    await client.query(`CREATE POLICY aws_select_tenant_email_settings ON public.tenant_email_settings FOR SELECT TO authenticated USING (true)`);
    await client.query(`CREATE POLICY aws_select_checkalt_tenant_accounts ON public.checkalt_tenant_accounts FOR SELECT TO authenticated USING (true)`);
    await client.query('GRANT SELECT, INSERT, UPDATE ON TABLE public.identity_accounts TO checksops');
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_profiles'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_profiles'));
    for (const name of ['pii_reveal_logs', 'user_sessions', 'contractor_profiles', 'deposit_batches']) {
      await client.query(policyBlock('24_complete_write_policies.sql', `aws_write_${name}`));
      await client.query(`CREATE POLICY aws_select_${name} ON public.${name} FOR SELECT TO authenticated USING (true)`);
    }
    await client.query(fs.readFileSync(SQL_80, 'utf8'));
    await client.query(sql35ManagerViews());

    /** One API request: a transaction as checksops (RLS on) for this user. */
    const as = async (user, fn) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await client.query('ROLLBACK');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const fn = (user, name, arg) => as(user, async () => (await client.query(`SELECT public.${name}($1::uuid) AS ok`, [arg])).rows[0].ok);
    const rowCount = (user, sql, params) => as(user, async () => (await client.query(sql, params)).rowCount);
    const saveAutoDeposit = (user, tenantId) => as(user, async () => (await client.query(
      'SELECT public.aws_save_checkalt_tenant_auto_deposit($1::uuid, $2::jsonb) AS result',
      [tenantId, JSON.stringify({ auto_approve_enabled: true })],
    )).rows[0].result);

    // Before SQL 90: the global admin/staff gate, and SQL 80's role tiers.
    assert.equal(await fn(OWNER, 'aws_can_write_tenant', TENANT_A), false);
    assert.equal(await fn(GLOBAL_ADMIN_VIEWER, 'aws_can_write_tenant', TENANT_A), true);
    await assert.rejects(saveAutoDeposit(VIEWER, TENANT_A), (error) => error.code === '42501');
    assert.equal(await fn(PLATFORM_OWNER, 'aws_can_write_tenant', TENANT_A), true);
    const saved80 = await saveAutoDeposit(PLATFORM_OWNER, TENANT_A);
    assert.equal(saved80.auto_approve_enabled, true);
    // SQL 35: a stored tenant owner reads the platform-wide Check Alt config.
    assert.equal(await rowCount(OWNER, 'SELECT merchant, fi_key FROM public.checkalt_config_public', []), 1);

    // Refuses to run without its prerequisites, and changes nothing.
    await client.query('BEGIN');
    await client.query('DROP FUNCTION public.aws_can_write_same_tenant_user(uuid) CASCADE');
    await assert.rejects(client.query(fs.readFileSync(SQL_90, 'utf8')), (error) => error.code === '55000' && /sql90_prerequisite_missing/.test(error.message));
    await client.query('ROLLBACK');
    // Production has no aws_can_access_tax_profiles (2026-10-17): SQL 90 creates it.
    await client.query('BEGIN');
    await client.query('DROP FUNCTION public.aws_can_access_tax_profiles(uuid) CASCADE');
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    assert.equal((await client.query("SELECT to_regprocedure('public.aws_can_access_tax_profiles(uuid)') IS NOT NULL AS present")).rows[0].present, true);
    await client.query('ROLLBACK');

    // Production's ACL on the SQL 35 helper (2026-10-17): PUBLIC and checksops, not authenticated.
    await client.query('REVOKE ALL ON FUNCTION public.aws_is_tenant_manager_admin() FROM PUBLIC, authenticated, checksops');
    await client.query('GRANT EXECUTE ON FUNCTION public.aws_is_tenant_manager_admin() TO PUBLIC, checksops');
    // Apply twice: idempotent.
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    // The replaced SQL 35 / SQL 29 helpers get the SQL 90 helper ACL even where PUBLIC had EXECUTE (production).
    let replacedHelpers = 0;
    for (const fnName of ['public.aws_is_tenant_manager_admin()', 'public.aws_can_manage_mortgage_library(uuid)']) {
      // Replaced only when present (SQL 29's helper is not in this fixture).
      if (!(await client.query('SELECT to_regprocedure($1) IS NOT NULL AS p', [fnName])).rows[0].p) continue;
      replacedHelpers += 1;
      const acl = (await client.query(`SELECT has_function_privilege('checksops', $1, 'EXECUTE') AS c, has_function_privilege('authenticated', $1, 'EXECUTE') AS a,
        EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure($1))) x WHERE x.grantee = 0) AS public_entry`, [fnName])).rows[0];
      assert.deepEqual(acl, { c: true, a: true, public_entry: false }, fnName);
    }
    assert.ok(replacedHelpers >= 1, 'at least the SQL 35 helper is in the fixture');

    // Every member (stored role viewer included) has every tenant right.
    for (const user of MEMBERS) {
      assert.equal(await fn(user, 'aws_is_tenant_member', TENANT_A), true, user);
      assert.equal(await fn(user, 'aws_can_write_tenant', TENANT_A), true, user);
      assert.equal(await fn(user, 'aws_can_write_same_tenant_user', TEAMMATE), true, user);
      assert.equal(await fn(user, 'aws_can_access_tax_profiles', TENANT_A), true, user);
      assert.equal(await rowCount(user, 'DELETE FROM public.tenant_users WHERE user_id = $1 AND tenant_id = $2', [TEAMMATE, TENANT_A]), 1, user);
      assert.equal(await rowCount(user, 'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_A, NEWCOMER, 'viewer']), 1, user);
      assert.equal(await rowCount(user, 'UPDATE public.tenants SET name = $1 WHERE id = $2', ['A2', TENANT_A]), 1, user);
      assert.equal(await rowCount(user, 'UPDATE public.recipient_tax_profiles SET tin = $1 WHERE tenant_id = $2', ['98-7654321', TENANT_A]), 1, user);
      const saved = await saveAutoDeposit(user, TENANT_A);
      assert.equal(saved.auto_approve_enabled, true, user);
    }

    // Partners / other tenants and global admin/staff without membership get nothing.
    for (const user of OUTSIDERS) {
      assert.equal(await fn(user, 'aws_can_write_tenant', TENANT_A), false, user);
      assert.equal(await fn(user, 'aws_can_write_same_tenant_user', TEAMMATE), false, user);
      assert.equal(await fn(user, 'aws_can_access_tax_profiles', TENANT_A), false, user);
      assert.equal(await rowCount(user, 'DELETE FROM public.tenant_users WHERE user_id = $1 AND tenant_id = $2', [TEAMMATE, TENANT_A]), 0, user);
      assert.equal(await rowCount(user, 'UPDATE public.tenants SET name = $1 WHERE id = $2', ['A2', TENANT_A]), 0, user);
      assert.equal(await rowCount(user, 'SELECT 1 FROM public.recipient_tax_profiles WHERE tenant_id = $1', [TENANT_A]), 0, user);
      await assert.rejects(saveAutoDeposit(user, TENANT_A), (error) => error.code === '42501', user);
      await assert.rejects(as(user, () => client.query(
        'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_A, NEWCOMER, 'viewer'],
      )), /row-level security/, user);
    }
    assert.equal(await fn(OWNER, 'aws_can_write_tenant', TENANT_B), false);
    assert.equal(await fn(B_OWNER, 'aws_can_write_tenant', TENANT_B), true);
    await assert.rejects(saveAutoDeposit(OWNER, TENANT_B), (error) => error.code === '42501');

    // Platform roles (user_roles): the platform owner only.
    for (const user of [...MEMBERS, ...OUTSIDERS]) {
      await assert.rejects(as(user, () => client.query(
        "INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [TEAMMATE],
      )), /row-level security/, user);
      assert.equal(await rowCount(user, 'DELETE FROM public.user_roles WHERE user_id = $1', [GLOBAL_ADMIN_VIEWER]), 0, user);
    }
    assert.equal(await rowCount(PLATFORM_OWNER, "INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'mortgage_agent')", [TEAMMATE]), 1);
    assert.equal(await rowCount(PLATFORM_OWNER, 'DELETE FROM public.user_roles WHERE user_id = $1', [GLOBAL_ADMIN_VIEWER]), 1);

    // The platform owner has no tenant write branch: tenant helpers, tenant
    // settings, email sender, team membership edits and Auto-Deposit refuse it.
    assert.equal(await fn(PLATFORM_OWNER, 'aws_can_write_tenant', TENANT_A), false);
    assert.equal(await fn(PLATFORM_OWNER, 'aws_can_write_check', CHECK_A), false);
    assert.equal(await fn(PLATFORM_OWNER, 'aws_can_write_claim', CLAIM_A), false);
    assert.equal(await fn(OWNER, 'aws_can_write_check', CHECK_A), true);
    assert.equal(await fn(VIEWER, 'aws_can_write_claim', CLAIM_A), true);
    assert.equal(await fn(B_OWNER, 'aws_can_write_check', CHECK_A), false);
    assert.equal(await rowCount(PLATFORM_OWNER, 'UPDATE public.tenants SET name = $1 WHERE id = $2', ['A2', TENANT_A]), 0);
    assert.equal(await rowCount(PLATFORM_OWNER, 'UPDATE public.tenant_email_settings SET from_name = $1 WHERE tenant_id = $2', ['X', TENANT_A]), 0);
    assert.equal(await rowCount(VIEWER, 'UPDATE public.tenant_email_settings SET from_name = $1 WHERE tenant_id = $2', ['X', TENANT_A]), 1);
    assert.equal(await rowCount(PLATFORM_OWNER, 'DELETE FROM public.tenant_users WHERE user_id = $1 AND tenant_id = $2', [TEAMMATE, TENANT_A]), 0);
    await assert.rejects(saveAutoDeposit(PLATFORM_OWNER, TENANT_A), (error) => error.code === '42501');

    // Tenant create stays with the platform owner.
    assert.equal(await rowCount(PLATFORM_OWNER, 'INSERT INTO public.tenants (id, name) VALUES (gen_random_uuid(), $1)', ['New']), 1);
    for (const user of [...MEMBERS, ...OUTSIDERS]) {
      await assert.rejects(as(user, () => client.query(
        'INSERT INTO public.tenants (id, name) VALUES (gen_random_uuid(), $1)', ['New'],
      )), /row-level security/, user);
    }

    // First invite only: the platform owner may add the first member of a
    // tenant with no members, never a member of a tenant that has members, and
    // never itself.
    assert.equal(await rowCount(PLATFORM_OWNER, 'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_EMPTY, NEWCOMER, 'viewer']), 1);
    await assert.rejects(as(PLATFORM_OWNER, () => client.query(
      'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_A, NEWCOMER, 'viewer'],
    )), /row-level security/);
    await assert.rejects(as(PLATFORM_OWNER, () => client.query(
      'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_EMPTY, PLATFORM_OWNER, 'viewer'],
    )), /row-level security/);
    // Two rows in one statement: the second is no longer a first invite.
    await assert.rejects(as(PLATFORM_OWNER, async () => {
      await client.query('INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_EMPTY, NEWCOMER, 'viewer']);
      await client.query('INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_EMPTY, TEAMMATE, 'viewer']);
    }), /row-level security/);
    // A member cannot add the platform owner either.
    await assert.rejects(as(OWNER, () => client.query(
      'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_A, PLATFORM_OWNER, 'viewer'],
    )), /row-level security/);
    assert.equal(await fn(PLATFORM_OWNER, 'aws_is_platform_owner_user', PLATFORM_OWNER), true);
    assert.equal(await fn(OWNER, 'aws_is_platform_owner_user', OWNER), false);
    assert.equal(await fn(OWNER, 'aws_tenant_has_no_members', TENANT_EMPTY), true);
    assert.equal(await fn(OWNER, 'aws_tenant_has_no_members', TENANT_A), false);

    // tenant_users rows are never updated under RLS (tenant_users.role included).
    for (const user of [...MEMBERS, PLATFORM_OWNER]) {
      assert.equal(await rowCount(user, "UPDATE public.tenant_users SET role = 'owner' WHERE tenant_id = $1", [TENANT_A]), 0, user);
    }

    // Check Alt setup (the tenant depositor row) is the platform owner's; members
    // change Auto-Deposit only through the DEFINER function.
    assert.equal(await rowCount(PLATFORM_OWNER, 'UPDATE public.checkalt_tenant_accounts SET auto_approve_max_cents = 1 WHERE tenant_id = $1', [TENANT_A]), 1);
    for (const user of [...MEMBERS, ...OUTSIDERS]) {
      assert.equal(await rowCount(user, 'UPDATE public.checkalt_tenant_accounts SET auto_approve_max_cents = 1 WHERE tenant_id = $1', [TENANT_A]), 0, user);
    }

    // SQL 35 views: the platform-wide Check Alt config is the platform owner's;
    // members see only provider name and status.
    assert.equal(await rowCount(PLATFORM_OWNER, 'SELECT merchant, fi_key FROM public.checkalt_config_public', []), 1);
    for (const user of [...MEMBERS, ...OUTSIDERS]) {
      assert.equal(await rowCount(user, 'SELECT merchant, fi_key FROM public.checkalt_config_public', []), 0, user);
    }
    const providers = (user) => as(user, async () => (await client.query(
      'SELECT provider, display_name, is_active, is_stubbed, capabilities FROM public.deposit_provider_config_public',
    )).rows);
    for (const user of MEMBERS) {
      const rows = await providers(user);
      assert.equal(rows.length, 1, user);
      assert.equal(rows[0].display_name, 'Check Alt');
      assert.equal(rows[0].is_active, true);
      assert.equal(rows[0].capabilities, null, user);
    }
    assert.deepEqual((await providers(PLATFORM_OWNER))[0].capabilities, { rdc: true });
    for (const user of [GLOBAL_ADMIN, GLOBAL_STAFF]) {
      assert.equal((await providers(user)).length, 0, user);
    }
    const viewColumns = (await client.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'deposit_provider_config_public' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
    assert.equal(viewColumns.includes('config'), false);

    // --- Concurrent first invites: exactly one commits. --------------------------
    {
      const connect = async () => {
        const c = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
        await c.connect();
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE checksops');
        await c.query("SELECT set_config('request.app_user_id', $1, true)", [PLATFORM_OWNER]);
        return c;
      };
      const first = await connect();
      const second = await connect();
      try {
        const insert = (c, user) => c.query(
          'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_EMPTY, user, 'viewer'],
        ).then((r) => r.rowCount, (error) => error);
        const a = await insert(first, RACE_A);
        // The second invite waits on the first-invite lock while the first is open.
        const pendingB = insert(second, RACE_B);
        const raced = await Promise.race([pendingB.then(() => 'finished'), new Promise((r) => { setTimeout(() => r('waiting'), 300); })]);
        assert.equal(raced, 'waiting');
        await first.query('COMMIT');
        const b = await pendingB;
        await second.query('ROLLBACK');
        assert.equal(a, 1);
        assert.ok(b instanceof Error && /row-level security/.test(b.message), String(b));
        const members = (await client.query('SELECT user_id FROM public.tenant_users WHERE tenant_id = $1', [TENANT_EMPTY])).rows;
        assert.deepEqual(members.map((r) => r.user_id), [RACE_A]);
      } finally {
        await first.end().catch(() => {});
        await second.end().catch(() => {});
        await client.query('DELETE FROM public.tenant_users WHERE tenant_id = $1', [TENANT_EMPTY]);
      }
      // The invite DEFINER takes the same lock: a concurrent first invite through it is refused too.
      const third = await connect();
      const fourth = await connect();
      try {
        const viaDefiner = (c, email) => c.query(
          'SELECT public.aws_invite_create_user_identity($1::uuid, $2, $3, $4) AS id', [TENANT_EMPTY, email, 'X', `sub-${email}`],
        ).then(async (r) => {
          await c.query('INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_EMPTY, r.rows[0].id, 'viewer']);
          return 'ok';
        }, (error) => error);
        const x = await viaDefiner(third, 'first@example.com');
        const pendingY = viaDefiner(fourth, 'second@example.com');
        await third.query('COMMIT');
        const y = await pendingY;
        await fourth.query('ROLLBACK');
        assert.equal(x, 'ok');
        assert.ok(y instanceof Error && y.code === '42501', String(y));
        assert.equal((await client.query('SELECT count(*)::int AS n FROM public.tenant_users WHERE tenant_id = $1', [TENANT_EMPTY])).rows[0].n, 1);
      } finally {
        await third.end().catch(() => {});
        await fourth.end().catch(() => {});
        await client.query('DELETE FROM public.tenant_users WHERE tenant_id = $1', [TENANT_EMPTY]);
      }
    }

    // --- Invite of a brand-new email under RLS. -----------------------------------
    const inviteIdentity = (user, tenantId, email, sub) => as(user, async () => (await client.query(
      'SELECT public.aws_invite_create_user_identity($1::uuid, $2, $3, $4)::text AS id', [tenantId, email, 'New Person', sub],
    )).rows[0].id);
    // A member's direct profiles INSERT for someone who is not a teammate yet is refused by aws_write_profiles.
    await assert.rejects(as(VIEWER, () => client.query(
      "INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'fresh@example.com')",
    )), /row-level security/);
    // Through the DEFINER, any member (stored role viewer) invites a new email end to end.
    const invited = await as(VIEWER, async () => {
      const id = (await client.query(
        'SELECT public.aws_invite_create_user_identity($1::uuid, $2, $3, $4)::text AS id', [TENANT_A, ' Fresh@Example.com ', 'Fresh', 'sub-fresh'],
      )).rows[0].id;
      const profile = (await client.query('SELECT public.aws_is_platform_owner_user($1::uuid) AS owner', [id])).rows[0];
      const link = (await client.query('SELECT application_user_id::text AS id, email, status FROM public.identity_accounts WHERE cognito_sub = $1', ['sub-fresh'])).rows[0];
      const inserted = (await client.query('INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_A, id, 'viewer'])).rowCount;
      return { id, owner: profile.owner, link, inserted };
    });
    assert.match(invited.id, /^[0-9a-f-]{36}$/);
    assert.equal(invited.owner, false);
    assert.deepEqual(invited.link, { id: invited.id, email: 'fresh@example.com', status: 'active' });
    assert.equal(invited.inserted, 1);
    // Non-members (another tenant, a global admin) are refused.
    for (const user of [B_OWNER, GLOBAL_ADMIN, GLOBAL_STAFF]) {
      await assert.rejects(inviteIdentity(user, TENANT_A, 'fresh@example.com', 'sub-fresh'), (error) => error.code === '42501', user);
    }
    // The platform owner: a first invite into an empty tenant only.
    assert.match(await inviteIdentity(PLATFORM_OWNER, TENANT_EMPTY, 'fresh@example.com', 'sub-fresh'), /^[0-9a-f-]{36}$/);
    await assert.rejects(inviteIdentity(PLATFORM_OWNER, TENANT_A, 'fresh@example.com', 'sub-fresh'), (error) => error.code === '42501');
    // Never the platform owner: by email, or by a login already linked to it.
    await assert.rejects(inviteIdentity(OWNER, TENANT_A, 'ChecksOpsAdmin@gmail.com', 'sub-x'), (error) => error.code === '42501' && /platform_owner/.test(error.message));
    await assert.rejects(inviteIdentity(OWNER, TENANT_A, 'alias@example.com', `sub-${PLATFORM_OWNER}`), (error) => error.code === '42501' && /platform_owner/.test(error.message));
    // An existing login keeps its user; an email linked to another login is never re-pointed.
    assert.equal(await inviteIdentity(OWNER, TENANT_A, 'other@example.com', `sub-${TEAMMATE}`), TEAMMATE);
    await assert.rejects(inviteIdentity(OWNER, TENANT_A, 't@example.com', 'sub-new-login'), /identity_link_conflict/);
    assert.equal((await client.query('SELECT cognito_sub FROM public.identity_accounts WHERE application_user_id = $1', [TEAMMATE])).rows[0].cognito_sub, `sub-${TEAMMATE}`);

    // --- The platform owner no longer writes other users' user-scoped rows. -------
    assert.equal(await rowCount(PLATFORM_OWNER, 'UPDATE public.pii_reveal_logs SET field_name = $1 WHERE user_id = $2', ['x', TEAMMATE]), 0);
    assert.equal(await rowCount(PLATFORM_OWNER, 'DELETE FROM public.pii_reveal_logs WHERE user_id = $1', [TEAMMATE]), 0);
    assert.equal(await rowCount(PLATFORM_OWNER, 'UPDATE public.user_sessions SET is_active = false WHERE user_id = $1', [TEAMMATE]), 0);
    for (const table of ['pii_reveal_logs', 'user_sessions']) {
      await assert.rejects(as(PLATFORM_OWNER, () => client.query(`INSERT INTO public.${table} (user_id) VALUES ($1)`, [TEAMMATE])), /row-level security/, table);
    }
    // Its own rows, and a teammate's rows for members, still work.
    assert.equal(await rowCount(PLATFORM_OWNER, 'INSERT INTO public.user_sessions (user_id) VALUES ($1)', [PLATFORM_OWNER]), 1);
    assert.equal(await rowCount(VIEWER, 'UPDATE public.user_sessions SET is_active = false WHERE user_id = $1', [TEAMMATE]), 1);
    // Kept, per table: contractor_profiles UPDATE (Pro approval) and profiles INSERT (agent hire).
    assert.equal(await rowCount(PLATFORM_OWNER, "UPDATE public.contractor_profiles SET tier = 'pro' WHERE user_id = $1", [TEAMMATE]), 1);
    assert.equal(await rowCount(PLATFORM_OWNER, 'DELETE FROM public.contractor_profiles WHERE user_id = $1', [TEAMMATE]), 0);
    assert.equal(await rowCount(PLATFORM_OWNER, "INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'agent@example.com')", []), 1);
    assert.equal(await rowCount(PLATFORM_OWNER, "UPDATE public.profiles SET full_name = 'x' WHERE id = $1", [TEAMMATE]), 0);

    // --- assign_provider without a batch: the DEFINER creates it for members. ------
    const createBatch = (user, item) => as(user, async () => (await client.query(
      "SELECT public.aws_create_deposit_batch_for_item($1::uuid, 'manual_branch')::text AS id", [item],
    )).rows[0].id);
    // Why a function: a member's direct INSERT of an empty batch cannot pass RLS.
    await assert.rejects(as(OWNER, () => client.query(
      "INSERT INTO public.deposit_batches (provider, total_items, total_amount, created_by) VALUES ('manual_branch', 1, 25, $1)", [OWNER],
    )), /row-level security/);
    for (const user of MEMBERS) {
      const batch = await as(user, async () => {
        const id = (await client.query("SELECT public.aws_create_deposit_batch_for_item($1::uuid, 'manual_branch')::text AS id", [DEPOSIT_PENDING])).rows[0].id;
        return (await client.query('SELECT total_items, total_amount::int AS amount, created_by::text AS by FROM public.deposit_batches WHERE id = $1', [id])).rows[0];
      });
      assert.deepEqual(batch, { total_items: 1, amount: 25, by: user }, user);
    }
    for (const user of [...OUTSIDERS, PLATFORM_OWNER]) {
      await assert.rejects(createBatch(user, DEPOSIT_PENDING), (error) => error.code === '42501', user);
    }
    await assert.rejects(createBatch(OWNER, DEPOSIT_ASSIGNED), /invalid_status/);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.deposit_batches')).rows[0].n, 0);

    // Data is not rewritten: the stored role values are left as they were.
    const roles = (await client.query('SELECT role FROM public.tenant_users ORDER BY role')).rows.map((r) => r.role);
    assert.ok(roles.includes('viewer') && roles.includes('operator') && roles.includes('owner'));

    // Helpers are SECURITY DEFINER with a fixed search_path and row_security off.
    const defs = (await client.query(`
      SELECT p.proname, p.prosecdef, p.proconfig
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('aws_is_tenant_member', 'aws_can_write_tenant',
                           'aws_can_write_same_tenant_user', 'aws_can_access_tax_profiles',
                           'aws_save_checkalt_tenant_auto_deposit')
       ORDER BY p.proname`)).rows;
    assert.equal(defs.length, 5);
    for (const row of defs) {
      assert.equal(row.prosecdef, true, row.proname);
      assert.ok(row.proconfig.includes('search_path=public'), row.proname);
      assert.ok(row.proconfig.includes('row_security=off'), row.proname);
    }

    // --- SQL 93 on top of SQL 90: one members-only tenants UPDATE policy, and
    // a column guard so a member cannot change sensitive tenants columns. ----
    await client.query(`ALTER TABLE public.tenants
      ADD COLUMN slug text, ADD COLUMN moov_environment text, ADD COLUMN payment_provider text,
      ADD COLUMN moov_allowlisted boolean NOT NULL DEFAULT false, ADD COLUMN is_test_account boolean NOT NULL DEFAULT false,
      ADD COLUMN is_system_tenant boolean, ADD COLUMN ein text, ADD COLUMN kyc_status text NOT NULL DEFAULT 'pending',
      ADD COLUMN monthly_rate_cents integer NOT NULL DEFAULT 0, ADD COLUMN logo_url text, ADD COLUMN primary_color text,
      ADD COLUMN invoice_footer_note text, ADD COLUMN business_address text, ADD COLUMN business_phone text,
      ADD COLUMN email_reply_to text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`);
    await client.query(`UPDATE public.tenants SET slug = 'a', moov_environment = 'sandbox', payment_provider = 'moov' WHERE id = '${TENANT_A}'`);
    // The permissive branding policy an earlier SQL 93 draft created.
    await client.query(`CREATE POLICY aws_member_update_tenant_branding ON public.tenants FOR UPDATE TO authenticated
      USING (public.aws_is_authenticated() AND id IN (SELECT public.aws_user_tenant_ids()))
      WITH CHECK (public.aws_is_authenticated() AND id IN (SELECT public.aws_user_tenant_ids()))`);
    // SQL 93 refuses to run without SQL 90's tenants UPDATE policy.
    await client.query('BEGIN');
    await client.query('DROP POLICY aws_write_tenants ON public.tenants');
    await assert.rejects(client.query(fs.readFileSync(SQL_93, 'utf8')),
      (error) => error.code === '55000' && /sql93_prerequisite_missing/.test(error.message));
    await client.query('ROLLBACK');
    await client.query(fs.readFileSync(SQL_93, 'utf8'));
    await client.query(fs.readFileSync(SQL_93, 'utf8'));
    const tenantWritePolicies = (await client.query(`
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'tenants' AND cmd IN ('UPDATE', 'ALL')
       ORDER BY policyname`)).rows.map((r) => r.policyname);
    assert.deepEqual(tenantWritePolicies, ['aws_write_tenants']);

    const guardRefused = (error) => error.code === '42501' && /tenant_column_not_member_writable/.test(error.message);
    for (const user of MEMBERS) {
      assert.equal(await rowCount(user,
        `UPDATE public.tenants SET name = $1, company_address = $2, company_phone = $3, company_email = $4,
           letterhead_url = $5, logo_url = $6, primary_color = $7, invoice_footer_note = $8, updated_at = now()
         WHERE id = $9`,
        ['A3', '1 Main St', '555-0100', 'a@example.com', 'x/letterhead.png', 'x/logo.png', '#123456', 'Thanks', TENANT_A]), 1, user);
      for (const [column, value] of [
        ['slug', 'a-new'], ['moov_environment', 'production'], ['payment_provider', 'other'],
        ['moov_allowlisted', true], ['is_test_account', true], ['is_system_tenant', true],
        ['ein', '12-3456789'], ['kyc_status', 'approved'], ['monthly_rate_cents', 0 + 1],
        ['business_address', '9 KYC Rd'], ['business_phone', '555-0199'], ['email_reply_to', 'r@example.com'],
      ]) {
        await assert.rejects(rowCount(user, `UPDATE public.tenants SET ${column} = $1 WHERE id = $2`, [value, TENANT_A]),
          guardRefused, `${user} ${column}`);
      }
      // An allowed column next to a sensitive one is refused as a whole.
      await assert.rejects(rowCount(user, 'UPDATE public.tenants SET name = $1, slug = $2 WHERE id = $3', ['A4', 'a-4', TENANT_A]),
        guardRefused, user);
      // Writing a sensitive column's current value changes nothing and is not refused.
      assert.equal(await rowCount(user, "UPDATE public.tenants SET slug = 'a', name = 'A5' WHERE id = $1", [TENANT_A]), 1, user);
    }
    // Partners, other tenants, global admin/staff and the platform owner still update nothing.
    for (const user of [...OUTSIDERS, PLATFORM_OWNER]) {
      assert.equal(await rowCount(user, 'UPDATE public.tenants SET name = $1 WHERE id = $2', ['A6', TENANT_A]), 0, user);
    }
    // Server-side writes with no end-user caller (table owner, no request.app_user_id) are not limited.
    assert.equal((await client.query(`UPDATE public.tenants SET moov_environment = 'production' WHERE id = '${TENANT_A}'`)).rowCount, 1);

    // --- SQL 96 on top of SQL 90 + SQL 93: the platform owner sets pricing
    // through a DEFINER setter; members never change pricing; every change is
    // audited. (mortgage_ops_* rate columns are left absent on purpose.) ----
    await client.query(`ALTER TABLE public.tenants
      ADD COLUMN referral_discount_cents integer NOT NULL DEFAULT 0, ADD COLUMN is_founding_partner boolean NOT NULL DEFAULT false,
      ADD COLUMN per_check_billing_enabled boolean DEFAULT false, ADD COLUMN per_check_rate_cents integer DEFAULT 0,
      ADD COLUMN next_day_rate_cents integer, ADD COLUMN same_day_rate_cents integer`);
    await client.query(`CREATE TABLE public.platform_fee_schedules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, name text NOT NULL DEFAULT 'fees',
      amount_cents bigint NOT NULL DEFAULT 0)`);
    await client.query('ALTER TABLE public.platform_fee_schedules ENABLE ROW LEVEL SECURITY');
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_fee_schedules TO checksops');
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_platform_fee_schedules'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_platform_fee_schedules'));
    await client.query(`INSERT INTO public.platform_fee_schedules (tenant_id, amount_cents) VALUES ('${TENANT_A}', 500)`);
    // Before SQL 96 (SQL 24 + SQL 90): any member could rewrite its own fee schedule.
    assert.equal(await rowCount(VIEWER, 'UPDATE public.platform_fee_schedules SET amount_cents = 0 WHERE tenant_id = $1', [TENANT_A]), 1);

    // Refuses to run without SQL 93's guard.
    await client.query('BEGIN');
    await client.query('DROP TRIGGER aws_tenants_member_column_guard ON public.tenants');
    await assert.rejects(client.query(fs.readFileSync(SQL_96, 'utf8')),
      (error) => error.code === '55000' && /sql96_prerequisite_missing/.test(error.message));
    await client.query('ROLLBACK');
    await client.query(fs.readFileSync(SQL_96, 'utf8'));
    await client.query(fs.readFileSync(SQL_96, 'utf8'));
    // Still exactly one tenants UPDATE policy (SQL 90's, members only).
    assert.deepEqual((await client.query(`
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'tenants' AND cmd IN ('UPDATE', 'ALL')`)).rows.map((r) => r.policyname),
    ['aws_write_tenants']);

    const setPricing = (user, tenantId, pricing) => as(user, async () => (await client.query(
      'SELECT public.aws_platform_owner_set_tenant_pricing($1::uuid, $2::jsonb) AS result',
      [tenantId, JSON.stringify(pricing)],
    )).rows[0].result);
    const pricingOf = async (tenantId) => (await client.query(
      `SELECT monthly_rate_cents, referral_discount_cents, is_founding_partner, per_check_billing_enabled,
              per_check_rate_cents, next_day_rate_cents, same_day_rate_cents, name, slug
         FROM public.tenants WHERE id = $1`, [tenantId])).rows[0];
    const auditCount = async () => (await client.query('SELECT count(*)::int AS n FROM public.tenant_pricing_audit')).rows[0].n;

    // The platform owner sets every pricing column present (committed so the audit is visible).
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE checksops');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [PLATFORM_OWNER]);
    const set = (await client.query('SELECT public.aws_platform_owner_set_tenant_pricing($1::uuid, $2::jsonb) AS r', [TENANT_A, JSON.stringify({
      monthly_rate_cents: 9900, referral_discount_cents: 1000, is_founding_partner: true,
      per_check_billing_enabled: true, per_check_rate_cents: 300, next_day_rate_cents: 75, same_day_rate_cents: 100,
    })])).rows[0].r;
    await client.query('COMMIT');
    assert.equal(set.ok, true);
    assert.deepEqual(set.updated.sort(), ['is_founding_partner', 'monthly_rate_cents', 'next_day_rate_cents',
      'per_check_billing_enabled', 'per_check_rate_cents', 'referral_discount_cents', 'same_day_rate_cents']);
    const priced = await pricingOf(TENANT_A);
    assert.equal(priced.monthly_rate_cents, 9900);
    assert.equal(priced.referral_discount_cents, 1000);
    assert.equal(priced.is_founding_partner, true);
    assert.equal(priced.per_check_billing_enabled, true);
    assert.equal(priced.per_check_rate_cents, 300);
    assert.equal(priced.next_day_rate_cents, 75);
    assert.equal(priced.same_day_rate_cents, 100);
    // Audit: one row per changed field, with who, tenant and old -> new.
    const audit = (await client.query(
      'SELECT tenant_id, actor_id, field, old_value, new_value FROM public.tenant_pricing_audit ORDER BY field')).rows;
    assert.equal(audit.length, 7);
    const monthly = audit.find((r) => r.field === 'monthly_rate_cents');
    assert.equal(monthly.tenant_id, TENANT_A);
    assert.equal(monthly.actor_id, PLATFORM_OWNER);
    assert.equal(monthly.old_value, 0);
    assert.equal(monthly.new_value, 9900);
    assert.equal(audit.find((r) => r.field === 'is_founding_partner').new_value, true);
    // Setting the same values again changes nothing and writes no audit row.
    await setPricing(PLATFORM_OWNER, TENANT_A, { monthly_rate_cents: 9900 });
    assert.equal(await auditCount(), 7);

    // The platform owner is refused on every non-pricing column, through the
    // setter and through a direct UPDATE (no tenants row matches its RLS).
    const refusedField = (error) => error.code === '22023' && /invalid_field/.test(error.message);
    for (const column of ['name', 'slug', 'logo_url', 'company_address', 'moov_environment', 'payment_provider',
      'moov_allowlisted', 'is_test_account', 'is_system_tenant', 'ein', 'kyc_status', 'updated_at']) {
      await assert.rejects(setPricing(PLATFORM_OWNER, TENANT_A, { [column]: column === 'moov_allowlisted' ? true : 'x' }), refusedField, column);
    }
    await assert.rejects(setPricing(PLATFORM_OWNER, TENANT_A, { monthly_rate_cents: 100, slug: 'x' }), refusedField);
    assert.equal(await rowCount(PLATFORM_OWNER, 'UPDATE public.tenants SET name = $1 WHERE id = $2', ['P', TENANT_A]), 0);
    assert.equal(await rowCount(PLATFORM_OWNER, 'UPDATE public.tenants SET monthly_rate_cents = 1 WHERE id = $1', [TENANT_A]), 0);
    // Bad values and absent columns are refused; nothing changed.
    for (const pricing of [{ monthly_rate_cents: -1 }, { monthly_rate_cents: 1.5 }, { monthly_rate_cents: '100' },
      { is_founding_partner: 'yes' }, { per_check_rate_cents: 2000000000 }]) {
      await assert.rejects(setPricing(PLATFORM_OWNER, TENANT_A, pricing),
        (error) => error.code === '22023' && /invalid_value/.test(error.message), JSON.stringify(pricing));
    }
    await assert.rejects(setPricing(PLATFORM_OWNER, TENANT_A, { mortgage_ops_initial_rate_cents: 100 }),
      (error) => error.code === '22023' && /column_not_present/.test(error.message));
    await assert.rejects(setPricing(PLATFORM_OWNER, '99999999-9999-4999-8999-999999999999', { monthly_rate_cents: 1 }),
      (error) => error.code === 'P0002');
    assert.equal((await pricingOf(TENANT_A)).monthly_rate_cents, 9900);
    assert.equal((await pricingOf(TENANT_A)).slug, 'a');

    // Members (stored role viewer included) never change pricing: not through
    // the setter, not with a direct UPDATE (SQL 93/96 guard). Branding still saves.
    const guardRefusedAgain = (error) => error.code === '42501' && /tenant_column_not_member_writable/.test(error.message);
    for (const user of MEMBERS) {
      await assert.rejects(setPricing(user, TENANT_A, { monthly_rate_cents: 1 }),
        (error) => error.code === '42501' && /not_authorized/.test(error.message), user);
      for (const [column, value] of [['monthly_rate_cents', 1], ['referral_discount_cents', 0], ['is_founding_partner', false],
        ['per_check_billing_enabled', false], ['per_check_rate_cents', 0], ['next_day_rate_cents', 0], ['same_day_rate_cents', 0]]) {
        await assert.rejects(rowCount(user, `UPDATE public.tenants SET ${column} = $1 WHERE id = $2`, [value, TENANT_A]),
          guardRefusedAgain, `${user} ${column}`);
      }
      assert.equal(await rowCount(user, 'UPDATE public.tenants SET name = $1 WHERE id = $2', ['A7', TENANT_A]), 1, user);
    }
    // Partners / other tenants and global admin/staff: refused by the setter, no row by UPDATE.
    for (const user of OUTSIDERS) {
      await assert.rejects(setPricing(user, TENANT_A, { monthly_rate_cents: 1 }), (error) => error.code === '42501', user);
      assert.equal(await rowCount(user, 'UPDATE public.tenants SET monthly_rate_cents = 1 WHERE id = $1', [TENANT_A]), 0, user);
    }
    // B's owner on its own tenant: still a member, still no pricing.
    await assert.rejects(rowCount(B_OWNER, 'UPDATE public.tenants SET monthly_rate_cents = 1 WHERE id = $1', [TENANT_B]), guardRefusedAgain);
    assert.equal((await pricingOf(TENANT_A)).monthly_rate_cents, 9900);
    assert.equal(await auditCount(), 7);

    // The audit is append-only and the platform owner's to read.
    for (const user of [...MEMBERS, ...OUTSIDERS]) {
      assert.equal(await rowCount(user, 'SELECT 1 FROM public.tenant_pricing_audit', []), 0, user);
      await assert.rejects(rowCount(user, `INSERT INTO public.tenant_pricing_audit (tenant_id, field) VALUES ($1, 'x')`, [TENANT_A]),
        /permission denied/, user);
    }
    assert.equal(await rowCount(PLATFORM_OWNER, 'SELECT 1 FROM public.tenant_pricing_audit', []), 7);
    await assert.rejects(rowCount(PLATFORM_OWNER, 'DELETE FROM public.tenant_pricing_audit', []), /permission denied/);

    // platform_fee_schedules: the platform owner writes; members only read.
    for (const user of MEMBERS) {
      assert.equal(await rowCount(user, 'UPDATE public.platform_fee_schedules SET amount_cents = 1 WHERE tenant_id = $1', [TENANT_A]), 0, user);
      await assert.rejects(rowCount(user, 'INSERT INTO public.platform_fee_schedules (tenant_id) VALUES ($1)', [TENANT_A]),
        /row-level security/, user);
      assert.equal(await rowCount(user, 'SELECT 1 FROM public.platform_fee_schedules WHERE tenant_id = $1', [TENANT_A]), 1, user);
    }
    for (const user of OUTSIDERS) {
      assert.equal(await rowCount(user, 'UPDATE public.platform_fee_schedules SET amount_cents = 1 WHERE tenant_id = $1', [TENANT_A]), 0, user);
    }
    assert.equal(await rowCount(PLATFORM_OWNER, 'UPDATE public.platform_fee_schedules SET amount_cents = 700 WHERE tenant_id = $1', [TENANT_A]), 1);
  } finally {
    await client.end().catch(() => {});
    server.stop();
  }
});

test('SQL 90 file: membership-only helpers, no role tiers, no user_roles admin/staff clause, no enum or data change', () => {
  const sql = fs.readFileSync(SQL_90, 'utf8');
  const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /has_role\(/);
  assert.doesNotMatch(code, /role::text\)? ?IN/);
  assert.doesNotMatch(code, /'(owner|manager|operator|viewer)'/);
  assert.doesNotMatch(code, /ALTER TYPE|UPDATE public\.tenant_users/);
  assert.doesNotMatch(code, /^\s*(BEGIN|COMMIT)\s*;/im);
  assert.match(code, /CREATE POLICY aws_write_user_roles ON public\.user_roles[\s\S]*?is_platform_owner\(\)/);
  // The platform owner has no tenant write branch in the tenant helpers.
  for (const name of ['aws_can_write_tenant', 'aws_can_write_check', 'aws_can_write_claim']) {
    const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const body = code.slice(start, code.indexOf('$$;', start));
    assert.doesNotMatch(body, /cross_tenant_reader|is_platform_owner|is_master_owner/, name);
  }
  // Policies replaced without the cross-tenant-reader branch.
  for (const policy of ['aws_insert_tenant_users', 'aws_delete_tenant_users', 'aws_write_tenants',
    'aws_write_tenant_email_settings', 'aws_write_deposit_batches', 'aws_write_homeowner_check_uploads',
    'aws_write_referral_events', 'aws_write_tenant_partnerships']) {
    const start = code.indexOf(`CREATE POLICY ${policy} ON`);
    assert.ok(start >= 0, policy);
    const end = code.indexOf(policy.startsWith('aws_insert') || policy.startsWith('aws_delete') || policy === 'aws_write_tenants' ? ';' : "';", start);
    assert.doesNotMatch(code.slice(start, end), /cross_tenant_reader/, policy);
  }
  // No tenant_users UPDATE policy: tenant_users.role cannot be changed under RLS.
  assert.doesNotMatch(code, /CREATE POLICY \w+ ON public\.tenant_users\s+FOR (ALL|UPDATE)/);
  for (const name of ['aws_is_tenant_member', 'aws_can_write_tenant', 'aws_can_write_same_tenant_user', 'aws_can_access_tax_profiles']) {
    const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    assert.ok(start >= 0, name);
    const body = code.slice(start, code.indexOf('$$;', start));
    assert.match(body, /SECURITY DEFINER\nSET search_path = public\nSET row_security = off/, name);
  }
});
