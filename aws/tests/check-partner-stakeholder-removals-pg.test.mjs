/**
 * Partner stakeholder removals (SQL 78) against PostgreSQL 16: the real table,
 * RLS and grants from aws/workflows/sql/78, the real /data/write executor and
 * the share RPC (SQL 32) that clears a removal. Also: without the table
 * (production before SQL 78) sharing still works.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { executeAllowlistedWrite } from '../functions/api/write.mjs';
import { executePartnerShareRpc } from '../functions/api/partner-share-lifecycle.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = path.join(ROOT, 'rls/sql');
const SQL_78 = path.join(ROOT, 'workflows/sql/78_check_partner_stakeholder_removals.sql');
const AUTH_UID_SQL = path.join(ROOT, 'identity/sql/02_auth_uid_guc.sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const PARTNER_USER = 'a1000000-0000-4000-8000-000000000002';
const OTHER_USER = 'a1000000-0000-4000-8000-000000000003';
const CHECK = 'c1000000-0000-4000-8000-000000000001';
const CHECK_UNSHARED = 'c1000000-0000-4000-8000-000000000002';

// initdb refuses to run as root; run the server binaries as 'ubuntu' then.
const serverUser = (() => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('ubuntu:'));
  if (!line) return null;
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
})();
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

const pgSkip = (() => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 binaries not installed';
  if (typeof process.getuid === 'function' && process.getuid() === 0 && !serverUser) return 'initdb cannot run as root and no ubuntu account exists';
  return false;
})();

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
CREATE TABLE public.tenant_partner_code_aliases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, code text NOT NULL);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY, tenant_id uuid, status text, deposited_at timestamptz, payee_line text, claim_id uuid);
CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid);
CREATE TABLE public.deposit_items (id uuid PRIMARY KEY, check_id uuid);
CREATE TABLE public.signature_requests (id uuid PRIMARY KEY, check_intake_item_id uuid, claim_id uuid);
CREATE TABLE public.loss_draft_tracking (id uuid PRIMARY KEY, claim_id uuid);
CREATE TABLE public.tenant_partnerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inviter_tenant_id uuid NOT NULL, invitee_tenant_id uuid,
  invite_code text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending', created_by uuid,
  created_at timestamptz DEFAULT now(), accepted_at timestamptz, revoked_at timestamptz);
CREATE TABLE public.shared_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, source_tenant_id uuid NOT NULL,
  target_tenant_id uuid NOT NULL, shared_by uuid, access_level text NOT NULL DEFAULT 'read_only',
  created_at timestamptz DEFAULT now(), revoked_at timestamptz,
  CONSTRAINT shared_checks_unique_active UNIQUE (check_id, source_tenant_id, target_tenant_id));
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role);
$$;
CREATE OR REPLACE FUNCTION public.lookup_tenant_by_partner_code(_code text)
RETURNS TABLE(id uuid, name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.name FROM public.tenants t WHERE t.partner_code = upper(_code) LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.current_tenant_is_claim_funds_recipient(_claim_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.current_tenant_is_check_funds_recipient(_check_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_claim(_claim_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_check(_check_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
`;

const SEED = `
INSERT INTO public.tenants (id, name, partner_code) VALUES
  ('${OWNER_TENANT}', 'Owner Co', 'OWNER001'), ('${PARTNER}', 'Partner Co', 'PARTNER1'), ('${OTHER}', 'Other Co', 'OTHER001');
INSERT INTO public.identity_accounts (application_user_id, status) VALUES
  ('${OWNER}', 'active'), ('${PARTNER_USER}', 'active'), ('${OTHER_USER}', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES ('${OWNER}', 'staff'), ('${PARTNER_USER}', 'admin'), ('${OTHER_USER}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${OWNER_TENANT}', '${OWNER}', 'member'), ('${PARTNER}', '${PARTNER_USER}', 'admin'), ('${OTHER}', '${OTHER_USER}', 'admin');
INSERT INTO public.check_intake_items (id, tenant_id, status) VALUES
  ('${CHECK}', '${OWNER_TENANT}', 'received'), ('${CHECK_UNSHARED}', '${OWNER_TENANT}', 'received');
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checksops, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checksops, authenticated;
INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by, accepted_at)
VALUES ('${OWNER_TENANT}', '${PARTNER}', 'PARTNER1', 'active', '${OWNER}', now() - interval '1 day');
`;

test('PostgreSQL 16: partner stakeholder removals (SQL 78) via the write executor and share RPC', { timeout: 180000, skip: pgSkip }, async (t) => {
  const { default: pg } = await import('pg');
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-partner-removals-'));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = 58400 + (process.pid % 1000);
  let started = false;
  t.after(() => {
    if (started) run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop'], server);
    fs.rmSync(pgData, { recursive: true, force: true });
  });
  const init = run(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], server);
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const start = run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], server);
  assert.equal(start.status, 0, start.stderr);
  started = true;

  const client = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  const file = (p) => fs.readFileSync(p, 'utf8');
  try {
    await client.query(STUBS);
    await client.query(file(path.join(SQL_DIR, '01_role_shim.sql')));
    await client.query(file(AUTH_UID_SQL));
    for (const name of ['10_owner_helpers_from_identity.sql', '02_helpers.sql', '03_grants.sql', '11_access_helpers.sql', '20_write_helpers.sql', '15_access_grants.sql']) {
      await client.query(file(path.join(SQL_DIR, name)));
    }
    await client.query(SEED);
    await client.query(file(path.join(SQL_DIR, '32_partner_share_lifecycle.sql')));
    await client.query(file(SQL_78));

    /** One API request: a transaction as checksops (RLS on) for this user. */
    const as = async (user, fn, { commit = true } = {}) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await client.query(commit ? 'COMMIT' : 'ROLLBACK');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const write = (user, body) => as(user, () => executeAllowlistedWrite({
      client,
      mapping: { application_user_id: user },
      body: { table: 'check_partner_stakeholder_removals', ...body },
      checkWorkflowEnabled: true,
      applicationWorkflowEnabled: false,
    }));
    const remove = (user, checkId = CHECK, partner = PARTNER, extra = {}) => write(user, {
      op: 'insert', values: { check_intake_item_id: checkId, partner_tenant_id: partner, ...extra },
    });
    const share = (user, checkId = CHECK, partner = PARTNER) => as(user, () => executePartnerShareRpc({
      client, name: 'share_check_with_partner', args: { _check_id: checkId, _target_tenant_id: partner },
    }));
    const rows = async () => (await client.query('SELECT * FROM public.check_partner_stakeholder_removals')).rows;

    // Grants are SELECT/INSERT/DELETE only.
    const grants = (await client.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'check_partner_stakeholder_removals' AND grantee = 'authenticated' ORDER BY 1`,
    )).rows.map((r) => r.privilege_type);
    assert.deepEqual(grants, ['DELETE', 'INSERT', 'SELECT']);

    // No live share yet: nothing to remove.
    let result = await remove(OWNER);
    assert.equal(result.error, 'partner_not_shared');
    assert.equal(result.statusCode, 409);

    // Owner shares the check.
    assert.equal((await share(OWNER)).data.ok, true);

    // A member of the owner tenant removes the partner; tenant_id/removed_by are server-derived.
    result = await remove(OWNER, CHECK, PARTNER, { tenant_id: OTHER, removed_by: OTHER_USER });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].tenant_id, OWNER_TENANT);
    assert.equal(result.rows[0].removed_by, OWNER);
    const removalId = result.rows[0].id;

    // Idempotent: removing again returns the same row.
    result = await remove(OWNER);
    assert.equal(result.rows[0].id, removalId);
    assert.equal((await rows()).length, 1);

    // Another tenant (here the partner itself, and an unrelated tenant) cannot remove on the owner's check.
    for (const user of [PARTNER_USER, OTHER_USER]) {
      await client.query('DELETE FROM public.check_partner_stakeholder_removals');
      result = await remove(user);
      assert.equal(result.error, 'rls_denied', user);
      // Nor by writing the table directly: RLS refuses the owner's tenant_id.
      await assert.rejects(as(user, () => client.query(
        'INSERT INTO public.check_partner_stakeholder_removals (check_intake_item_id, tenant_id, partner_tenant_id) VALUES ($1, $2, $3)',
        [CHECK, OWNER_TENANT, PARTNER],
      )), /row-level security/, user);
    }
    assert.equal((await rows()).length, 0);
    // Not readable by the partner either.
    result = await remove(OWNER);
    assert.equal((await as(PARTNER_USER, () => client.query('SELECT * FROM public.check_partner_stakeholder_removals'))).rows.length, 0);
    assert.equal((await as(OWNER, () => client.query('SELECT * FROM public.check_partner_stakeholder_removals'))).rows.length, 1);
    // ...nor deletable by it.
    result = await write(PARTNER_USER, { op: 'delete', filters: [{ column: 'id', op: 'eq', value: result.rows[0].id }] });
    assert.equal(result.error, 'rls_denied');
    // No UPDATE grant.
    await assert.rejects(as(OWNER, () => client.query('UPDATE public.check_partner_stakeholder_removals SET removed_by = NULL')), /permission denied/);

    // Delete by id re-adds the partner.
    const current = (await rows())[0];
    result = await write(OWNER, { op: 'delete', filters: [{ column: 'id', op: 'eq', value: current.id }] });
    assert.equal(result.rows.length, 1, JSON.stringify(result));

    // Delete by check + partner.
    await remove(OWNER);
    result = await write(OWNER, {
      op: 'delete',
      filters: [
        { column: 'check_intake_item_id', op: 'eq', value: CHECK },
        { column: 'partner_tenant_id', op: 'eq', value: PARTNER },
      ],
    });
    assert.equal(result.rows.length, 1, JSON.stringify(result));
    assert.equal((await rows()).length, 0);

    // Revoked share: cannot remove; a removal made before the revoke stays.
    await remove(OWNER);
    await client.query('UPDATE public.shared_checks SET revoked_at = now() WHERE check_id = $1', [CHECK]);
    await client.query('DELETE FROM public.check_partner_stakeholder_removals');
    result = await remove(OWNER);
    assert.equal(result.error, 'partner_not_shared');
    // Unshared check, and a tenant the check was never shared with.
    assert.equal((await remove(OWNER, CHECK_UNSHARED)).error, 'partner_not_shared');
    assert.equal((await remove(OWNER, CHECK, OTHER)).error, 'partner_not_shared');

    // Re-share clears a removal.
    await client.query('UPDATE public.shared_checks SET revoked_at = NULL WHERE check_id = $1', [CHECK]);
    await remove(OWNER);
    await client.query('UPDATE public.shared_checks SET revoked_at = now() WHERE check_id = $1', [CHECK]);
    assert.equal((await rows()).length, 1);
    result = await share(OWNER);
    assert.equal(result.data.reactivated, true);
    assert.equal((await rows()).length, 0);
    // Sharing an already-live share again also re-adds the partner.
    await remove(OWNER);
    result = await share(OWNER);
    assert.equal(result.data.created, false);
    assert.equal((await rows()).length, 0);
    // A refused share (partner of nobody) clears nothing and fails as before.
    await remove(OWNER);
    await assert.rejects(share(OWNER, CHECK, OTHER), /not_a_partner/);
    assert.equal((await rows()).length, 1);
    // A non-owner cannot share, so cannot clear the removal either.
    await assert.rejects(share(PARTNER_USER), /not_authorized/);
    assert.equal((await rows()).length, 1);

    // Without SQL 78 (production today): sharing still works.
    await client.query('BEGIN');
    await client.query('DROP TABLE public.check_partner_stakeholder_removals');
    await client.query('SET LOCAL ROLE checksops');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [OWNER]);
    try {
      result = await executePartnerShareRpc({
        client, name: 'share_check_with_partner', args: { _check_id: CHECK, _target_tenant_id: PARTNER },
      });
      assert.equal(result.data.ok, true);
      // The transaction is still usable (no aborted statement).
      assert.equal((await client.query('SELECT 1 AS one')).rows[0].one, 1);
    } finally {
      await client.query('ROLLBACK');
    }
    assert.equal((await rows()).length, 1);
  } finally {
    await client.end();
  }
});
