/**
 * SQL 90 (users only, tenant roles decide) against PostgreSQL 16: the real AWS
 * RLS helper files (aws/rls/sql), the real tenant_users / tenants policies, then
 * the real aws/workflows/sql/90_users_only_tenant_roles.sql file.
 *
 * Owner policy: owner, admin, manager and operator act; viewers and partners do
 * not. Team management (tenant_users, tenant settings, tax profiles) is owner
 * and admin only. A global user_roles admin/staff gets nothing inside a tenant
 * it is not an acting member of. The platform owner is unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';

const SQL_90 = path.join(AWS_ROOT, 'workflows/sql/90_users_only_tenant_roles.sql');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const ADMIN = 'a1000000-0000-4000-8000-000000000002';
const MANAGER = 'a1000000-0000-4000-8000-000000000003';
const OPERATOR = 'a1000000-0000-4000-8000-000000000004';
const VIEWER = 'a1000000-0000-4000-8000-000000000005';
const GLOBAL_ADMIN_VIEWER = 'a1000000-0000-4000-8000-000000000006';
const GLOBAL_ADMIN = 'a1000000-0000-4000-8000-000000000007';
const GLOBAL_STAFF = 'a1000000-0000-4000-8000-000000000008';
const B_OWNER = 'a1000000-0000-4000-8000-000000000009';
const TEAMMATE = 'a1000000-0000-4000-8000-00000000000a';

const SEED = `
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
INSERT INTO public.identity_accounts (application_user_id, status) VALUES
  ('${OWNER}', 'active'), ('${ADMIN}', 'active'), ('${MANAGER}', 'active'), ('${OPERATOR}', 'active'),
  ('${VIEWER}', 'active'), ('${GLOBAL_ADMIN_VIEWER}', 'active'), ('${GLOBAL_ADMIN}', 'active'),
  ('${GLOBAL_STAFF}', 'active'), ('${B_OWNER}', 'active'), ('${TEAMMATE}', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${GLOBAL_ADMIN_VIEWER}', 'admin'), ('${GLOBAL_ADMIN}', 'admin'), ('${GLOBAL_STAFF}', 'staff');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${OWNER}', 'owner'), ('${TENANT_A}', '${ADMIN}', 'admin'),
  ('${TENANT_A}', '${MANAGER}', 'manager'), ('${TENANT_A}', '${OPERATOR}', 'operator'),
  ('${TENANT_A}', '${VIEWER}', 'viewer'), ('${TENANT_A}', '${GLOBAL_ADMIN_VIEWER}', 'viewer'),
  ('${TENANT_A}', '${TEAMMATE}', 'operator'), ('${TENANT_B}', '${B_OWNER}', 'owner');
INSERT INTO public.recipient_tax_profiles (tenant_id, recipient_key, tin) VALUES ('${TENANT_A}', 'acct:1', '12-3456789');
`;

test('PostgreSQL 16: SQL 90 makes tenant roles decide writes and drops the global admin/staff gate', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql90-roles-', 55400);
  const client = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  try {
    await applyBaseSchema(client);
    await client.query(SEED);
    for (const table of ['tenant_users', 'tenants', 'recipient_tax_profiles']) {
      await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO checksops`);
    }
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_tenant_users'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_tenants'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_tenant_users'));
    await client.query(policyBlock('21_proposed_write_policies.sql', 'aws_write_tenants'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_recipient_tax_profiles'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_recipient_tax_profiles'));

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

    // Before SQL 90: the global admin/staff gate. An invited owner cannot write;
    // a global admin who is only a viewer can.
    assert.equal(await fn(OWNER, 'aws_can_write_tenant', TENANT_A), false);
    assert.equal(await fn(GLOBAL_ADMIN_VIEWER, 'aws_can_write_tenant', TENANT_A), true);

    // Refuses to run without its prerequisites, and changes nothing.
    await client.query('BEGIN');
    await client.query('DROP FUNCTION public.aws_can_access_tax_profiles(uuid) CASCADE');
    await assert.rejects(client.query(fs.readFileSync(SQL_90, 'utf8')), (error) => error.code === '55000' && /sql90_prerequisite_missing/.test(error.message));
    await client.query('ROLLBACK');

    // Apply twice: idempotent.
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    await client.query(fs.readFileSync(SQL_90, 'utf8'));

    // Acting roles write the tenant; viewers, partners and global admin/staff do not.
    for (const user of [OWNER, ADMIN, MANAGER, OPERATOR]) {
      assert.equal(await fn(user, 'aws_can_write_tenant', TENANT_A), true, user);
      assert.equal(await fn(user, 'aws_is_tenant_actor', TENANT_A), true, user);
    }
    for (const user of [VIEWER, GLOBAL_ADMIN_VIEWER, GLOBAL_ADMIN, GLOBAL_STAFF, B_OWNER]) {
      assert.equal(await fn(user, 'aws_can_write_tenant', TENANT_A), false, user);
    }
    // Other tenant: an owner of A has no write in B.
    assert.equal(await fn(OWNER, 'aws_can_write_tenant', TENANT_B), false);
    assert.equal(await fn(B_OWNER, 'aws_can_write_tenant', TENANT_B), true);

    // Team management: owner and admin only.
    for (const user of [OWNER, ADMIN]) {
      assert.equal(await fn(user, 'aws_is_tenant_team_manager', TENANT_A), true, user);
      assert.equal(await fn(user, 'aws_can_write_same_tenant_user', TEAMMATE), true, user);
      assert.equal(await fn(user, 'aws_can_access_tax_profiles', TENANT_A), true, user);
      assert.equal(await rowCount(user, 'UPDATE public.tenant_users SET role = $1 WHERE user_id = $2 AND tenant_id = $3', ['viewer', TEAMMATE, TENANT_A]), 1, user);
      assert.equal(await rowCount(user, 'DELETE FROM public.tenant_users WHERE user_id = $1 AND tenant_id = $2', [TEAMMATE, TENANT_A]), 1, user);
      assert.equal(await rowCount(user, 'UPDATE public.tenants SET name = $1 WHERE id = $2', ['A2', TENANT_A]), 1, user);
      assert.equal(await rowCount(user, 'UPDATE public.recipient_tax_profiles SET tin = $1 WHERE tenant_id = $2', ['98-7654321', TENANT_A]), 1, user);
    }
    for (const user of [MANAGER, OPERATOR, VIEWER, GLOBAL_ADMIN_VIEWER, GLOBAL_ADMIN, GLOBAL_STAFF, B_OWNER]) {
      assert.equal(await fn(user, 'aws_is_tenant_team_manager', TENANT_A), false, user);
      assert.equal(await fn(user, 'aws_can_write_same_tenant_user', TEAMMATE), false, user);
      assert.equal(await fn(user, 'aws_can_access_tax_profiles', TENANT_A), false, user);
      assert.equal(await rowCount(user, 'UPDATE public.tenant_users SET role = $1 WHERE user_id = $2 AND tenant_id = $3', ['viewer', TEAMMATE, TENANT_A]), 0, user);
      assert.equal(await rowCount(user, 'DELETE FROM public.tenant_users WHERE user_id = $1 AND tenant_id = $2', [TEAMMATE, TENANT_A]), 0, user);
      assert.equal(await rowCount(user, 'UPDATE public.tenants SET name = $1 WHERE id = $2', ['A2', TENANT_A]), 0, user);
      assert.equal(await rowCount(user, 'SELECT 1 FROM public.recipient_tax_profiles WHERE tenant_id = $1', [TENANT_A]), 0, user);
    }
    // A manager cannot add a member (INSERT is checked too).
    await assert.rejects(as(MANAGER, () => client.query(
      'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_A, GLOBAL_ADMIN, 'admin'],
    )), /row-level security/);
    // An owner cannot add a member to another tenant.
    await assert.rejects(as(OWNER, () => client.query(
      'INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_B, GLOBAL_ADMIN, 'admin'],
    )), /row-level security/);

    // Helpers are SECURITY DEFINER with a fixed search_path and row_security off.
    const defs = (await client.query(`
      SELECT p.proname, p.prosecdef, p.proconfig
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('aws_is_tenant_actor', 'aws_is_tenant_team_manager', 'aws_can_write_tenant',
                           'aws_can_write_same_tenant_user', 'aws_can_access_tax_profiles')
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

test('SQL 90 file: tenant-scoped helpers, no user_roles admin/staff clause, no BEGIN/COMMIT', () => {
  const sql = fs.readFileSync(SQL_90, 'utf8');
  const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /has_role\(/);
  assert.doesNotMatch(code, /public\.user_roles/);
  assert.doesNotMatch(code, /^\s*(BEGIN|COMMIT)\s*;/im);
  assert.match(code, /lower\(tu\.role::text\) IN \('owner', 'admin', 'manager', 'operator'\)/);
  assert.match(code, /lower\(tu\.role::text\) IN \('owner', 'admin'\)/);
  for (const name of ['aws_is_tenant_actor', 'aws_is_tenant_team_manager', 'aws_can_write_tenant', 'aws_can_write_same_tenant_user', 'aws_can_access_tax_profiles']) {
    const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    assert.ok(start >= 0, name);
    const body = code.slice(start, code.indexOf('$$;', start));
    assert.match(body, /SECURITY DEFINER\nSET search_path = public\nSET row_security = off/, name);
  }
});
