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
const SQL_80 = path.join(AWS_ROOT, 'workflows/sql/80_checkalt_member_auto_deposit.sql');

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

const MEMBERS = [OWNER, OPERATOR, VIEWER, GLOBAL_ADMIN_VIEWER];
const OUTSIDERS = [GLOBAL_ADMIN, GLOBAL_STAFF, B_OWNER];

const SEED = `
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
CREATE TABLE public.checkalt_tenant_accounts (
  tenant_id uuid PRIMARY KEY, auto_approve_enabled boolean NOT NULL DEFAULT false,
  auto_approve_max_cents integer, updated_at timestamptz DEFAULT now());
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
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
    for (const table of ['tenant_users', 'tenants', 'recipient_tax_profiles', 'user_roles']) {
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
    await client.query(fs.readFileSync(SQL_80, 'utf8'));

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

    // Refuses to run without its prerequisites, and changes nothing.
    await client.query('BEGIN');
    await client.query('DROP FUNCTION public.aws_can_access_tax_profiles(uuid) CASCADE');
    await assert.rejects(client.query(fs.readFileSync(SQL_90, 'utf8')), (error) => error.code === '55000' && /sql90_prerequisite_missing/.test(error.message));
    await client.query('ROLLBACK');

    // Apply twice: idempotent.
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    await client.query(fs.readFileSync(SQL_90, 'utf8'));

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
  for (const name of ['aws_is_tenant_member', 'aws_can_write_tenant', 'aws_can_write_same_tenant_user', 'aws_can_access_tax_profiles']) {
    const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    assert.ok(start >= 0, name);
    const body = code.slice(start, code.indexOf('$$;', start));
    assert.match(body, /SECURITY DEFINER\nSET search_path = public\nSET row_security = off/, name);
  }
});
