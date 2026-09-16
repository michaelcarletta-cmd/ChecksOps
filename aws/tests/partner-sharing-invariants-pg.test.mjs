import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = path.join(ROOT, 'rls/sql');
const AUTH_UID_SQL = path.join(ROOT, 'identity/sql/02_auth_uid_guc.sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FREEDOM_USER = 'a1000000-0000-4000-8000-000000000001';
const C1C_USER = 'a1000000-0000-4000-8000-000000000002';
const CHECK = 'c1000000-0000-4000-8000-000000000001';
const PAYEE = 'd1000000-0000-4000-8000-000000000001';
const ENDORSE = 'e1000000-0000-4000-8000-000000000001';
const PARTNER_CODE = 'C1CCODE1';

const run = (bin, args, opts = {}) => spawnSync(bin, args, {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  ...opts,
});

const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
};

test('Freedom-owned C1C-shared check keeps ownership and follows share/revoke/reshare', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-partner-invariants-${stamp}-`));
  const port = 55500 + (process.pid % 1000);
  const dbName = `partner_invariants_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `partner_sharing_invariants_pg_${stamp}.log`);
  let started = false;
  const logChunks = [];
  const note = (line) => { logChunks.push(line); };

  t.after(() => {
    try {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(artifactLog, logChunks.join('\n'), 'utf8');
    } catch { /* ignore */ }
    if (started) run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  });

  mustRun(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8']);
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
  const scalar = (sql) => psql(['-d', dbName, '-t', '-A', '-c', sql]).stdout.trim();

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-c', `
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT CONNECT ON DATABASE ${dbName} TO checksops;
`]);
  psql(['-d', dbName, '-f', path.join(SQL_DIR, '01_role_shim.sql')]);
  psql(['-d', dbName], `
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public TO checksops;
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
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
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY,
  name text,
  partner_code text UNIQUE,
  subscription_status text NOT NULL DEFAULT 'active'
);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  status text,
  check_stage text,
  deposit_recommendation text,
  ocr_status text,
  amount numeric
);
CREATE TABLE public.check_payees (
  id uuid PRIMARY KEY,
  check_id uuid NOT NULL,
  tenant_id uuid,
  payee_name text NOT NULL,
  payee_type text,
  endorsement_status text,
  endorsed_at timestamptz,
  contact_email text,
  contact_phone text,
  notification_sent_via text,
  notification_sent_at timestamptz,
  endorsement_token text,
  endorsement_token_expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.check_endorsements (
  id uuid PRIMARY KEY,
  check_id uuid NOT NULL,
  tenant_id uuid,
  payee_id uuid,
  payee_name text NOT NULL,
  payee_type text NOT NULL DEFAULT 'contractor',
  status text NOT NULL DEFAULT 'pending',
  signature_method text,
  signed_at timestamptz,
  request_sent_at timestamptz,
  last_reminder_at timestamptz,
  reminder_count int DEFAULT 0,
  contact_email text,
  contact_phone text,
  notes text,
  loss_draft_task_created boolean DEFAULT false,
  signature_image_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.signature_requests (
  id uuid PRIMARY KEY,
  check_intake_item_id uuid,
  claim_id uuid
);
CREATE TABLE public.signature_signers (
  id uuid PRIMARY KEY,
  signature_request_id uuid,
  signer_name text,
  signer_email text,
  signer_type text,
  signing_order int,
  status text,
  signed_at timestamptz,
  viewed_at timestamptz,
  expires_at timestamptz,
  delivery_status text,
  delivery_error text,
  email_sent_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid);
CREATE TABLE public.deposit_items (id uuid PRIMARY KEY, check_id uuid);
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL,
  source_tenant_id uuid NOT NULL,
  target_tenant_id uuid NOT NULL,
  shared_by uuid,
  access_level text NOT NULL DEFAULT 'read_only',
  created_at timestamptz DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT shared_checks_unique_active UNIQUE (check_id, source_tenant_id, target_tenant_id)
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role);
$$;
CREATE OR REPLACE FUNCTION public.lookup_tenant_by_partner_code(_code text)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH normalized AS (
    SELECT regexp_replace(upper(coalesce(_code, '')), '[^A-Z0-9]', '', 'g') AS code
  )
  SELECT t.id, t.name FROM normalized n JOIN public.tenants t
    ON t.subscription_status = 'active' AND t.partner_code = n.code
  LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.current_tenant_is_claim_funds_recipient(_claim_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.current_tenant_is_check_funds_recipient(_check_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_claim(_claim_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_check(_check_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
GRANT EXECUTE ON FUNCTION public.current_tenant_is_claim_funds_recipient(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.current_tenant_is_check_funds_recipient(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.mortgage_agent_can_view_claim(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.mortgage_agent_can_view_check(uuid) TO checksops, authenticated;
`);
  psql(['-d', dbName, '-f', AUTH_UID_SQL]);
  for (const name of [
    '10_owner_helpers_from_identity.sql',
    '02_helpers.sql',
    '03_grants.sql',
    '11_access_helpers.sql',
    '20_write_helpers.sql',
    '15_access_grants.sql',
  ]) {
    psql(['-d', dbName, '-f', path.join(SQL_DIR, name)]);
    note(`applied ${name}`);
  }

  const extractStmt = (sql, name) => {
    const re = new RegExp(`DROP POLICY IF EXISTS ${name}[\\s\\S]*?CREATE POLICY ${name}[\\s\\S]*?;`);
    const match = sql.match(re);
    if (!match) throw new Error(`missing policy ${name}`);
    return match[0];
  };
  const selectSql = fs.readFileSync(path.join(SQL_DIR, '12_final_select_policies.sql'), 'utf8');
  const writeProposed = fs.readFileSync(path.join(SQL_DIR, '21_proposed_write_policies.sql'), 'utf8');
  const writeComplete = fs.readFileSync(path.join(SQL_DIR, '24_complete_write_policies.sql'), 'utf8');

  psql(['-d', dbName], `
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_payees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_endorsements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_checks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.check_intake_items, public.check_payees, public.check_endorsements, public.shared_checks
TO authenticated, checksops;
GRANT SELECT ON TABLE public.tenant_users, public.user_roles, public.identity_accounts, public.profiles TO authenticated, checksops;
${extractStmt(selectSql, 'aws_select_check_intake_items')}
${extractStmt(selectSql, 'aws_select_check_payees')}
${extractStmt(selectSql, 'aws_select_check_endorsements')}
${extractStmt(selectSql, 'aws_select_shared_checks')}
${extractStmt(writeProposed, 'aws_write_check_intake_items')}
${extractStmt(writeComplete, 'aws_write_shared_checks')}
`);

  for (const name of [
    '34_c1c_partner_visibility.sql',
    '31_partner_safe_read.sql',
    '33_partner_stage_totals.sql',
    '32_partner_share_lifecycle.sql',
  ]) {
    psql(['-d', dbName, '-f', path.join(SQL_DIR, name)]);
    note(`applied ${name}`);
  }

  psql(['-d', dbName], `
INSERT INTO public.tenants (id, name, partner_code) VALUES
  ('${FREEDOM}', 'Freedom', 'FREEDOM1'),
  ('${C1C}', 'Condition One Commercial', '${PARTNER_CODE}');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${FREEDOM_USER}', 'admin'),
  ('${C1C_USER}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${FREEDOM}', '${FREEDOM_USER}', 'admin'),
  ('${C1C}', '${C1C_USER}', 'admin');
INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by, accepted_at)
VALUES ('${FREEDOM}', '${C1C}', '${PARTNER_CODE}', 'active', '${FREEDOM_USER}', now());
INSERT INTO public.check_intake_items (id, tenant_id, status, check_stage, deposit_recommendation, ocr_status, amount)
VALUES ('${CHECK}', '${FREEDOM}', 'needs_review', 'review', NULL, NULL, 100);
INSERT INTO public.check_payees (id, check_id, tenant_id, payee_name, endorsement_token)
VALUES ('${PAYEE}', '${CHECK}', NULL, 'Partner Payee', 'secret-token');
INSERT INTO public.check_endorsements (id, check_id, tenant_id, payee_name, status)
VALUES ('${ENDORSE}', '${CHECK}', NULL, 'Partner Payee', 'pending');
`);

  const matrix = `
CREATE TABLE public._inv (test text PRIMARY KEY, ok boolean NOT NULL, detail text);
CREATE OR REPLACE FUNCTION public._ok(_t text, _ok boolean, _d text DEFAULT '') RETURNS void
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public._inv VALUES (_t, _ok, _d) ON CONFLICT (test) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail; END; $$;
CREATE OR REPLACE FUNCTION public._as(_user uuid, _sql text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE _err text; _n bigint; _txt text;
BEGIN
  PERFORM set_config('request.app_user_id', _user::text, false);
  BEGIN
    EXECUTE 'SET ROLE checksops';
    IF _sql ~* '^SELECT' THEN
      EXECUTE 'SELECT COALESCE((' || _sql || ')::text, '''')' INTO _txt;
      EXECUTE 'RESET ROLE';
      PERFORM set_config('request.app_user_id', '', false);
      RETURN jsonb_build_object('ok', true, 'val', _txt, 'error', NULL);
    END IF;
    EXECUTE _sql;
    GET DIAGNOSTICS _n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', true, 'n', _n, 'error', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', false, 'val', NULL, 'error', _err);
  END;
END; $$;

DO $$
DECLARE
  r jsonb;
  sid uuid;
  owner_id uuid;
  n int;
  totals numeric;
BEGIN
  r := public._as('${FREEDOM_USER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK}'::uuid, '${C1C}'::uuid)$q$);
  PERFORM public._ok('share_create', (r->>'ok')::boolean AND (r->'val' IS NOT NULL), r::text);
  SELECT id INTO sid FROM public.shared_checks WHERE check_id = '${CHECK}'::uuid AND target_tenant_id = '${C1C}'::uuid;
  PERFORM public._ok('share_row', sid IS NOT NULL, coalesce(sid::text, 'missing'));

  SELECT tenant_id INTO owner_id FROM public.check_intake_items WHERE id = '${CHECK}'::uuid;
  PERFORM public._ok('remains_freedom_owned', owner_id = '${FREEDOM}'::uuid, owner_id::text);

  r := public._as('${FREEDOM_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK}'::uuid$q$);
  PERFORM public._ok('freedom_can_read', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);

  r := public._as('${C1C_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK}'::uuid$q$);
  PERFORM public._ok('c1c_can_read', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);

  r := public._as('${C1C_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE tenant_id = '${C1C}'::uuid$q$);
  PERFORM public._ok('c1c_owned_is_zero', (r->>'ok')::boolean AND (r->>'val') = '0', r::text);
  r := public._as('${C1C_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items$q$);
  PERFORM public._ok('zero_owned_not_zero_accessible', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);

  r := public._as('${C1C_USER}'::uuid, $q$SELECT COALESCE(sum(count),0) FROM public.get_check_stage_totals('${C1C}'::uuid)$q$);
  PERFORM public._ok('stage_totals_once', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);

  r := public._as('${C1C_USER}'::uuid, $q$SELECT count(*) FROM public.aws_partner_check_payees WHERE id = '${PAYEE}'::uuid$q$);
  PERFORM public._ok('partner_payee_visible', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);
  r := public._as('${C1C_USER}'::uuid, $q$SELECT count(*) FROM public.aws_partner_check_endorsements WHERE id = '${ENDORSE}'::uuid$q$);
  PERFORM public._ok('partner_endorsement_visible', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);

  r := public._as('${C1C_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK}'::uuid$q$);
  PERFORM public._ok('survives_refresh', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);

  r := public._as('${FREEDOM_USER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK}'::uuid, '${C1C}'::uuid)$q$);
  PERFORM public._ok('duplicate_idempotent', (r->>'ok')::boolean AND r->>'val' ILIKE '%"created": false%', r::text);
  SELECT count(*) INTO n FROM public.shared_checks WHERE check_id = '${CHECK}'::uuid AND target_tenant_id = '${C1C}'::uuid;
  PERFORM public._ok('duplicate_one_row', n = 1, n::text);
  SELECT tenant_id INTO owner_id FROM public.check_intake_items WHERE id = '${CHECK}'::uuid;
  PERFORM public._ok('duplicate_no_ownership_change', owner_id = '${FREEDOM}'::uuid, owner_id::text);

  r := public._as('${FREEDOM_USER}'::uuid, format('SELECT public.aws_revoke_shared_check(%L::uuid)', sid));
  PERFORM public._ok('revoke', (r->>'ok')::boolean, r::text);
  r := public._as('${C1C_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK}'::uuid$q$);
  PERFORM public._ok('revoke_removes_c1c', (r->>'ok')::boolean AND (r->>'val') = '0', r::text);
  SELECT tenant_id INTO owner_id FROM public.check_intake_items WHERE id = '${CHECK}'::uuid;
  PERFORM public._ok('revoke_keeps_freedom_owner', owner_id = '${FREEDOM}'::uuid, owner_id::text);

  r := public._as('${FREEDOM_USER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK}'::uuid, '${C1C}'::uuid)$q$);
  PERFORM public._ok('reshare', (r->>'ok')::boolean AND r->>'val' ILIKE '%"reactivated": true%', r::text);
  r := public._as('${C1C_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK}'::uuid$q$);
  PERFORM public._ok('reshare_restores_c1c', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);
  r := public._as('${C1C_USER}'::uuid, $q$SELECT COALESCE(sum(count),0) FROM public.get_check_stage_totals('${C1C}'::uuid)$q$);
  PERFORM public._ok('reshare_totals_once', (r->>'ok')::boolean AND (r->>'val') = '1', r::text);
  SELECT tenant_id INTO owner_id FROM public.check_intake_items WHERE id = '${CHECK}'::uuid;
  PERFORM public._ok('reshare_keeps_freedom_owner', owner_id = '${FREEDOM}'::uuid, owner_id::text);
END $$;
`;
  psql(['-d', dbName], matrix);
  const results = JSON.parse(scalar(`
SELECT coalesce(json_object_agg(test, json_build_object('ok', ok, 'detail', detail) ORDER BY test), '{}'::json)
FROM public._inv;
`));
  note(`matrix ${JSON.stringify(results)}`);
  const failed = Object.entries(results).filter(([, row]) => row.ok !== true);
  assert.equal(failed.length, 0, `failed cases: ${JSON.stringify(failed)}`);
  assert.equal(results.zero_owned_not_zero_accessible.ok, true);
  assert.equal(results.remains_freedom_owned.ok, true);
});
