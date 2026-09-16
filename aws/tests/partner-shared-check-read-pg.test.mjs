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

const SOURCE = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER = '33333333-3333-4333-8333-333333333333';
const UNRELATED = '44444444-4444-4444-8444-444444444444';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const PARTNER_USER = 'a1000000-0000-4000-8000-000000000002';
const OTHER_USER = 'a1000000-0000-4000-8000-000000000003';
const UNRELATED_USER = 'a1000000-0000-4000-8000-000000000004';
const PLATFORM = 'a1000000-0000-4000-8000-000000000099';
const CHECK_SHARED = 'c1000000-0000-4000-8000-000000000001';
const CHECK_UNRELATED = 'c1000000-0000-4000-8000-000000000002';
const CHECK_OTHER = 'c1000000-0000-4000-8000-000000000003';
const CHECK_REVOKED = 'c1000000-0000-4000-8000-000000000004';
const CHECK_FOREIGN = 'c1000000-0000-4000-8000-000000000005';
const CHECK_UNKNOWN = 'c1000000-0000-4000-8000-0000000000aa';
const PAYEE_SHARED = 'd1000000-0000-4000-8000-000000000001';
const ENDORSE_SHARED = 'e1000000-0000-4000-8000-000000000001';
const FILE_SHARED = 'f1000000-0000-4000-8000-000000000001';
const FILE_UNRELATED = 'f1000000-0000-4000-8000-000000000002';
const DEPOSIT_SHARED = 'b1000000-0000-4000-8000-000000000001';
const WALLET_SOURCE = 'aa100000-0000-4000-8000-000000000001';
const CHECKALT_ACCT = 'ab100000-0000-4000-8000-000000000001';
const PD_SHARED = 'f1000000-0000-4000-8000-000000000011';
const SIG_REQ = 'f1000000-0000-4000-8000-000000000012';
const SIGNER_SHARED = 'f1000000-0000-4000-8000-000000000013';
const TOKEN_ENDORSE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TOKEN_PAYEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_PD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN_SIGNER = 'raw-signer-access-token-32b-value';

const readRepoSql = (rel) => fs.readFileSync(path.join(SQL_DIR, rel), 'utf8');

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

const extractStmt = (sql, name) => {
  const re = new RegExp(`DROP POLICY IF EXISTS ${name}[\\s\\S]*?CREATE POLICY ${name}[\\s\\S]*?;`);
  const match = sql.match(re);
  if (!match) throw new Error(`missing policy ${name}`);
  return match[0];
};

test('disposable PostgreSQL shared-check READ matrix and write denials', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  assert.equal(fs.existsSync(AUTH_UID_SQL), true);

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-shared-check-read-${stamp}-`));
  const port = 55300 + (process.pid % 1000);
  const dbName = `shared_check_read_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `partner_shared_check_read_pg_${stamp}.log`);
  let started = false;
  const logChunks = [];
  const note = (line) => { logChunks.push(line); };

  const stopCluster = () => {
    if (started) {
      run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']);
      started = false;
    }
    fs.rmSync(pgData, { recursive: true, force: true });
  };
  t.after(() => {
    try {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(artifactLog, logChunks.join('\n'), 'utf8');
    } catch { /* ignore artifact write failures */ }
    stopCluster();
  });

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
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };
  const scalar = (sql, db = dbName) => psql(['-d', db, '-A', '-t', '-c', sql]).stdout.trim();

  const proof = psql(['-d', 'postgres', '-A', '-t', '-c', `
SELECT json_build_object(
  'version', version(),
  'listen_addresses', current_setting('listen_addresses'),
  'data_directory', current_setting('data_directory'),
  'unix_socket_directories', current_setting('unix_socket_directories'),
  'port', current_setting('port'),
  'inet_server_addr', inet_server_addr(),
  'is_rds', current_setting('rds.superuser', true) IS NOT NULL,
  'supabase_admin', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
);
`]).stdout.trim();
  note(`target_proof ${proof}`);
  const target = JSON.parse(proof);
  assert.equal(target.listen_addresses, '');
  assert.equal(target.data_directory, pgData);
  assert.equal(String(target.port), String(port));
  assert.equal(target.inet_server_addr, null);
  assert.equal(target.is_rds, false);
  assert.match(target.version, /PostgreSQL 16/);

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-c', `
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT CONNECT ON DATABASE ${dbName} TO checksops;
`]);
  psql(['-d', dbName, '-f', path.join(SQL_DIR, '01_role_shim.sql')]);

  const bootstrap = `
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public TO checksops;
GRANT USAGE ON SCHEMA public TO PUBLIC;

CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');

CREATE TABLE public.identity_accounts (
  application_user_id uuid PRIMARY KEY,
  email text,
  status text
);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text
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
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  status text
);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  tenant_id uuid
);
CREATE TABLE public.loss_draft_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid,
  check_intake_item_id uuid
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
  token text,
  token_expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.check_files (
  id uuid PRIMARY KEY,
  check_intake_item_id uuid NOT NULL
);
CREATE TABLE public.shared_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL,
  source_tenant_id uuid NOT NULL,
  target_tenant_id uuid NOT NULL,
  shared_by uuid NOT NULL,
  access_level text NOT NULL DEFAULT 'read',
  revoked_at timestamptz
);
CREATE TABLE public.deposit_items (
  id uuid PRIMARY KEY,
  check_id uuid,
  provider_payload jsonb,
  provider_response jsonb,
  provider_status_raw jsonb,
  increase_raw_response jsonb
);
CREATE TABLE public.claim_checks (
  id uuid PRIMARY KEY,
  check_intake_item_id uuid
);
CREATE TABLE public.check_payment_directions (
  id uuid PRIMARY KEY,
  check_id uuid NOT NULL,
  claim_id uuid,
  contractor_name text,
  request_status text NOT NULL DEFAULT 'pending',
  decision text,
  expires_at timestamptz,
  secure_token uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.signature_requests (
  id uuid PRIMARY KEY,
  check_intake_item_id uuid,
  claim_id uuid,
  document_name text NOT NULL DEFAULT 'doc',
  document_path text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  last_provider_response text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.signature_signers (
  id uuid PRIMARY KEY,
  signature_request_id uuid NOT NULL,
  signer_name text NOT NULL,
  signer_email text NOT NULL,
  signer_type text NOT NULL DEFAULT 'payee',
  signing_order int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  access_token text,
  token_hash text,
  expires_at timestamptz,
  signed_at timestamptz,
  viewed_at timestamptz,
  delivery_status text,
  delivery_error text,
  email_sent_at timestamptz,
  signature_data text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.checkalt_tenant_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid
);
CREATE TABLE public.payment_wallets (
  id uuid PRIMARY KEY,
  tenant_id uuid
);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id AND ur.role = _role
  );
$$;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO checksops, authenticated;

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
`;
  psql(['-d', dbName], bootstrap);
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

  const selectSql = readRepoSql('12_final_select_policies.sql');
  const writeComplete = readRepoSql('24_complete_write_policies.sql');
  const writeProposed = readRepoSql('21_proposed_write_policies.sql');
  const policies = [
    extractStmt(selectSql, 'aws_select_check_intake_items'),
    extractStmt(selectSql, 'aws_select_check_payees'),
    extractStmt(selectSql, 'aws_select_check_endorsements'),
    extractStmt(selectSql, 'aws_select_check_files'),
    extractStmt(selectSql, 'aws_select_check_payment_directions'),
    extractStmt(selectSql, 'aws_select_deposit_items'),
    extractStmt(selectSql, 'aws_select_shared_checks'),
    extractStmt(selectSql, 'aws_select_signature_requests'),
    extractStmt(selectSql, 'aws_select_signature_signers'),
    extractStmt(selectSql, 'aws_select_checkalt_tenant_accounts'),
    extractStmt(selectSql, 'aws_select_payment_wallets'),
    extractStmt(writeProposed, 'aws_write_check_intake_items'),
    extractStmt(writeProposed, 'aws_write_check_endorsements'),
    extractStmt(writeComplete, 'aws_write_check_payees'),
    extractStmt(writeComplete, 'aws_write_shared_checks'),
  ].join('\n\n');

  psql(['-d', dbName], `
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_payees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_endorsements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deposit_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_payment_directions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_signers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.check_intake_items,
  public.check_payees,
  public.check_endorsements,
  public.check_files,
  public.shared_checks,
  public.deposit_items,
  public.checkalt_tenant_accounts,
  public.payment_wallets,
  public.check_payment_directions,
  public.signature_requests,
  public.signature_signers,
  public.claim_checks
TO authenticated, checksops;
GRANT SELECT ON TABLE public.tenant_users, public.user_roles, public.identity_accounts, public.profiles TO authenticated, checksops;
${policies}
`);

  psql(['-d', dbName], `
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${PLATFORM}', 'checksopsadmin@gmail.com', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${OWNER}', 'admin'),
  ('${PARTNER_USER}', 'admin'),
  ('${OTHER_USER}', 'admin'),
  ('${UNRELATED_USER}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${SOURCE}', '${OWNER}', 'admin'),
  ('${PARTNER}', '${PARTNER_USER}', 'admin'),
  ('${OTHER_PARTNER}', '${OTHER_USER}', 'admin'),
  ('${UNRELATED}', '${UNRELATED_USER}', 'admin');
INSERT INTO public.check_intake_items (id, tenant_id, status) VALUES
  ('${CHECK_SHARED}', '${SOURCE}', 'received'),
  ('${CHECK_UNRELATED}', '${SOURCE}', 'received'),
  ('${CHECK_OTHER}', '${SOURCE}', 'received'),
  ('${CHECK_REVOKED}', '${SOURCE}', 'received'),
  ('${CHECK_FOREIGN}', '${UNRELATED}', 'received');
INSERT INTO public.check_payees (id, check_id, tenant_id, payee_name, endorsement_status, endorsement_token) VALUES
  ('${PAYEE_SHARED}', '${CHECK_SHARED}', '${SOURCE}', 'Shared Payee', 'pending', '${TOKEN_PAYEE}');
INSERT INTO public.check_endorsements (id, check_id, tenant_id, payee_name, status, token) VALUES
  ('${ENDORSE_SHARED}', '${CHECK_SHARED}', '${SOURCE}', 'Shared Payee', 'pending', '${TOKEN_ENDORSE}');
INSERT INTO public.check_files (id, check_intake_item_id) VALUES
  ('${FILE_SHARED}', '${CHECK_SHARED}'),
  ('${FILE_UNRELATED}', '${CHECK_UNRELATED}');
INSERT INTO public.deposit_items (id, check_id, provider_payload) VALUES
  ('${DEPOSIT_SHARED}', '${CHECK_SHARED}', '{"secret":"deposit-provider-json"}'::jsonb);
INSERT INTO public.check_payment_directions (id, check_id, request_status, secure_token) VALUES
  ('${PD_SHARED}', '${CHECK_SHARED}', 'pending', '${TOKEN_PD}'::uuid);
INSERT INTO public.signature_requests (id, check_intake_item_id, document_name, document_path, status) VALUES
  ('${SIG_REQ}', '${CHECK_SHARED}', 'Direction to Pay', 'check-intake/shared/dtp.pdf', 'sent');
INSERT INTO public.signature_signers (id, signature_request_id, signer_name, signer_email, status, access_token, token_hash) VALUES
  ('${SIGNER_SHARED}', '${SIG_REQ}', 'Insured', 'insured@example.test', 'pending', '${TOKEN_SIGNER}', 'hash-of-raw-token');
INSERT INTO public.checkalt_tenant_accounts (id, tenant_id) VALUES
  ('${CHECKALT_ACCT}', '${SOURCE}');
INSERT INTO public.payment_wallets (id, tenant_id) VALUES
  ('${WALLET_SOURCE}', '${SOURCE}');
INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, shared_by, revoked_at) VALUES
  ('${CHECK_SHARED}', '${SOURCE}', '${PARTNER}', '${OWNER}', NULL),
  ('${CHECK_OTHER}', '${SOURCE}', '${OTHER_PARTNER}', '${OWNER}', NULL),
  ('${CHECK_REVOKED}', '${SOURCE}', '${PARTNER}', '${OWNER}', now());
`);
  psql(['-d', dbName, '-f', path.join(SQL_DIR, '31_partner_safe_read.sql')]);
  note('applied 31_partner_safe_read.sql');
  psql(['-d', dbName, '-f', path.join(SQL_DIR, '33_partner_stage_totals.sql')]);
  note('applied 33_partner_stage_totals.sql');

  const matrixSql = `
CREATE TABLE public._share_results (
  test text PRIMARY KEY,
  ok boolean NOT NULL,
  detail text
);
CREATE OR REPLACE FUNCTION public._share_ok(_test text, _ok boolean, _detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public._share_results(test, ok, detail) VALUES (_test, _ok, _detail)
  ON CONFLICT (test) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._as_count(_user uuid, _sql text)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  _err text;
  _n int := 0;
BEGIN
  PERFORM set_config('request.app_user_id', _user::text, false);
  BEGIN
    EXECUTE 'SET ROLE checksops';
    EXECUTE _sql INTO _n;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', true, 'n', _n, 'error', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', false, 'n', 0, 'error', _err);
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._as_exec(_user uuid, _sql text)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  _err text;
  _n int := 0;
BEGIN
  PERFORM set_config('request.app_user_id', _user::text, false);
  BEGIN
    EXECUTE 'SET ROLE checksops';
    EXECUTE _sql;
    GET DIAGNOSTICS _n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', true, 'n', _n, 'error', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', false, 'n', 0, 'error', _err);
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._as_bool(_user uuid, _sql text)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  _err text;
  _val boolean;
BEGIN
  PERFORM set_config('request.app_user_id', _user::text, false);
  BEGIN
    EXECUTE 'SET ROLE checksops';
    EXECUTE _sql INTO _val;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', true, 'val', _val, 'error', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', false, 'val', NULL, 'error', _err);
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._as_scalar(_user uuid, _sql text)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  _err text;
  _val text;
BEGIN
  PERFORM set_config('request.app_user_id', _user::text, false);
  BEGIN
    EXECUTE 'SET ROLE checksops';
    EXECUTE _sql INTO _val;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', true, 'val', _val, 'error', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', false, 'val', NULL, 'error', _err);
  END;
END;
$fn$;

DO $$
DECLARE
  r jsonb;
BEGIN
  r := public._as_count('${OWNER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_SHARED}'::uuid$q$);
  PERFORM public._share_ok('1_owner_own_check_read', (r->>'n')::int = 1, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_SHARED}'::uuid$q$);
  PERFORM public._share_ok('2_partner_shared_check_read', (r->>'n')::int = 1, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_UNRELATED}'::uuid$q$);
  PERFORM public._share_ok('3_partner_unrelated_check_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_OTHER}'::uuid$q$);
  PERFORM public._share_ok('4_partner_other_partner_share_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_REVOKED}'::uuid$q$);
  PERFORM public._share_ok('5_revoked_partner_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${OWNER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_REVOKED}'::uuid$q$);
  PERFORM public._share_ok('6_owner_after_revoke_read', (r->>'n')::int = 1, r::text);

  r := public._as_exec('${PARTNER_USER}'::uuid, $q$UPDATE public.check_intake_items SET status = 'tampered' WHERE id = '${CHECK_SHARED}'::uuid$q$);
  PERFORM public._share_ok('7_partner_check_update_deny', (r->>'ok')::boolean AND (r->>'n')::int = 0, r::text);

  r := public._as_exec('${PARTNER_USER}'::uuid, $q$DELETE FROM public.check_intake_items WHERE id = '${CHECK_SHARED}'::uuid$q$);
  PERFORM public._share_ok('8_partner_check_delete_deny', (r->>'ok')::boolean AND (r->>'n')::int = 0, r::text);

  r := public._as_exec('${PARTNER_USER}'::uuid, $q$UPDATE public.check_payees SET payee_name = 'tampered' WHERE id = '${PAYEE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('9_partner_payee_mutation_deny', (r->>'ok')::boolean AND (r->>'n')::int = 0, r::text);

  r := public._as_exec('${PARTNER_USER}'::uuid, $q$UPDATE public.check_endorsements SET status = 'signed' WHERE id = '${ENDORSE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('10_partner_endorsement_mutation_deny', (r->>'ok')::boolean AND (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.checkalt_tenant_accounts WHERE id = '${CHECKALT_ACCT}'::uuid$q$);
  PERFORM public._share_ok('11_partner_checkalt_account_read_deny', (r->>'n')::int = 0, r::text);

  r := public._as_bool('${PARTNER_USER}'::uuid, $q$SELECT public.aws_can_write_check('${CHECK_SHARED}'::uuid)$q$);
  PERFORM public._share_ok('12_partner_write_helper_deny', (r->>'ok')::boolean AND (r->>'val')::boolean IS FALSE, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.payment_wallets WHERE id = '${WALLET_SOURCE}'::uuid$q$);
  PERFORM public._share_ok('13_partner_wallet_read_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_UNKNOWN}'::uuid$q$);
  PERFORM public._share_ok('14_manipulated_check_id_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_FOREIGN}'::uuid$q$);
  PERFORM public._share_ok('14b_unrelated_tenant_check_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${UNRELATED_USER}'::uuid, $q$SELECT count(*) FROM public.check_intake_items WHERE id = '${CHECK_SHARED}'::uuid$q$);
  PERFORM public._share_ok('14c_unrelated_tenant_shared_check_deny', (r->>'n')::int = 0, r::text);

  r := public._as_exec('${OWNER}'::uuid, $q$UPDATE public.check_intake_items SET status = 'owner-ok' WHERE id = '${CHECK_SHARED}'::uuid$q$);
  PERFORM public._share_ok('15_owner_update_unchanged', (r->>'ok')::boolean AND (r->>'n')::int = 1, r::text);

  r := public._as_count('${PLATFORM}'::uuid, $q$SELECT count(*) FROM public.check_intake_items$q$);
  PERFORM public._share_ok('15b_platform_owner_read_all', (r->>'n')::int = 5, r::text);

  r := public._as_count('${OWNER}'::uuid, $q$SELECT count(*) FROM public.check_endorsements WHERE id = '${ENDORSE_SHARED}'::uuid AND token = '${TOKEN_ENDORSE}'$q$);
  PERFORM public._share_ok('owner_endorsement_token_read', (r->>'n')::int = 1, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_endorsements WHERE id = '${ENDORSE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_base_endorsement_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.aws_partner_check_endorsements WHERE id = '${ENDORSE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_safe_endorsement_read', (r->>'n')::int = 1, r::text);

  r := public._as_scalar('${PARTNER_USER}'::uuid, $q$SELECT COALESCE(to_jsonb(t)::text, '') FROM public.aws_partner_check_endorsements t WHERE id = '${ENDORSE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_safe_endorsement_no_token', (r->>'ok')::boolean AND (r->>'val') NOT LIKE '%${TOKEN_ENDORSE}%' AND (r->>'val') LIKE '%pending%', r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_payees WHERE id = '${PAYEE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_base_payee_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.aws_partner_check_payees WHERE id = '${PAYEE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_safe_payee_read', (r->>'n')::int = 1, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT COALESCE(sum(count),0) FROM public.get_check_stage_totals('${PARTNER}'::uuid)$q$);
  PERFORM public._share_ok('partner_stage_totals_include_shared', (r->>'n')::int >= 1, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT COALESCE(sum(count),0) FROM public.get_check_stage_totals('${SOURCE}'::uuid)$q$);
  PERFORM public._share_ok('partner_stage_totals_other_tenant_empty', (r->>'n')::int = 0, r::text);

  r := public._as_scalar('${PARTNER_USER}'::uuid, $q$SELECT COALESCE(to_jsonb(t)::text, '') FROM public.aws_partner_check_payees t WHERE id = '${PAYEE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_safe_payee_no_token', (r->>'ok')::boolean AND (r->>'val') NOT LIKE '%${TOKEN_PAYEE}%', r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_payment_directions WHERE id = '${PD_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_payment_direction_base_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${OWNER}'::uuid, $q$SELECT count(*) FROM public.check_payment_directions WHERE id = '${PD_SHARED}'::uuid AND secure_token = '${TOKEN_PD}'::uuid$q$);
  PERFORM public._share_ok('owner_payment_direction_token_read', (r->>'n')::int = 1, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.signature_signers WHERE id = '${SIGNER_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_base_signer_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.aws_partner_signature_signers WHERE id = '${SIGNER_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_safe_signer_read', (r->>'n')::int = 1, r::text);

  r := public._as_scalar('${PARTNER_USER}'::uuid, $q$SELECT COALESCE(to_jsonb(t)::text, '') FROM public.aws_partner_signature_signers t WHERE id = '${SIGNER_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_safe_signer_no_token', (r->>'ok')::boolean AND (r->>'val') NOT LIKE '%${TOKEN_SIGNER}%' AND (r->>'val') LIKE '%Insured%', r::text);

  r := public._as_count('${OWNER}'::uuid, $q$SELECT count(*) FROM public.signature_signers WHERE id = '${SIGNER_SHARED}'::uuid AND access_token = '${TOKEN_SIGNER}'$q$);
  PERFORM public._share_ok('owner_signer_token_read', (r->>'n')::int = 1, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.deposit_items WHERE id = '${DEPOSIT_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_deposit_item_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${UNRELATED_USER}'::uuid, $q$SELECT count(*) FROM public.aws_partner_check_endorsements$q$);
  PERFORM public._share_ok('unrelated_partner_view_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.aws_partner_check_endorsements WHERE check_id = '${CHECK_OTHER}'::uuid$q$);
  PERFORM public._share_ok('partner_safe_other_check_deny', (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.aws_partner_check_endorsements WHERE check_id = '${CHECK_REVOKED}'::uuid$q$);
  PERFORM public._share_ok('revoked_partner_safe_deny', (r->>'n')::int = 0, r::text);

  r := public._as_exec('${PARTNER_USER}'::uuid, $q$UPDATE public.aws_partner_check_endorsements SET status = 'signed' WHERE id = '${ENDORSE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('partner_safe_view_write_deny', (r->>'ok')::boolean IS FALSE OR (r->>'n')::int = 0, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_files WHERE id = '${FILE_SHARED}'::uuid$q$);
  PERFORM public._share_ok('child_file_shared_read', (r->>'n')::int = 1, r::text);

  r := public._as_count('${PARTNER_USER}'::uuid, $q$SELECT count(*) FROM public.check_files WHERE id = '${FILE_UNRELATED}'::uuid$q$);
  PERFORM public._share_ok('child_file_unrelated_deny', (r->>'n')::int = 0, r::text);

  r := public._as_bool('${PARTNER_USER}'::uuid, $q$SELECT public.aws_can_access_check('${CHECK_SHARED}'::uuid)$q$);
  PERFORM public._share_ok('helper_partner_shared_true', (r->>'val')::boolean IS TRUE, r::text);

  r := public._as_bool('${PARTNER_USER}'::uuid, $q$SELECT public.aws_can_access_check('${CHECK_REVOKED}'::uuid)$q$);
  PERFORM public._share_ok('helper_revoked_false', (r->>'val')::boolean IS FALSE, r::text);

  r := public._as_bool('${OWNER}'::uuid, $q$SELECT public.aws_can_write_check('${CHECK_SHARED}'::uuid)$q$);
  PERFORM public._share_ok('helper_owner_write_true', (r->>'val')::boolean IS TRUE, r::text);

  r := public._as_bool('${PARTNER_USER}'::uuid, $q$SELECT public.aws_is_active_shared_check_target('${CHECK_SHARED}'::uuid)$q$);
  PERFORM public._share_ok('share_target_partner_true', (r->>'val')::boolean IS TRUE, r::text);

  r := public._as_bool('${UNRELATED_USER}'::uuid, $q$SELECT public.aws_is_active_shared_check_target('${CHECK_SHARED}'::uuid)$q$);
  PERFORM public._share_ok('share_target_unrelated_false', (r->>'val')::boolean IS FALSE, r::text);

  r := public._as_exec('${PARTNER_USER}'::uuid, $q$INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, shared_by) VALUES ('${CHECK_UNRELATED}'::uuid, '${SOURCE}'::uuid, '${PARTNER}'::uuid, '${PARTNER_USER}'::uuid)$q$);
  PERFORM public._share_ok('partner_cannot_create_share', (r->>'ok')::boolean IS FALSE OR (r->>'n')::int = 0, r::text);
END $$;
`;
  psql(['-d', dbName], matrixSql);

  const results = JSON.parse(scalar(`
SELECT coalesce(json_object_agg(test, json_build_object('ok', ok, 'detail', detail) ORDER BY test), '{}'::json)
FROM public._share_results;
`));
  note(`matrix ${JSON.stringify(results)}`);
  const failed = Object.entries(results).filter(([, row]) => row.ok !== true);
  assert.equal(failed.length, 0, `failed cases: ${JSON.stringify(failed)}`);

  const stillOwner = scalar(`SELECT status FROM public.check_intake_items WHERE id = '${CHECK_SHARED}'`);
  assert.equal(stillOwner, 'owner-ok');
  const stillPayee = scalar(`SELECT payee_name FROM public.check_payees WHERE id = '${PAYEE_SHARED}'`);
  assert.equal(stillPayee, 'Shared Payee');
  const stillEndorse = scalar(`SELECT status FROM public.check_endorsements WHERE id = '${ENDORSE_SHARED}'`);
  assert.equal(stillEndorse, 'pending');
  const shareCount = Number(scalar(`SELECT count(*) FROM public.shared_checks`));
  assert.equal(shareCount, 3);
});
