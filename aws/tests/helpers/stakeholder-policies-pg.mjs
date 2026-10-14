/**
 * PostgreSQL 16 fixture for the check stakeholder tables: the real AWS RLS
 * helper files (aws/rls/sql), public.check_stakeholders with its real policies
 * (copied out of 12_final_select_policies.sql and 24_complete_write_policies.sql)
 * and the real SQL 77 grant, and the real SQL 78 table. SQL 79 is left to the
 * caller. Used by the SQL 79 executor and member-write tests.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AWS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL_DIR = path.join(AWS_ROOT, 'rls/sql');
export const SQL_77 = path.join(AWS_ROOT, 'workflows/sql/77_check_stakeholders_write_grant.sql');
export const SQL_78 = path.join(AWS_ROOT, 'workflows/sql/78_check_partner_stakeholder_removals.sql');
export const SQL_79 = path.join(AWS_ROOT, 'workflows/sql/79_member_stakeholder_writes.sql');
const AUTH_UID_SQL = path.join(AWS_ROOT, 'identity/sql/02_auth_uid_guc.sql');

// initdb refuses to run as root; run the server binaries as 'ubuntu' then.
const serverUser = (() => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('ubuntu:'));
  if (!line) return null;
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
})();
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

export function pgSkipReason() {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 binaries not installed';
  if (typeof process.getuid === 'function' && process.getuid() === 0 && !serverUser) return 'initdb cannot run as root and no ubuntu account exists';
  return null;
}

/** Starts a throwaway server; `stop()` removes it. The superuser is 'ubuntu'. */
export function startPg(prefix, basePort) {
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = basePort + (process.pid % 1000);
  const init = run(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], server);
  if (init.status !== 0) throw new Error(init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const start = run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], server);
  if (start.status !== 0) throw new Error(start.stderr);
  return {
    host: pgData,
    port,
    stop() {
      run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop'], server);
      fs.rmSync(pgData, { recursive: true, force: true });
    },
  };
}

const STUBS = `
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public TO checksops;
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, UNIQUE (tenant_id, user_id));
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, name text, partner_code text UNIQUE, subscription_status text NOT NULL DEFAULT 'active');
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY, tenant_id uuid, status text, deposited_at timestamptz, payee_line text, claim_id uuid);
CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid);
CREATE TABLE public.deposit_items (id uuid PRIMARY KEY, check_id uuid);
CREATE TABLE public.signature_requests (id uuid PRIMARY KEY, check_intake_item_id uuid, claim_id uuid);
CREATE TABLE public.loss_draft_tracking (id uuid PRIMARY KEY, claim_id uuid);
CREATE TABLE public.shared_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, source_tenant_id uuid NOT NULL,
  target_tenant_id uuid NOT NULL, shared_by uuid, access_level text NOT NULL DEFAULT 'read_only',
  created_at timestamptz DEFAULT now(), revoked_at timestamptz,
  CONSTRAINT shared_checks_unique_active UNIQUE (check_id, source_tenant_id, target_tenant_id));
CREATE TABLE public.stakeholder_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id), name text,
  is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.check_stakeholders (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  stakeholder_account_id uuid NOT NULL REFERENCES public.stakeholder_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  added_via text NOT NULL DEFAULT 'manual' CHECK (added_via IN ('manual','partner_share')),
  partner_tenant_id uuid REFERENCES public.tenants(id),
  added_by uuid REFERENCES public.identity_accounts(application_user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (check_intake_item_id, stakeholder_account_id));
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role);
$$;
CREATE OR REPLACE FUNCTION public.current_tenant_is_claim_funds_recipient(_claim_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.current_tenant_is_check_funds_recipient(_check_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_claim(_claim_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_check(_check_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
`;

/** One policy's DROP + CREATE block, exactly as an aws/rls/sql file has it. */
export function policyBlock(file, policyName) {
  const text = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
  const start = text.indexOf(`DROP POLICY IF EXISTS ${policyName} ON`);
  if (start < 0) throw new Error(`${policyName} not found in ${file}`);
  const create = text.indexOf(`CREATE POLICY ${policyName} ON`, start);
  const end = text.indexOf(';', create);
  return text.slice(start, end + 1);
}

/** Builds the schema as superuser 'ubuntu' (who then owns every table). */
export async function applyBaseSchema(client) {
  const file = (p) => fs.readFileSync(p, 'utf8');
  await client.query(STUBS);
  await client.query(file(path.join(SQL_DIR, '01_role_shim.sql')));
  await client.query(file(AUTH_UID_SQL));
  for (const name of ['10_owner_helpers_from_identity.sql', '02_helpers.sql', '03_grants.sql', '11_access_helpers.sql', '20_write_helpers.sql', '15_access_grants.sql']) {
    await client.query(file(path.join(SQL_DIR, name)));
  }
  await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops, authenticated');
  await client.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checksops, authenticated');
  await client.query('REVOKE ALL ON TABLE public.check_stakeholders FROM checksops, authenticated');
  await client.query('GRANT SELECT ON TABLE public.check_stakeholders TO checksops');
  await client.query(file(SQL_77));
  await client.query('ALTER TABLE public.check_stakeholders ENABLE ROW LEVEL SECURITY');
  await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_check_stakeholders'));
  await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_check_stakeholders'));
  await client.query(file(SQL_78));
}
