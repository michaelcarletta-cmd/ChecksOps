import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const SQL_DIR = path.join(ROOT, 'rls/sql');
const SQL76 = path.join(ROOT, 'workflows/sql/76_tenant_partnership_invitee_consent.sql');
const SQL76_ROLLBACK = path.join(ROOT, 'workflows/sql/76_tenant_partnership_invitee_consent_rollback.sql');
const SQL76_REVIEW = path.join(ROOT, 'workflows/sql/76_tenant_partnership_invitee_consent_review.sql');
const AUTH_UID_SQL = path.join(ROOT, 'identity/sql/02_auth_uid_guc.sql');
const LEGACY_MIGRATION = path.join(REPO, 'supabase/migrations/20260423123210_680e1aae-5f11-4bfe-b500-0c7104b05a7b.sql');
const LEGACY_ADMIN_MIGRATION = path.join(REPO, 'supabase/migrations/20260702190605_f99d1f3e-2bfd-47d7-b462-a2d22b53a9c6.sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';

const read = (file) => fs.readFileSync(file, 'utf8');
const statementsOf = (sql) => sql
  .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  .replace(/\$\$[\s\S]*?\$\$/g, () => '$$BODY$$')
  .split(';').map((s) => s.trim()).filter(Boolean);

// Supabase-era write and cross-tenant admin policies SQL 76 retires.
const RETIRED_POLICIES = [
  'Inviter can create partnerships',
  'Partners can update partnerships',
  'Admins can create any partnership',
  'Admins can view any partnership',
  'Admins can update any partnership',
];

test('SQL 76 only adds the consent trigger and the connect marker, and retires the old policies', () => {
  const statements = statementsOf(read(SQL76));
  const allowed = [
    /^CREATE OR REPLACE FUNCTION public\.aws_tenant_partnership_consent_guard\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SET search_path = public\s+AS \$\$BODY\$\$$/,
    /^COMMENT ON FUNCTION public\.aws_tenant_partnership_consent_guard\(\) IS/,
    /^REVOKE ALL ON FUNCTION public\.aws_tenant_partnership_consent_guard\(\) FROM PUBLIC$/,
    /^DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public\.tenant_partnerships$/,
    /^CREATE TRIGGER aws_tenant_partnership_consent_guard\s+BEFORE INSERT OR UPDATE ON public\.tenant_partnerships\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.aws_tenant_partnership_consent_guard\(\)$/,
    /^ALTER FUNCTION public\.aws_connect_partner_by_code\(text, uuid\)\s+SET checksops\.partnership_writer = 'aws_connect_partner_by_code'$/,
    ...RETIRED_POLICIES.map((name) => new RegExp(`^DROP POLICY IF EXISTS "${name}" ON public\\.tenant_partnerships$`)),
  ];
  assert.equal(statements.length, allowed.length, JSON.stringify(statements));
  statements.forEach((statement, index) => assert.match(statement, allowed[index], statement));

  const body = read(SQL76).match(/AS \$\$([\s\S]*?)\$\$/)[1];
  // Not SECURITY DEFINER: the guard runs as the writer and reads auth.uid() through the helpers.
  assert.doesNotMatch(read(SQL76), /SECURITY DEFINER/);
  // Invitee membership AND write capability; no platform-owner or inviter shortcut.
  assert.match(body, /NEW\.invitee_tenant_id IN \(SELECT public\.aws_user_tenant_ids\(\)\)/);
  assert.match(body, /public\.aws_can_write_tenant\(NEW\.invitee_tenant_id\)/);
  assert.doesNotMatch(body, /cross_tenant|has_role|inviter_tenant_id IN|aws_can_write_tenant\(NEW\.inviter/);
  assert.match(body, /current_setting\('checksops\.partnership_writer', true\) = 'aws_connect_partner_by_code'/);
  // Never set_config: the marker comes only from the function-level SET clause.
  assert.doesNotMatch(read(SQL76), /set_config/);
});

test('SQL 76 rollback and review files are scoped and the review is read-only', () => {
  const rollback = statementsOf(read(SQL76_ROLLBACK));
  const flat = rollback.map((s) => s.replace(/\s+/g, ' '));
  // Exactly these three statements: the retired Supabase-era policies stay retired.
  assert.deepEqual(flat, [
    'DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public.tenant_partnerships',
    'DROP FUNCTION IF EXISTS public.aws_tenant_partnership_consent_guard()',
    'ALTER FUNCTION public.aws_connect_partner_by_code(text, uuid) RESET checksops.partnership_writer',
  ]);
  const rollbackSql = read(SQL76_ROLLBACK).split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(rollbackSql, /CREATE\s+POLICY/i);
  assert.doesNotMatch(rollbackSql, /\b(GRANT|CREATE|INSERT|UPDATE|DELETE)\b/i);
  const review = statementsOf(read(SQL76_REVIEW));
  assert.equal(review.length, 1);
  assert.match(review[0], /^WITH live AS/);
  assert.doesNotMatch(review[0], /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE|TRUNCATE|set_config)\b/i);
});

test('the only writers of tenant_partnerships are the SECURITY DEFINER lifecycle RPCs', () => {
  // If this changes, re-check the trigger's trusted-writer and consent rules.
  const allowlist = read(path.join(ROOT, 'functions/api/write-allowlist.mjs'));
  assert.doesNotMatch(allowlist, /tenant_partnerships/);
  const lifecycle = read(path.join(SQL_DIR, '32_partner_share_lifecycle.sql'));
  const writes = lifecycle.match(/(INSERT INTO|UPDATE) public\.tenant_partnerships/g);
  assert.deepEqual(writes, [
    'UPDATE public.tenant_partnerships',
    'INSERT INTO public.tenant_partnerships',
    'UPDATE public.tenant_partnerships',
    'UPDATE public.tenant_partnerships',
  ]);
  // The revoke path only ever writes status = 'revoked', which the guard always allows.
  assert.match(lifecycle, /SET status = 'revoked',\s+revoked_at = coalesce\(revoked_at, now\(\)\)/);
});

const SOURCE = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const UNRELATED = '44444444-4444-4444-8444-444444444444';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const PARTNER_USER = 'a1000000-0000-4000-8000-000000000002';
const OTHER_USER = 'a1000000-0000-4000-8000-000000000003';
const UNRELATED_USER = 'a1000000-0000-4000-8000-000000000004';
const PLATFORM = 'a1000000-0000-4000-8000-000000000005';
const PARTNER_CODE = 'AB3K7X9P';
const OTHER_CODE = 'CD4L8Y0Q';

// initdb refuses to run as root; when the suite runs as root (CI containers),
// run the server binaries as the unprivileged 'ubuntu' account instead.
const serverUser = (() => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('ubuntu:'));
  if (!line) return null;
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
})();
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result;
};

const policyBlock = (file, name) => {
  const sql = read(file);
  const match = sql.match(new RegExp(`DROP POLICY IF EXISTS ${name} ON public\\.tenant_partnerships;\\s*CREATE POLICY ${name} ON public\\.tenant_partnerships[\\s\\S]*?;\\n`));
  assert.ok(match, `${name} not found in ${file}`);
  return match[0];
};

test('disposable PostgreSQL: only the invitee side can make a partnership active', {
  timeout: 180000,
  skip: fs.existsSync(path.join(PG_BIN, 'initdb')) ? false : 'PostgreSQL 16 binaries not installed',
}, async (t) => {
  const stamp = `${Date.now()}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-sql76-${stamp}-`));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const server = serverUser || {};
  const port = 56400 + (process.pid % 1000);
  const dbName = `sql76_${stamp}`;
  let started = false;
  t.after(() => {
    if (started) run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop'], server);
    fs.rmSync(pgData, { recursive: true, force: true });
  });

  mustRun(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], server);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `
listen_addresses = ''
port = ${port}
unix_socket_directories = '${pgData}'
logging_collector = off
shared_buffers = 32MB
max_connections = 20
`);
  mustRun(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', 'start'], server);
  started = true;

  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-v', 'ON_ERROR_STOP=1'];
  const psql = (extra, input) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra], input ? { input } : {});
    if (result.status !== 0) throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    return result;
  };
  const file = (f) => psql(['-d', dbName, '-f', f]);
  const scalar = (sql) => psql(['-d', dbName, '-t', '-A', '-c', sql]).stdout.trim();

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-c', `
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT CONNECT ON DATABASE ${dbName} TO checksops;
`]);
  file(path.join(SQL_DIR, '01_role_shim.sql'));
  psql(['-d', dbName], `
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public TO checksops;
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE TABLE public.tenant_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, UNIQUE (tenant_id, user_id));
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text, partner_code text UNIQUE, subscription_status text NOT NULL DEFAULT 'active');
CREATE TABLE public.tenant_partner_code_aliases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, code text NOT NULL);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text);
CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid);
CREATE TABLE public.deposit_items (id uuid PRIMARY KEY, check_id uuid);
CREATE TABLE public.signature_requests (id uuid PRIMARY KEY, check_intake_item_id uuid, claim_id uuid);
CREATE TABLE public.loss_draft_tracking (id uuid PRIMARY KEY, claim_id uuid);
CREATE TABLE public.tenant_partnerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_tenant_id uuid NOT NULL,
  invitee_tenant_id uuid,
  invite_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT partnership_no_self CHECK (invitee_tenant_id IS NULL OR inviter_tenant_id <> invitee_tenant_id)
);
CREATE TABLE public.shared_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, source_tenant_id uuid NOT NULL,
  target_tenant_id uuid NOT NULL, shared_by uuid, access_level text NOT NULL DEFAULT 'read_only',
  created_at timestamptz DEFAULT now(), revoked_at timestamptz,
  CONSTRAINT shared_checks_unique_active UNIQUE (check_id, source_tenant_id, target_tenant_id)
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role);
$$;
CREATE OR REPLACE FUNCTION public.user_belongs_to_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.user_id = _user_id AND tu.tenant_id = _tenant_id);
$$;
CREATE OR REPLACE FUNCTION public.lookup_tenant_by_partner_code(_code text)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH normalized AS (SELECT regexp_replace(upper(coalesce(_code, '')), '[^A-Z0-9]', '', 'g') AS code)
  SELECT t.id, t.name FROM normalized n JOIN public.tenants t
    ON t.subscription_status = 'active' AND t.partner_code = n.code
  LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.current_tenant_is_claim_funds_recipient(_claim_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.current_tenant_is_check_funds_recipient(_check_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_claim(_claim_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_check(_check_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
`);
  file(AUTH_UID_SQL);
  for (const name of ['10_owner_helpers_from_identity.sql', '02_helpers.sql', '03_grants.sql', '11_access_helpers.sql', '20_write_helpers.sql', '15_access_grants.sql']) {
    file(path.join(SQL_DIR, name));
  }
  psql(['-d', dbName], `
INSERT INTO public.tenants (id, name, partner_code) VALUES
  ('${SOURCE}', 'Source Co', 'ZZZZZZZ1'),
  ('${PARTNER}', 'Partner Co', '${PARTNER_CODE}'),
  ('${OTHER}', 'Other Co', '${OTHER_CODE}'),
  ('${UNRELATED}', 'Unrelated Co', 'UNRELAT1');
INSERT INTO public.profiles (id, email) VALUES ('${PLATFORM}', 'checksopsadmin@gmail.com');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${OWNER}', 'admin'), ('${PARTNER_USER}', 'admin'), ('${OTHER_USER}', 'admin'), ('${UNRELATED_USER}', 'admin'), ('${PLATFORM}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${SOURCE}', '${OWNER}', 'admin'),
  ('${PARTNER}', '${PARTNER_USER}', 'admin'),
  ('${OTHER}', '${OTHER_USER}', 'admin'),
  ('${UNRELATED}', '${UNRELATED_USER}', 'admin');
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checksops, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checksops, authenticated;
`);
  file(path.join(SQL_DIR, '32_partner_share_lifecycle.sql'));

  // Live policy set as far as the repo knows it: the AWS select/write policies
  // plus the copied Supabase policies, which are the ones the review flagged.
  const legacy = read(LEGACY_MIGRATION).slice(read(LEGACY_MIGRATION).indexOf('ALTER TABLE public.tenant_partnerships ENABLE'));
  psql(['-d', dbName], [
    legacy,
    read(LEGACY_ADMIN_MIGRATION),
    policyBlock(path.join(SQL_DIR, '12_final_select_policies.sql'), 'aws_select_tenant_partnerships'),
    policyBlock(path.join(SQL_DIR, '24_complete_write_policies.sql'), 'aws_write_tenant_partnerships'),
  ].join('\n'));

  // A pre-76 row the inviter activated itself, for the review query.
  psql(['-d', dbName, '-c', `
INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by, accepted_at)
VALUES ('${UNRELATED}', '${OTHER}', 'LEGACY01', 'active', '${UNRELATED_USER}', now());
-- A pre-76 live open invite (invitee still NULL), for the invitee-change rule.
INSERT INTO public.tenant_partnerships (inviter_tenant_id, invite_code, status, created_by, accepted_at)
VALUES ('${UNRELATED}', 'OPENLIVE', 'active', '${UNRELATED_USER}', now());
`]);

  // Before SQL 76 the inviter can flip its own pending row to active (the bug).
  psql(['-d', dbName, '-c', `
SELECT set_config('request.app_user_id', '${OWNER}', false);
SET ROLE checksops;
INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by)
VALUES ('${SOURCE}', '${UNRELATED}', 'PRE76BUG', 'pending', '${OWNER}');
UPDATE public.tenant_partnerships SET status = 'active', accepted_at = now() WHERE invite_code = 'PRE76BUG';
RESET ROLE;
`]);
  assert.equal(scalar(`SELECT status FROM public.tenant_partnerships WHERE invite_code = 'PRE76BUG'`), 'active');
  psql(['-d', dbName, '-c', `DELETE FROM public.tenant_partnerships WHERE invite_code = 'PRE76BUG'`]);

  file(SQL76);
  file(SQL76); // idempotent

  psql(['-d', dbName], `
CREATE TABLE public._results (test text PRIMARY KEY, ok boolean NOT NULL, detail text);
CREATE OR REPLACE FUNCTION public._ok(_t text, _ok boolean, _d text DEFAULT '') RETURNS void
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public._results VALUES (_t, coalesce(_ok, false), _d) ON CONFLICT (test) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail; END; $$;
-- Run one statement as checksops with request.app_user_id set, like the API.
CREATE OR REPLACE FUNCTION public._exec(_user uuid, _sql text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE _err text; _n int; _val jsonb;
BEGIN
  PERFORM set_config('request.app_user_id', coalesce(_user::text, ''), false);
  BEGIN
    EXECUTE 'SET ROLE checksops';
    IF _sql ~* '^\\s*SELECT' THEN
      EXECUTE 'SELECT to_jsonb((' || regexp_replace(_sql, '^\\s*SELECT\\s+', '', 'i') || '))' INTO _val;
      _n := 1;
    ELSE
      EXECUTE _sql;
      GET DIAGNOSTICS _n = ROW_COUNT;
    END IF;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', true, 'rows', _n, 'val', _val);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', false, 'error', _err);
  END;
END; $$;

DO $$
DECLARE
  r jsonb;
  pid uuid;
  cid uuid;
  st text;
  denied_consent constant text := '%partnership_invitee_consent_required%';
BEGIN
  -- Inviter cannot insert a live row.
  r := public._exec('${OWNER}', $q$INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by, accepted_at)
    VALUES ('${SOURCE}', '${OTHER}', 'DIRECT01', 'active', '${OWNER}', now())$q$);
  PERFORM public._ok('01_inviter_insert_active_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE denied_consent, r::text);

  -- Inviter can still create a pending invite.
  r := public._exec('${OWNER}', $q$INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by)
    VALUES ('${SOURCE}', '${OTHER}', 'DIRECT01', 'pending', '${OWNER}')$q$);
  PERFORM public._ok('02_inviter_insert_pending_ok', (r->>'ok')::boolean AND (r->>'rows')::int = 1, r::text);
  SELECT id INTO pid FROM public.tenant_partnerships WHERE invite_code = 'DIRECT01';

  -- Inviter cannot flip its own pending row to active (the review finding).
  r := public._exec('${OWNER}', format($q$UPDATE public.tenant_partnerships SET status = 'active', accepted_at = now() WHERE id = %L$q$, pid));
  PERFORM public._ok('03_inviter_self_accept_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE denied_consent, r::text);

  -- Platform owner (cross-tenant writer, not an invitee member) cannot accept for them.
  r := public._exec('${PLATFORM}', format($q$UPDATE public.tenant_partnerships SET status = 'active' WHERE id = %L$q$, pid));
  PERFORM public._ok('04_platform_owner_accept_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE denied_consent, r::text);

  -- Inviter cannot retarget the invite to a tenant it controls or another tenant.
  r := public._exec('${OWNER}', format($q$UPDATE public.tenant_partnerships SET invitee_tenant_id = '${UNRELATED}' WHERE id = %L$q$, pid));
  PERFORM public._ok('05_retarget_invitee_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE '%partnership_tenants_immutable%', r::text);
  r := public._exec('${OTHER_USER}', format($q$UPDATE public.tenant_partnerships SET inviter_tenant_id = '${UNRELATED}' WHERE id = %L$q$, pid));
  PERFORM public._ok('05b_retarget_inviter_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE '%partnership_tenants_immutable%', r::text);

  -- Unrelated tenant admin: SQL 76 retires "Admins can update any partnership",
  -- so RLS no longer lets the UPDATE reach the row (and the guard would refuse it).
  r := public._exec('${UNRELATED_USER}', format($q$UPDATE public.tenant_partnerships SET status = 'active' WHERE id = %L$q$, pid));
  PERFORM public._ok('06_unrelated_admin_accept_denied',
    ((r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE denied_consent) OR ((r->>'ok')::boolean AND (r->>'rows')::int = 0), r::text);

  -- Invitee accepts.
  r := public._exec('${OTHER_USER}', format($q$UPDATE public.tenant_partnerships SET status = 'active', accepted_at = now() WHERE id = %L$q$, pid));
  PERFORM public._ok('07_invitee_accept_ok', (r->>'ok')::boolean AND (r->>'rows')::int = 1, r::text);

  -- Either side may edit a live row without changing liveness.
  r := public._exec('${OWNER}', format($q$UPDATE public.tenant_partnerships SET invite_code = 'DIRECT02' WHERE id = %L$q$, pid));
  PERFORM public._ok('08_inviter_edit_live_row_ok', (r->>'ok')::boolean AND (r->>'rows')::int = 1, r::text);

  -- Inviter can revoke; inviter cannot reactivate; invitee can.
  r := public._exec('${OWNER}', format($q$UPDATE public.tenant_partnerships SET status = 'revoked', revoked_at = now() WHERE id = %L$q$, pid));
  PERFORM public._ok('09_inviter_revoke_ok', (r->>'ok')::boolean AND (r->>'rows')::int = 1, r::text);
  r := public._exec('${OWNER}', format($q$UPDATE public.tenant_partnerships SET status = 'active', revoked_at = NULL WHERE id = %L$q$, pid));
  PERFORM public._ok('10_inviter_reactivate_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE denied_consent, r::text);
  r := public._exec('${OWNER}', format($q$UPDATE public.tenant_partnerships SET revoked_at = NULL WHERE id = %L$q$, pid));
  PERFORM public._ok('10b_inviter_clear_revoked_at_only_ok', (r->>'ok')::boolean AND (r->>'rows')::int = 1, r::text);
  SELECT status INTO st FROM public.tenant_partnerships WHERE id = pid;
  PERFORM public._ok('10c_still_not_live', st = 'revoked', st);
  r := public._exec('${OTHER_USER}', format($q$UPDATE public.tenant_partnerships SET status = 'active', revoked_at = NULL WHERE id = %L$q$, pid));
  PERFORM public._ok('11_invitee_reactivate_ok', (r->>'ok')::boolean AND (r->>'rows')::int = 1, r::text);

  -- Invitee can revoke (end) too.
  r := public._exec('${OTHER_USER}', format($q$UPDATE public.tenant_partnerships SET status = 'revoked', revoked_at = now() WHERE id = %L$q$, pid));
  PERFORM public._ok('12_invitee_revoke_ok', (r->>'ok')::boolean AND (r->>'rows')::int = 1, r::text);

  -- Invitee can decline a pending invite.
  r := public._exec('${OWNER}', $q$INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by)
    VALUES ('${SOURCE}', '${UNRELATED}', 'DECLINE1', 'pending', '${OWNER}')$q$);
  r := public._exec('${UNRELATED_USER}', $q$UPDATE public.tenant_partnerships SET status = 'declined' WHERE invite_code = 'DECLINE1'$q$);
  PERFORM public._ok('13_invitee_decline_ok', (r->>'ok')::boolean AND (r->>'rows')::int = 1, r::text);

  -- Open invite (invitee NULL): inviter cannot activate it; still needs an invitee.
  r := public._exec('${OWNER}', $q$INSERT INTO public.tenant_partnerships (inviter_tenant_id, invite_code, status, created_by)
    VALUES ('${SOURCE}', 'OPEN0001', 'active', '${OWNER}')$q$);
  PERFORM public._ok('14_open_invite_active_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE denied_consent, r::text);

  -- No identity (e.g. a maintenance session as checksops) cannot activate.
  r := public._exec(NULL, format($q$UPDATE public.tenant_partnerships SET status = 'active', revoked_at = NULL WHERE id = %L$q$, pid));
  PERFORM public._ok('15_no_identity_update_noop', (r->>'ok')::boolean IS NOT TRUE OR (r->>'rows')::int = 0, r::text);

  -- A live row getting a (new) invitee needs that invitee's writer.
  SELECT id INTO cid FROM public.tenant_partnerships WHERE invite_code = 'OPENLIVE';
  r := public._exec('${UNRELATED_USER}', format($q$UPDATE public.tenant_partnerships SET invitee_tenant_id = '${PARTNER}' WHERE id = %L$q$, cid));
  PERFORM public._ok('16_live_open_inviter_sets_invitee_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE denied_consent, r::text);
  -- The same as the inviter with RLS out of the way (table owner): the guard itself refuses it.
  BEGIN
    PERFORM set_config('request.app_user_id', '${UNRELATED_USER}', true);
    UPDATE public.tenant_partnerships SET invitee_tenant_id = '${PARTNER}' WHERE id = cid;
    PERFORM public._ok('16b_live_open_inviter_guard_denied', false, 'update succeeded');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public._ok('16b_live_open_inviter_guard_denied', SQLERRM ILIKE denied_consent, SQLERRM);
  END;
  PERFORM set_config('request.app_user_id', '', true);
  SELECT coalesce(invitee_tenant_id::text, 'null') INTO st FROM public.tenant_partnerships WHERE id = cid;
  PERFORM public._ok('16c_live_open_invitee_unchanged', st = 'null', st);
  -- The invitee's writer can redeem it. RLS does not let the invitee reach an open
  -- row (aws_write_tenant_partnerships matches the inviter side only while invitee
  -- is NULL), so this runs as the table owner to exercise the guard alone.
  BEGIN
    PERFORM set_config('request.app_user_id', '${PARTNER_USER}', true);
    UPDATE public.tenant_partnerships SET invitee_tenant_id = '${PARTNER}' WHERE id = cid;
    PERFORM public._ok('17_live_open_invitee_sets_invitee_ok', true, '');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public._ok('17_live_open_invitee_sets_invitee_ok', false, SQLERRM);
  END;
  PERFORM set_config('request.app_user_id', '', true);
  SELECT coalesce(invitee_tenant_id::text, 'null') || '/' || status INTO st FROM public.tenant_partnerships WHERE id = cid;
  PERFORM public._ok('17b_live_open_invitee_set', st = '${PARTNER}/active', st);
  DELETE FROM public.tenant_partnerships WHERE id = cid;

  -- Settings > Partner Code connect still works (trusted writer).
  r := public._exec('${OWNER}', $q$SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${SOURCE}'::uuid)$q$);
  PERFORM public._ok('20_connect_by_code_creates_live', (r->>'ok')::boolean AND (r->'val'->>'created')::boolean, r::text);
  cid := (r->'val'->>'partnership_id')::uuid;
  SELECT status INTO st FROM public.tenant_partnerships WHERE id = cid;
  PERFORM public._ok('20b_connect_row_active', st = 'active', st);

  -- The marker does not outlive the function call.
  PERFORM public._ok('21_marker_not_leaked', coalesce(current_setting('checksops.partnership_writer', true), '') = '', current_setting('checksops.partnership_writer', true));

  -- Settings revoke from either side still works, then reconnect by code reactivates.
  r := public._exec('${PARTNER_USER}', format('SELECT public.aws_revoke_tenant_partnership(%L::uuid)', cid));
  PERFORM public._ok('22_invitee_revoke_rpc_ok', (r->>'ok')::boolean AND (r->'val'->>'ok')::boolean, r::text);
  r := public._exec('${OWNER}', format($q$UPDATE public.tenant_partnerships SET status = 'active', revoked_at = NULL WHERE id = %L$q$, cid));
  PERFORM public._ok('23_inviter_direct_reactivate_denied', (r->>'ok')::boolean IS FALSE AND r->>'error' ILIKE denied_consent, r::text);
  r := public._exec('${OWNER}', $q$SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${SOURCE}'::uuid)$q$);
  PERFORM public._ok('24_connect_by_code_reactivates', (r->>'ok')::boolean AND (r->'val'->>'reactivated')::boolean, r::text);
  r := public._exec('${OWNER}', format('SELECT public.aws_revoke_tenant_partnership(%L::uuid)', cid));
  PERFORM public._ok('25_inviter_revoke_rpc_ok', (r->>'ok')::boolean AND (r->'val'->>'ok')::boolean, r::text);
  SELECT status INTO st FROM public.tenant_partnerships WHERE id = cid;
  PERFORM public._ok('25b_revoked', st = 'revoked', st);
END $$;
`);
  const policyCount = () => scalar(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_partnerships' AND policyname IN (${RETIRED_POLICIES.map((n) => `'${n}'`).join(', ')})`);
  assert.equal(policyCount(), '0', 'SQL 76 retires the Supabase-era write and admin policies');
  const results = JSON.parse(scalar(`SELECT coalesce(json_object_agg(test, json_build_object('ok', ok, 'detail', detail) ORDER BY test), '{}'::json) FROM public._results`));
  const failed = Object.entries(results).filter(([, row]) => row.ok !== true);
  assert.equal(failed.length, 0, `failed cases: ${JSON.stringify(failed, null, 2)}`);
  assert.equal(Object.keys(results).length, 31);

  // Review query: reconnect by code, then classify the live rows.
  psql(['-d', dbName, '-c', `
SELECT set_config('request.app_user_id', '${OWNER}', false);
SET ROLE checksops;
SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${SOURCE}'::uuid);
RESET ROLE;
`]);
  const review = JSON.parse(scalar(`SELECT coalesce(json_agg(json_build_object('code', invite_code, 'evidence', consent_evidence)), '[]') FROM (${read(SQL76_REVIEW).replace(/;\s*$/, '')}) q`));
  assert.deepEqual(review, [
    { code: 'LEGACY01', evidence: 'inviter_only_code_mismatch' },
    { code: PARTNER_CODE, evidence: 'invitee_partner_code' },
  ]);

  // Re-applying SQL 32 drops the marker: connect fails closed until SQL 76 is re-applied.
  file(path.join(SQL_DIR, '32_partner_share_lifecycle.sql'));
  const failClosed = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-c', `
SELECT set_config('request.app_user_id', '${OWNER}', false);
SET ROLE checksops;
SELECT public.aws_connect_partner_by_code('${OTHER_CODE}', '${SOURCE}'::uuid);
`]);
  assert.notEqual(failClosed.status, 0);
  assert.match(failClosed.stderr, /partnership_invitee_consent_required/);
  file(SQL76);
  const ok = scalar(`
SELECT set_config('request.app_user_id', '${OWNER}', false);
SET ROLE checksops;
SELECT (public.aws_connect_partner_by_code('${OTHER_CODE}', '${SOURCE}'::uuid))->>'ok';
`);
  assert.match(ok, /true$/);
  assert.equal(scalar(`SELECT status FROM public.tenant_partnerships WHERE inviter_tenant_id = '${SOURCE}' AND invitee_tenant_id = '${OTHER}'`), 'active');

  // Rollback removes the guard and the marker, is re-runnable, and does not
  // bring back the retired Supabase-era policies.
  const allPolicies = () => scalar(`SELECT string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\\n' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_partnerships'`);
  const policiesBeforeRollback = allPolicies();
  assert.match(policiesBeforeRollback, /^aws_write_tenant_partnerships:/m);
  file(SQL76_ROLLBACK);
  file(SQL76_ROLLBACK);
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgname = 'aws_tenant_partnership_consent_guard'`), '0');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'aws_tenant_partnership_consent_guard'`), '0');
  assert.equal(scalar(`SELECT coalesce(array_to_string(proconfig, ','), '') FROM pg_proc WHERE proname = 'aws_connect_partner_by_code'`), 'search_path=public,row_security=off');
  assert.equal(policyCount(), '0', 'rollback keeps the retired policies absent');
  // Every other policy on the table is untouched by the rollback.
  assert.equal(allPolicies(), policiesBeforeRollback);
});
