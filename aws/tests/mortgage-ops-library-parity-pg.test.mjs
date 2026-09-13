import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';
const SQL_DIR = path.join(ROOT, 'rls/sql');
const AUTH_UID_SQL = path.join(ROOT, 'identity/sql/02_auth_uid_guc.sql');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = 'a1000000-0000-4000-8000-000000000001';
const OPERATOR_ID = 'a1000000-0000-4000-8000-000000000003';
const AGENT_ID = 'a1000000-0000-4000-8000-000000000004';
const AGENT_UNASSIGNED = 'a1000000-0000-4000-8000-000000000005';
const DOC_MORT = 'b1000000-0000-4000-8000-000000000001';
const DOC_TMPL = 'b1000000-0000-4000-8000-000000000002';
const DOC_OFF = 'b1000000-0000-4000-8000-000000000003';
const DOC_B = 'b1000000-0000-4000-8000-000000000004';
const DOC_CLOSED = 'b1000000-0000-4000-8000-000000000005';
const REQ_OPEN = 'c1000000-0000-4000-8000-000000000001';
const REQ_DONE = 'c1000000-0000-4000-8000-000000000003';
const REQ_CAN = 'c1000000-0000-4000-8000-000000000004';
const ATTACH_PATH = `${TENANT_A}/library/mortgage/w9.pdf`;
const TEMPLATE_PATH = `${TENANT_A}/library/template/tpa.pdf`;
const OFF_PATH = `${TENANT_A}/library/mortgage/license.pdf`;
const OTHER_PATH = `${TENANT_B}/library/mortgage/w9.pdf`;
const CLOSED_PATH = `${TENANT_A}/library/mortgage/closed-only.pdf`;
const FORGED_PATH = `${TENANT_A}/verification/kyc-passport.pdf`;

const readRepoSql = (rel) => fs.readFileSync(path.join(SQL_DIR, rel), 'utf8');

const run = (bin, args, opts = {}) => {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...opts,
  });
  return result;
};

const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) {
    throw new Error(
      `${bin} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
};

test('disposable PostgreSQL mortgage library RLS matrix', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  assert.equal(fs.existsSync(AUTH_UID_SQL), true);

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-hotfix-rls-${stamp}-`));
  const port = 55000 + (process.pid % 1000);
  const dbName = `hotfix_rls_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `mortgage_ops_hotfix_pg_${stamp}.log`);
  let started = false;
  const logChunks = [];
  const note = (line) => {
    logChunks.push(line);
  };

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
  const start = mustRun(path.join(PG_BIN, 'pg_ctl'), [
    '-D', pgData,
    '-l', logPath,
    '-w',
    'start',
  ]);
  started = true;
  note(`pg_ctl start: ${start.stdout.trim()}`);

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
  'inet_server_port', inet_server_port(),
  'rds_extensions', current_setting('rds.extensions', true),
  'is_rds', current_setting('rds.superuser', true) IS NOT NULL,
  'supabase_admin', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'),
  'rdsadmin', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rdsadmin'),
  'authenticator', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator')
);
`]).stdout.trim();
  note(`target_proof ${proof}`);
  const target = JSON.parse(proof);
  assert.equal(target.listen_addresses, '');
  assert.equal(target.data_directory, pgData);
  assert.equal(String(target.unix_socket_directories), pgData);
  assert.equal(String(target.port), String(port));
  assert.equal(target.inet_server_addr, null);
  assert.equal(target.is_rds, false);
  assert.equal(target.supabase_admin, false);
  assert.equal(target.rdsadmin, false);
  assert.equal(target.authenticator, false);
  assert.match(target.version, /PostgreSQL 16/);
  assert.doesNotMatch(target.data_directory, /\/var\/lib\/postgresql/);
  assert.doesNotMatch(pgData, /supabase|rds|staging|prod/i);

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  note(`database ${dbName}`);

  psql(['-d', dbName, '-c', `
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT CONNECT ON DATABASE ${dbName} TO checksops;
`]);
  psql(['-d', dbName, '-f', path.join(SQL_DIR, '01_role_shim.sql')]);
  note('applied 01_role_shim.sql');

  const sql24 = readRepoSql('24_complete_write_policies.sql');
  const stubTables = [...new Set(
    [...sql24.matchAll(/ON public\.([a-z0-9_]+);/g)].map((match) => match[1]),
  )  ].filter((name) => ![
    'mortgage_request_library_documents',
    'mortgage_handling_requests',
    'tenant_documents',
    'tenant_users',
    'user_roles',
    'profiles',
    'identity_accounts',
    'claims',
    'check_intake_items',
    'deposit_items',
    'loss_draft_tracking',
    'signature_requests',
  ].includes(name));

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
CREATE TABLE public.tenant_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  doc_type text NOT NULL,
  file_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size bigint,
  auto_share_mortgage_ops boolean NOT NULL DEFAULT false
);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  status text NOT NULL,
  assigned_employee_id uuid
);
CREATE TABLE public.mortgage_request_library_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.mortgage_handling_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  tenant_document_id uuid REFERENCES public.tenant_documents(id) ON DELETE SET NULL,
  doc_type text,
  file_name text NOT NULL,
  file_path text NOT NULL,
  bucket text NOT NULL DEFAULT 'tenant-documents',
  mime_type text,
  file_size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, file_path)
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

CREATE TABLE IF NOT EXISTS public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  tenant_id uuid
);
CREATE TABLE IF NOT EXISTS public.check_intake_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid
);
CREATE TABLE IF NOT EXISTS public.deposit_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid,
  tenant_id uuid,
  batch_id uuid
);
CREATE TABLE IF NOT EXISTS public.loss_draft_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid,
  tenant_id uuid
);
CREATE TABLE IF NOT EXISTS public.signature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid,
  check_intake_item_id uuid,
  tenant_id uuid
);

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

CREATE OR REPLACE FUNCTION public.share_library_docs_to_mortgage_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_share_library_docs_to_mortgage_request ON public.mortgage_handling_requests;
CREATE TRIGGER trg_share_library_docs_to_mortgage_request
AFTER INSERT ON public.mortgage_handling_requests
FOR EACH ROW EXECUTE FUNCTION public.share_library_docs_to_mortgage_request();

ALTER TABLE public.mortgage_request_library_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mortgage_request_library_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mortgage_request_library_documents TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mortgage_handling_requests TO authenticated, checksops;
GRANT SELECT ON TABLE public.tenant_documents TO authenticated, checksops;
GRANT SELECT ON TABLE public.tenant_users TO authenticated, checksops;
GRANT SELECT ON TABLE public.user_roles TO authenticated, checksops;

${stubTables.map((table) => `
CREATE TABLE IF NOT EXISTS public.${table} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  org_id uuid,
  user_id uuid,
  check_intake_item_id uuid,
  check_id uuid,
  claim_id uuid,
  loss_draft_id uuid,
  deposit_item_id uuid,
  referrer_tenant_id uuid,
  referred_tenant_id uuid,
  batch_id uuid,
  sender_tenant_id uuid,
  recipient_tenant_id uuid,
  assigned_employee_id uuid,
  request_id uuid,
  document_id uuid,
  application_user_id uuid,
  created_by uuid
);
ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO authenticated, checksops;
`).join('\n')}
`;

  psql(['-d', dbName], bootstrap);
  const policyColSkip = new Set([
    'select', 'from', 'where', 'and', 'or', 'not', 'in', 'exists', 'true', 'false',
    'null', 'on', 'join', 'as', 'public', 'auth', 'uid', 'authenticated', 'uuid',
    'text', 'coalesce', 'lower', 'array', 'any', 'all', 'using', 'check', 'for',
    'to', 'drop', 'policy', 'if', 'create', 'table', 'begin', 'end',
  ]);
  const policyColumns = new Set();
  for (const block of sql24.matchAll(/USING \(([\s\S]*?)\)\n  WITH CHECK \(([\s\S]*?)\);/g)) {
    for (const token of `${block[1]} ${block[2]}`.matchAll(/\b([a-z][a-z0-9_]*)\b/g)) {
      const name = token[1];
      if (policyColSkip.has(name)) continue;
      if (/^(aws_|is_|has_|current_)/.test(name)) continue;
      policyColumns.add(name);
    }
  }
  const alterTargets = [
    ...stubTables,
    'deposit_items',
    'claims',
    'check_intake_items',
    'loss_draft_tracking',
    'signature_requests',
    'profiles',
  ];
  const alterSql = alterTargets.flatMap((table) => [...policyColumns].sort().map((col) => {
    const typ = col === 'id' || /_id$/.test(col) ? 'uuid' : 'text';
    return `ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS ${col} ${typ};`;
  })).join('\n');
  psql(['-d', dbName], alterSql);
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

  psql(['-d', dbName, '-f', path.join(SQL_DIR, '24_complete_write_policies.sql')]);
  note('applied 24 before 29');
  const after24 = JSON.parse(scalar(`
SELECT json_build_object(
  'write_cmds', coalesce((
     SELECT json_agg(cmd ORDER BY cmd)
     FROM pg_policies
     WHERE tablename = 'mortgage_request_library_documents'
       AND policyname = 'aws_write_mortgage_request_library_documents'
  ), '[]'::json),
  'write_count', (
     SELECT count(*) FROM pg_policies
     WHERE tablename = 'mortgage_request_library_documents'
       AND policyname = 'aws_write_mortgage_request_library_documents'
  ),
  'all_for_table', (
     SELECT coalesce(json_agg(json_build_object('policy', policyname, 'cmd', cmd)), '[]'::json)
     FROM pg_policies
     WHERE tablename = 'mortgage_request_library_documents'
  )
);
`));
  note(`policies_after_24 ${JSON.stringify(after24)}`);
  assert.equal(after24.write_count, 0, '24 must leave the library table without a write policy');
  assert.deepEqual(after24.write_cmds, []);

  psql(['-d', dbName, '-f', path.join(SQL_DIR, '29_mortgage_ops_library_parity.sql')]);
  note('applied 29 after 24');

  const seed = `
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${OWNER_ID}', 'admin'),
  ('${AGENT_ID}', 'mortgage_agent'),
  ('${AGENT_UNASSIGNED}', 'mortgage_agent');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${OWNER_ID}', 'admin'),
  ('${TENANT_A}', '${OPERATOR_ID}', 'operator'),
  ('${TENANT_A}', '${AGENT_ID}', 'viewer'),
  ('${TENANT_B}', '${OWNER_ID}', 'admin');
INSERT INTO public.tenant_documents
  (id, tenant_id, doc_type, file_path, file_name, auto_share_mortgage_ops)
VALUES
  ('${DOC_MORT}', '${TENANT_A}', 'library:mortgage:w-9', '${ATTACH_PATH}', 'W-9', true),
  ('${DOC_TMPL}', '${TENANT_A}', 'library:template:tpa', '${TEMPLATE_PATH}', 'TPA', true),
  ('${DOC_OFF}', '${TENANT_A}', 'library:mortgage:license', '${OFF_PATH}', 'License', false),
  ('${DOC_B}', '${TENANT_B}', 'library:mortgage:w-9', '${OTHER_PATH}', 'Other W-9', true),
  ('${DOC_CLOSED}', '${TENANT_A}', 'library:mortgage:closing', '${CLOSED_PATH}', 'Closed', false);
INSERT INTO public.mortgage_handling_requests (id, tenant_id, status, assigned_employee_id)
VALUES
  ('${REQ_OPEN}', '${TENANT_A}', 'requested', NULL),
  ('${REQ_DONE}', '${TENANT_A}', 'completed', '${AGENT_ID}'),
  ('${REQ_CAN}', '${TENANT_A}', 'cancelled', '${AGENT_ID}');
INSERT INTO public.mortgage_request_library_documents
  (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
VALUES
  ('${REQ_DONE}', '${TENANT_A}', '${DOC_CLOSED}', 'library:mortgage:closing', 'Closed', '${CLOSED_PATH}');
`;
  psql(['-d', dbName], seed);

  const matrixSql = `
CREATE TABLE public._hotfix_results (
  test text PRIMARY KEY,
  ok boolean NOT NULL,
  detail text
);

CREATE OR REPLACE FUNCTION public._hotfix_ok(_test text, _ok boolean, _detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public._hotfix_results(test, ok, detail) VALUES (_test, _ok, _detail)
  ON CONFLICT (test) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._hotfix_as(
  _user uuid,
  _sql text
) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
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

CREATE OR REPLACE FUNCTION public._hotfix_as_select(
  _user uuid,
  _sql text
) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
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

DO $$
DECLARE
  r jsonb;
  n int;
  cmds text[];
  priv_upd boolean;
  priv_del boolean;
  priv_ins boolean;
  priv_sel boolean;
BEGIN
  r := public._hotfix_as_select(
    '${AGENT_ID}'::uuid,
    $q$SELECT public.aws_mortgage_agent_can_read_library_path(
         ARRAY['${ATTACH_PATH}']::text[], '${ATTACH_PATH}', '${AGENT_ID}'::uuid)$q$
  );
  PERFORM public._hotfix_ok(
    'path_helper_executes',
    (r->>'ok')::boolean AND r->>'error' IS NULL,
    coalesce(r->>'error', r->>'val')
  );
  PERFORM public._hotfix_ok(
    'path_exact_attached_true',
    (r->>'ok')::boolean AND (r->>'val')::boolean IS TRUE,
    r::text
  );

  r := public._hotfix_as_select(
    '${AGENT_UNASSIGNED}'::uuid,
    $q$SELECT public.aws_mortgage_agent_can_read_library_path(
         ARRAY['${ATTACH_PATH}']::text[], '${ATTACH_PATH}', '${AGENT_UNASSIGNED}'::uuid)$q$
  );
  PERFORM public._hotfix_ok('path_unassigned_open_true', (r->>'val')::boolean IS TRUE, r::text);

  r := public._hotfix_as_select(
    '${AGENT_UNASSIGNED}'::uuid,
    $q$SELECT public.aws_mortgage_agent_can_read_library_path(
         ARRAY['${ATTACH_PATH}']::text[], '${ATTACH_PATH}', '${AGENT_UNASSIGNED}'::uuid)$q$
  );
  -- completed row uses same path; helper is true if ANY qualifying open/assigned row matches.
  -- Unassigned agent still sees the open request attachment (desk-wide). That is intended.
  PERFORM public._hotfix_ok('path_helper_no_exception', (r->>'ok')::boolean, r::text);

  FOREACH r IN ARRAY ARRAY[
    public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${TEMPLATE_PATH}']::text[], '${TEMPLATE_PATH}', '${AGENT_ID}'::uuid)$q$),
    public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['%']::text[], '%', '${AGENT_ID}'::uuid)$q$),
    public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['_']::text[], '_', '${AGENT_ID}'::uuid)$q$),
    public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['w9.pdf']::text[], 'w9.pdf', '${AGENT_ID}'::uuid)$q$),
    public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${OTHER_PATH}']::text[], '${OTHER_PATH}', '${AGENT_ID}'::uuid)$q$),
    public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${FORGED_PATH}']::text[], '${FORGED_PATH}', '${AGENT_ID}'::uuid)$q$),
    public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${ATTACH_PATH}/../kyc']::text[], '${ATTACH_PATH}/../kyc', '${AGENT_ID}'::uuid)$q$),
    public._hotfix_as_select('${OWNER_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${ATTACH_PATH}']::text[], '${ATTACH_PATH}', '${OWNER_ID}'::uuid)$q$),
    public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${ATTACH_PATH}']::text[], '', '${AGENT_ID}'::uuid)$q$)
  ] LOOP
    NULL;
  END LOOP;

  PERFORM public._hotfix_ok(
    'path_unattached_false',
    (public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${TEMPLATE_PATH}']::text[], '${TEMPLATE_PATH}', '${AGENT_ID}'::uuid)$q$)->>'val')::boolean IS NOT TRUE,
    'template'
  );
  PERFORM public._hotfix_ok(
    'path_wildcard_false',
    (public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['%']::text[], '%', '${AGENT_ID}'::uuid)$q$)->>'val')::boolean IS NOT TRUE,
    '%'
  );
  PERFORM public._hotfix_ok(
    'path_underscore_false',
    (public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['_']::text[], '_', '${AGENT_ID}'::uuid)$q$)->>'val')::boolean IS NOT TRUE,
    '_'
  );
  PERFORM public._hotfix_ok(
    'path_suffix_false',
    (public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['w9.pdf']::text[], 'w9.pdf', '${AGENT_ID}'::uuid)$q$)->>'val')::boolean IS NOT TRUE,
    'suffix'
  );
  PERFORM public._hotfix_ok(
    'path_other_tenant_false',
    (public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${OTHER_PATH}']::text[], '${OTHER_PATH}', '${AGENT_ID}'::uuid)$q$)->>'val')::boolean IS NOT TRUE,
    'other tenant'
  );
  PERFORM public._hotfix_ok(
    'path_malformed_false',
    (public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${FORGED_PATH}']::text[], '${FORGED_PATH}', '${AGENT_ID}'::uuid)$q$)->>'val')::boolean IS NOT TRUE
    AND (public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${ATTACH_PATH}']::text[], '', '${AGENT_ID}'::uuid)$q$)->>'val')::boolean IS NOT TRUE,
    'malformed'
  );
  PERFORM public._hotfix_ok(
    'path_unauthorized_owner_false',
    (public._hotfix_as_select('${OWNER_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${ATTACH_PATH}']::text[], '${ATTACH_PATH}', '${OWNER_ID}'::uuid)$q$)->>'val')::boolean IS NOT TRUE,
    'owner is not mortgage_agent'
  );
  PERFORM public._hotfix_ok(
    'path_closed_unassigned_false',
    (public._hotfix_as_select('${AGENT_UNASSIGNED}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${CLOSED_PATH}']::text[], '${CLOSED_PATH}', '${AGENT_UNASSIGNED}'::uuid)$q$)->>'val')::boolean IS NOT TRUE,
    'completed is assigned-agent only'
  );
  PERFORM public._hotfix_ok(
    'path_closed_assigned_true',
    (public._hotfix_as_select('${AGENT_ID}'::uuid, $q$SELECT public.aws_mortgage_agent_can_read_library_path(ARRAY['${CLOSED_PATH}']::text[], '${CLOSED_PATH}', '${AGENT_ID}'::uuid)$q$)->>'val')::boolean IS TRUE,
    'assigned agent retains closed read'
  );

  DELETE FROM public.mortgage_request_library_documents
  WHERE request_id = '${REQ_OPEN}' AND file_path = '${OFF_PATH}';

  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         '${REQ_OPEN}', '${TENANT_A}', '${DOC_OFF}', 'library:mortgage:license', 'License', '${OFF_PATH}'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_autoshare_false_fails',
    (r->>'ok')::boolean IS NOT TRUE AND coalesce(r->>'error','') ~* 'row-level security',
    r::text
  );

  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         '${REQ_OPEN}', '${TENANT_A}', '${DOC_TMPL}', 'library:template:tpa', 'TPA', '${TEMPLATE_PATH}'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_template_fails',
    (r->>'ok')::boolean IS NOT TRUE AND coalesce(r->>'error','') ~* 'row-level security',
    r::text
  );

  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         '${REQ_DONE}', '${TENANT_A}', '${DOC_OFF}', 'library:mortgage:license', 'License', '${OFF_PATH}'
       )$q$
  );
  -- DOC_OFF is auto_share false AND completed. Use mortgage doc on completed instead.
  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (id, request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         'd1000000-0000-4000-8000-000000000001',
         '${REQ_DONE}', '${TENANT_A}', '${DOC_MORT}', 'library:mortgage:w-9', 'W-9-dup', '${ATTACH_PATH}-dup'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_completed_fails',
    (r->>'ok')::boolean IS NOT TRUE AND coalesce(r->>'error','') ~* 'row-level security',
    r::text
  );

  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (id, request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         'd1000000-0000-4000-8000-000000000002',
         '${REQ_CAN}', '${TENANT_A}', '${DOC_MORT}', 'library:mortgage:w-9', 'W-9-can', '${ATTACH_PATH}-can'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_cancelled_fails',
    (r->>'ok')::boolean IS NOT TRUE AND coalesce(r->>'error','') ~* 'row-level security',
    r::text
  );

  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         '${REQ_OPEN}', '${TENANT_A}', '${DOC_B}', 'library:mortgage:w-9', 'Other', '${OTHER_PATH}'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_cross_tenant_fails',
    (r->>'ok')::boolean IS NOT TRUE AND coalesce(r->>'error','') ~* 'row-level security',
    r::text
  );

  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         '${REQ_OPEN}', '${TENANT_A}', '${DOC_OFF}', 'library:mortgage:license', 'License', '${ATTACH_PATH}'
       )$q$
  );
  -- mismatched path against DOC_OFF. Use DOC_MORT with forged path:
  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (id, request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         'd1000000-0000-4000-8000-000000000003',
         '${REQ_OPEN}', '${TENANT_A}', '${DOC_MORT}', 'library:mortgage:w-9', 'forged', '${FORGED_PATH}'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_mismatched_path_fails',
    (r->>'ok')::boolean IS NOT TRUE AND coalesce(r->>'error','') ~* 'row-level security',
    r::text
  );

  r := public._hotfix_as(
    '${OPERATOR_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (id, request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         'd1000000-0000-4000-8000-000000000004',
         '${REQ_OPEN}', '${TENANT_A}', '${DOC_OFF}', 'library:mortgage:license', 'License2', '${OFF_PATH}'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_operator_fails',
    (r->>'ok')::boolean IS NOT TRUE,
    r::text
  );

  r := public._hotfix_as(
    '${AGENT_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (id, request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         'd1000000-0000-4000-8000-000000000005',
         '${REQ_OPEN}', '${TENANT_A}', '${DOC_OFF}', 'library:mortgage:license', 'License3', '${OFF_PATH}'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_mortgage_agent_fails',
    (r->>'ok')::boolean IS NOT TRUE,
    r::text
  );

  UPDATE public.tenant_documents SET auto_share_mortgage_ops = true WHERE id = '${DOC_OFF}';
  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$INSERT INTO public.mortgage_request_library_documents
         (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
       VALUES (
         '${REQ_OPEN}', '${TENANT_A}', '${DOC_OFF}', 'library:mortgage:license', 'License', '${OFF_PATH}'
       )$q$
  );
  PERFORM public._hotfix_ok(
    'insert_owner_approved_open_succeeds',
    (r->>'ok')::boolean IS TRUE AND (r->>'n')::int = 1,
    r::text
  );
  UPDATE public.tenant_documents SET auto_share_mortgage_ops = false WHERE id = '${DOC_OFF}';
  SELECT count(*) INTO n FROM public.mortgage_request_library_documents
  WHERE request_id = '${REQ_OPEN}' AND tenant_document_id = '${DOC_OFF}';
  PERFORM public._hotfix_ok('autoshare_off_does_not_detach', n = 1, n::text);

  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$UPDATE public.mortgage_request_library_documents SET file_name = 'x' WHERE request_id = '${REQ_OPEN}'$q$
  );
  priv_upd := has_table_privilege('checksops', 'public.mortgage_request_library_documents', 'UPDATE');
  priv_del := has_table_privilege('checksops', 'public.mortgage_request_library_documents', 'DELETE');
  priv_ins := has_table_privilege('checksops', 'public.mortgage_request_library_documents', 'INSERT');
  priv_sel := has_table_privilege('checksops', 'public.mortgage_request_library_documents', 'SELECT');
  PERFORM public._hotfix_ok(
    'update_privilege_denied',
    priv_upd IS FALSE AND (r->>'ok')::boolean IS NOT TRUE AND coalesce(r->>'error','') ~* 'permission denied',
    json_build_object('priv_upd', priv_upd, 'result', r)::text
  );
  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$DELETE FROM public.mortgage_request_library_documents WHERE request_id = '${REQ_OPEN}'$q$
  );
  PERFORM public._hotfix_ok(
    'delete_privilege_denied',
    priv_del IS FALSE AND (r->>'ok')::boolean IS NOT TRUE AND coalesce(r->>'error','') ~* 'permission denied',
    json_build_object('priv_del', priv_del, 'result', r)::text
  );
  PERFORM public._hotfix_ok('select_insert_privileges_kept', priv_sel AND priv_ins, json_build_object('sel', priv_sel, 'ins', priv_ins)::text);

  GRANT UPDATE, DELETE ON TABLE public.mortgage_request_library_documents TO checksops;
  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$UPDATE public.mortgage_request_library_documents SET file_name = 'x' WHERE request_id = '${REQ_OPEN}'$q$
  );
  PERFORM public._hotfix_ok(
    'update_rls_denied',
    (r->>'ok')::boolean IS NOT TRUE OR (r->>'n')::int = 0,
    r::text
  );
  r := public._hotfix_as(
    '${OWNER_ID}'::uuid,
    $q$DELETE FROM public.mortgage_request_library_documents WHERE request_id = '${REQ_OPEN}'$q$
  );
  PERFORM public._hotfix_ok(
    'delete_rls_denied',
    (r->>'ok')::boolean IS NOT TRUE OR (r->>'n')::int = 0,
    r::text
  );
  REVOKE UPDATE, DELETE ON TABLE public.mortgage_request_library_documents FROM checksops;

  INSERT INTO public.mortgage_handling_requests (id, tenant_id, status)
  VALUES ('c1000000-0000-4000-8000-000000000010', '${TENANT_A}', 'requested');
  SELECT count(*) INTO n FROM public.mortgage_request_library_documents
  WHERE request_id = 'c1000000-0000-4000-8000-000000000010';
  PERFORM public._hotfix_ok(
    'trigger_category_and_autoshare',
    n = 1 AND EXISTS (
      SELECT 1 FROM public.mortgage_request_library_documents
      WHERE request_id = 'c1000000-0000-4000-8000-000000000010'
        AND tenant_document_id = '${DOC_MORT}'
        AND file_path = '${ATTACH_PATH}'
    ) AND NOT EXISTS (
      SELECT 1 FROM public.mortgage_request_library_documents
      WHERE request_id = 'c1000000-0000-4000-8000-000000000010'
        AND tenant_document_id IN ('${DOC_TMPL}', '${DOC_OFF}')
    ),
    n::text
  );

  INSERT INTO public.mortgage_request_library_documents
    (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
  SELECT 'c1000000-0000-4000-8000-000000000010', '${TENANT_A}', td.id, td.doc_type, td.file_name, td.file_path
  FROM public.tenant_documents td
  WHERE td.tenant_id = '${TENANT_A}'
    AND td.auto_share_mortgage_ops = true
    AND td.doc_type LIKE 'library:mortgage:%'
  ON CONFLICT (request_id, file_path) DO NOTHING;
  SELECT count(*) INTO n FROM public.mortgage_request_library_documents
  WHERE request_id = 'c1000000-0000-4000-8000-000000000010';
  PERFORM public._hotfix_ok('trigger_idempotent', n = 1, n::text);

  UPDATE public.tenant_documents SET auto_share_mortgage_ops = false WHERE id = '${DOC_MORT}';
  INSERT INTO public.mortgage_handling_requests (id, tenant_id, status)
  VALUES ('c1000000-0000-4000-8000-000000000011', '${TENANT_A}', 'requested');
  SELECT count(*) INTO n FROM public.mortgage_request_library_documents
  WHERE request_id = 'c1000000-0000-4000-8000-000000000011';
  PERFORM public._hotfix_ok(
    'existing_joins_survive_autoshare_off',
    n = 0 AND EXISTS (
      SELECT 1 FROM public.mortgage_request_library_documents
      WHERE request_id = '${REQ_OPEN}' AND tenant_document_id = '${DOC_MORT}'
    ),
    n::text
  );
  UPDATE public.tenant_documents SET auto_share_mortgage_ops = true WHERE id = '${DOC_MORT}';

  DELETE FROM public.tenant_documents WHERE id = '${DOC_OFF}';
  PERFORM public._hotfix_ok(
    'tenant_document_delete_sets_null',
    EXISTS (
      SELECT 1 FROM public.mortgage_request_library_documents
      WHERE request_id = '${REQ_OPEN}' AND file_path = '${OFF_PATH}' AND tenant_document_id IS NULL
    ),
    'set null'
  );

  DELETE FROM public.mortgage_handling_requests WHERE id = 'c1000000-0000-4000-8000-000000000010';
  PERFORM public._hotfix_ok(
    'request_delete_cascades_joins',
    NOT EXISTS (
      SELECT 1 FROM public.mortgage_request_library_documents
      WHERE request_id = 'c1000000-0000-4000-8000-000000000010'
    ),
    'cascade'
  );

  SELECT coalesce(array_agg(cmd ORDER BY cmd), ARRAY[]::text[]) INTO cmds
  FROM pg_policies
  WHERE tablename = 'mortgage_request_library_documents';
  PERFORM public._hotfix_ok(
    'final_policies_select_insert_only',
    cmds @> ARRAY['SELECT','INSERT']::text[]
    AND NOT (cmds @> ARRAY['ALL']::text[])
    AND NOT (cmds @> ARRAY['UPDATE']::text[])
    AND NOT (cmds @> ARRAY['DELETE']::text[])
    AND array_length(cmds, 1) = 2,
    array_to_string(cmds, ',')
  );
END $$;
`;
  psql(['-d', dbName], matrixSql);

  psql(['-d', dbName, '-f', path.join(SQL_DIR, '24_complete_write_policies.sql')]);
  const after24Again = JSON.parse(scalar(`
SELECT json_build_object(
  'write_count', (
     SELECT count(*) FROM pg_policies
     WHERE tablename = 'mortgage_request_library_documents'
       AND policyname = 'aws_write_mortgage_request_library_documents'
  ),
  'has_all', EXISTS (
     SELECT 1 FROM pg_policies
     WHERE tablename = 'mortgage_request_library_documents' AND cmd = 'ALL'
  ),
  'cmds', (
     SELECT coalesce(json_agg(cmd ORDER BY cmd), '[]'::json)
     FROM pg_policies
     WHERE tablename = 'mortgage_request_library_documents'
  )
);
`));
  note(`policies_after_24_rerun ${JSON.stringify(after24Again)}`);
  assert.equal(after24Again.write_count, 0);
  assert.equal(after24Again.has_all, false);

  const insertAfter24 = JSON.parse(scalar(`
SELECT public._hotfix_as(
  '${OWNER_ID}'::uuid,
  $q$INSERT INTO public.mortgage_request_library_documents
       (id, request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path)
     VALUES (
       'd1000000-0000-4000-8000-000000000099',
       '${REQ_OPEN}', '${TENANT_A}', '${DOC_MORT}', 'library:mortgage:w-9', 'again', '${ATTACH_PATH}-again'
     )$q$
);
`));
  note(`insert_after_24_rerun ${JSON.stringify(insertAfter24)}`);
  assert.equal(insertAfter24.ok, false, 'writes must fail closed after 24 drops INSERT');
  assert.match(String(insertAfter24.error || ''), /row-level security|permission denied/i);

  psql(['-d', dbName, '-f', path.join(SQL_DIR, '29_mortgage_ops_library_parity.sql')]);
  const restored = JSON.parse(scalar(`
SELECT json_build_object(
  'cmds', (
     SELECT coalesce(json_agg(json_build_object('policy', policyname, 'cmd', cmd, 'qual', qual, 'with_check', with_check) ORDER BY cmd), '[]'::json)
     FROM pg_policies
     WHERE tablename = 'mortgage_request_library_documents'
  ),
  'privs', json_build_object(
     'checksops_select', has_table_privilege('checksops', 'public.mortgage_request_library_documents', 'SELECT'),
     'checksops_insert', has_table_privilege('checksops', 'public.mortgage_request_library_documents', 'INSERT'),
     'checksops_update', has_table_privilege('checksops', 'public.mortgage_request_library_documents', 'UPDATE'),
     'checksops_delete', has_table_privilege('checksops', 'public.mortgage_request_library_documents', 'DELETE'),
     'authenticated_select', has_table_privilege('authenticated', 'public.mortgage_request_library_documents', 'SELECT'),
     'authenticated_insert', has_table_privilege('authenticated', 'public.mortgage_request_library_documents', 'INSERT'),
     'authenticated_update', has_table_privilege('authenticated', 'public.mortgage_request_library_documents', 'UPDATE'),
     'authenticated_delete', has_table_privilege('authenticated', 'public.mortgage_request_library_documents', 'DELETE')
  )
);
`));
  note(`final_policies ${JSON.stringify(restored)}`);
  const cmds = restored.cmds.map((row) => row.cmd).sort();
  assert.deepEqual(cmds, ['INSERT', 'SELECT']);
  assert.equal(restored.cmds.find((row) => row.cmd === 'INSERT').with_check.includes('aws_can_insert_mortgage_library_document'), true);
  assert.equal(restored.privs.checksops_select, true);
  assert.equal(restored.privs.checksops_insert, true);
  assert.equal(restored.privs.checksops_update, false);
  assert.equal(restored.privs.checksops_delete, false);
  assert.equal(restored.privs.authenticated_select, true);
  assert.equal(restored.privs.authenticated_insert, true);
  assert.equal(restored.privs.authenticated_update, false);
  assert.equal(restored.privs.authenticated_delete, false);

  const results = JSON.parse(scalar(`
SELECT coalesce(json_agg(json_build_object('test', test, 'ok', ok, 'detail', detail) ORDER BY test), '[]'::json)
FROM public._hotfix_results;
`));
  note(`matrix_results ${JSON.stringify(results, null, 2)}`);
  const failed = results.filter((row) => row.ok !== true);
  assert.deepEqual(failed, [], `failed matrix rows: ${JSON.stringify(failed)}`);

  const chr0 = scalar(`
SELECT pg_get_functiondef('public.aws_mortgage_agent_can_read_library_path(text[], text, uuid)'::regprocedure);
`);
  assert.doesNotMatch(chr0, /CHR\s*\(\s*0\s*\)/i);
  note('path helper definition contains no CHR(0)');
  note(`artifact ${artifactLog}`);
});
