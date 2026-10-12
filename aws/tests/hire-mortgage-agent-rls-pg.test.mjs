import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_RLS_DIR = path.join(ROOT, 'rls/sql');
const SQL_IDENTITY_DIR = path.join(ROOT, 'identity/sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';

const read = (p) => fs.readFileSync(p, 'utf8');
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
const mustRun = (bin, args, opts = {}) => {
  const r = run(bin, args, opts);
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r;
};

const rlsDenied = (err) => {
  const msg = String(err?.message || err || '');
  return /row-level security|violates row-level security|permission denied/i.test(msg) || err?.code === '42501';
};

test('hire-mortgage-agent provisioning SECURITY DEFINER is narrow and preserves general RLS', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true, 'PostgreSQL 16 initdb is required');

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-hire-rls-${stamp}-`));
  const port = 56000 + (process.pid % 1000);
  const dbName = `hire_rls_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  let started = false;
  const { Client } = pg;

  const stopCluster = () => {
    if (started) run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']);
    started = false;
    fs.rmSync(pgData, { recursive: true, force: true });
  };
  t.after(stopCluster);

  mustRun(path.join(PG_BIN, 'initdb'), [
    '-D', pgData,
    '--auth=trust',
    '--no-sync',
    '--username=ubuntu',
    '--encoding=UTF8',
  ]);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `
listen_addresses = ''
port = ${port}
unix_socket_directories = '${pgData}'
logging_collector = off
shared_buffers = 32MB
max_connections = 20
`);
  mustRun(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', logPath, '-w', 'start']);
  started = true;

  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-v', 'ON_ERROR_STOP=1'];
  const psql = (extra, input) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra], input ? { input } : {});
    if (result.status !== 0) throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    return result;
  };
  const sql = (statement, db = dbName) => psql(['-d', db, '-c', statement]);

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);

  // Minimal roles: checksops is the login role used by the API.
  sql(`
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE checksops_admin LOGIN NOSUPERUSER INHERIT;
GRANT CONNECT ON DATABASE ${dbName} TO checksops;
GRANT CONNECT ON DATABASE ${dbName} TO checksops_admin;
`, dbName);

  // Shim authenticated/anon roles and grant authenticated->checksops.
  sql(read(path.join(SQL_RLS_DIR, '01_role_shim.sql')), dbName);

  // Base schema + auth.uid() from request.app_user_id.
  sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;', dbName);
  sql(read(path.join(SQL_IDENTITY_DIR, '02_auth_uid_guc.sql')), dbName);
  sql(`
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');

CREATE TABLE public.identity_accounts (
  application_user_id uuid PRIMARY KEY,
  cognito_sub text,
  email text,
  status text,
  linked_at timestamptz,
  created_at timestamptz
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text,
  full_name text,
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);

CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  UNIQUE (tenant_id, user_id)
);

-- has_role helper used by aws_can_write_same_tenant_user.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id AND ur.role = _role
  );
$$;

REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO checksops, authenticated;
`, dbName);

  // Match staging privilege grants: checksops has table DML, RLS still enforces policy.
  sql('GRANT USAGE ON SCHEMA public TO checksops;', dbName);
  sql(read(path.join(SQL_IDENTITY_DIR, '07_hire_mortgage_agent_grants.sql')), dbName);

  // Platform-owner/master-owner helpers.
  sql(read(path.join(SQL_RLS_DIR, '10_owner_helpers_from_identity.sql')), dbName);

  // Exact helper used by aws_can_write_same_tenant_user.
  sql(read(path.join(SQL_RLS_DIR, '02_helpers.sql')), dbName);
  sql(`
CREATE OR REPLACE FUNCTION public.aws_can_access_same_tenant_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _user_id IS NOT NULL AND (
    _user_id = auth.uid()
    OR public.aws_is_cross_tenant_reader()
    OR EXISTS (
      SELECT 1
      FROM public.tenant_users mine
      JOIN public.tenant_users theirs
        ON theirs.tenant_id = mine.tenant_id
      WHERE mine.user_id = auth.uid()
        AND theirs.user_id = _user_id
    )
  );
$$;
`, dbName);
  sql(`
CREATE OR REPLACE FUNCTION public.aws_is_authenticated()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT auth.uid() IS NOT NULL;
$$;
`, dbName);
  sql(`
CREATE OR REPLACE FUNCTION public.aws_can_write_same_tenant_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND _user_id IS NOT NULL
     AND (
       public.aws_is_cross_tenant_reader()
       OR (
         public.aws_can_access_same_tenant_user(_user_id)
         AND (
           public.has_role(auth.uid(), 'admin'::public.app_role)
           OR public.has_role(auth.uid(), 'staff'::public.app_role)
         )
       )
     );
$$;
`, dbName);

  // Enable RLS + apply the exact write policies for the tables under test.
  sql(`
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_write_profiles ON public.profiles;
CREATE POLICY aws_write_profiles ON public.profiles
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND ( id = auth.uid() OR public.aws_can_write_same_tenant_user(id)))
  WITH CHECK (public.aws_is_authenticated() AND ( id = auth.uid() OR public.aws_can_write_same_tenant_user(id)));

DROP POLICY IF EXISTS aws_write_user_roles ON public.user_roles;
CREATE POLICY aws_write_user_roles ON public.user_roles
  FOR ALL TO authenticated
  USING (
    public.aws_is_cross_tenant_reader()
    OR (
      public.aws_can_access_same_tenant_user(user_id)
      AND (
        public.has_role(auth.uid(), 'admin'::public.app_role)
        OR public.is_master_owner()
      )
    )
  )
  WITH CHECK (
    public.aws_is_cross_tenant_reader()
    OR (
      public.aws_can_access_same_tenant_user(user_id)
      AND public.has_role(auth.uid(), 'admin'::public.app_role)
    )
  );
`, dbName);

  // Load the SECURITY DEFINER provisioner from the repo migration file.
  sql(read(path.join(SQL_IDENTITY_DIR, '12_hire_mortgage_agent_provision_rpc.sql')), dbName);

  // Fixtures
  const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MASTER_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';
  const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const AGENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const TENANT_USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const TENANT = '11111111-1111-4111-8111-111111111111';

  sql(`
INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN_ID}', 'admin');
INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT_ID}', 'mortgage_agent');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT}', '${TENANT_USER_ID}', 'member');
INSERT INTO public.identity_accounts (application_user_id, email, status, created_at)
VALUES ('${MASTER_ID}', 'checksopsadmin@gmail.com', 'active', now())
ON CONFLICT (application_user_id) DO UPDATE SET email = EXCLUDED.email, status = EXCLUDED.status;
`, dbName);

  const client = new Client({
    host: pgData,
    port,
    user: 'ubuntu',
    database: dbName,
  });
  await client.connect();
  await client.query('BEGIN');
  t.after(async () => {
    try { await client.end(); } catch { /* ignore */ }
  });

  const asChecksops = async (appUserId, fn) => {
    await client.query('SAVEPOINT rls_case');
    try {
      await client.query('SET LOCAL ROLE checksops');
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
      const result = await fn();
      await client.query('ROLLBACK TO SAVEPOINT rls_case');
      return result;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT rls_case');
      throw error;
    }
  };

  // 1) Authorized system admin can provision a mortgage agent via the SECURITY DEFINER function.
  await asChecksops(ADMIN_ID, async () => {
    const target = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const out = (await client.query(
      `SELECT public.aws_hire_mortgage_agent_provision($1::uuid, $2::text, $3::text) AS result`,
      [target, 'agent@example.com', 'Agent One'],
    )).rows[0].result;
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    assert.equal(parsed.ok, true);
    assert.equal(parsed.application_user_id, target);
    assert.equal(parsed.mortgage_agent_granted, true);
    // Verify effects as table owner (RLS SELECT policies are out of scope here).
    await client.query('RESET ROLE');
    const profile = (await client.query(
      `SELECT id::text AS id, email, full_name FROM public.profiles WHERE id = $1::uuid`,
      [target],
    )).rows[0];
    assert.equal(profile.email, 'agent@example.com');
    const roles = (await client.query(
      `SELECT role::text AS role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY 1`,
      [target],
    )).rows.map((row) => row.role);
    assert.deepEqual(roles, ['mortgage_agent']);
    await client.query('SET LOCAL ROLE checksops');
  });

  // 2) Platform/master owner can provision.
  await asChecksops(MASTER_ID, async () => {
    const target = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const out = (await client.query(
      `SELECT public.aws_hire_mortgage_agent_provision($1::uuid, $2::text, $3::text) AS result`,
      [target, 'agent2@example.com', 'Agent Two'],
    )).rows[0].result;
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mortgage_agent_granted, true);
  });

  // 3-6) Ordinary/agent/tenant-only cannot.
  const cannot = async (who) => asChecksops(who, async () => {
    const target = '11111111-2222-4333-8444-555555555555';
    const out = (await client.query(
      `SELECT public.aws_hire_mortgage_agent_provision($1::uuid, $2::text, $3::text) AS result`,
      [target, 'blocked@example.com', 'Blocked'],
    )).rows[0].result;
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, 'not_authorized');
  });
  await cannot(USER_ID);
  await cannot(AGENT_ID);
  await cannot(TENANT_USER_ID);

  // 12-13) General direct cross-identity writes remain blocked by RLS.
  await asChecksops(ADMIN_ID, async () => {
    const target = '22222222-2222-4222-8222-222222222222';
    const expectDenied = async (query, params) => {
      await client.query('SAVEPOINT deny_case');
      try {
        await client.query(query, params);
        assert.fail('expected RLS denial');
      } catch (err) {
        assert.equal(rlsDenied(err), true, String(err?.message || err));
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT deny_case');
      }
    };

    await expectDenied(
      `INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, now(), now())`,
      [target, 'x@example.com', 'X'],
    );

    await expectDenied(
      `INSERT INTO public.user_roles (user_id, role) VALUES ($1::uuid, 'mortgage_agent')`,
      [target],
    );
  });
});

