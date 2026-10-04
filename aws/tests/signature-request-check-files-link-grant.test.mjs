/**
 * Contract: Signature Request create-payload + check-scoped document
 * requires column-level check_files.signature_request_id UPDATE authority
 * while aws_write_check_files / aws_can_write_check remains enforced.
 *
 * Does not rewrite SQL 35/36/50/73/74. Does not change SPA or API.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (rel) => createHash('sha256').update(read(rel), 'utf8').digest('hex');
const PG_BIN = '/usr/lib/postgresql/16/bin';

const SQL75 = 'aws/workflows/sql/75_signature_request_check_files_link_grant.sql';
const SQL35 = 'aws/write-path/sql/35_tranche3_write_grants.sql';
const SQL36 = 'aws/write-path/sql/36_tranche3_revoke_write_grants.sql';
const SQL50 = 'aws/workflows/sql/50_tranche5_write_grants.sql';
const SQL73 = 'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql';
const SQL74 = 'aws/workflows/sql/74_homeowner_signing_rls_boundary.sql';

const FROZEN = Object.freeze([
  SQL35,
  SQL36,
  SQL50,
  SQL73,
  SQL74,
  'aws/functions/api/esign.mjs',
  'aws/functions/api/signature-submit.mjs',
  'src/components/claim-detail/SignatureRequests.tsx',
  'src/lib/signature-source-files.ts',
]);

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '55555555-5555-4555-8555-555555555551';
const USER_B = '55555555-5555-4555-8555-555555555552';
const CHECK_A = '33333333-3333-4333-8333-333333333331';
const CHECK_B = '33333333-3333-4333-8333-333333333332';
const FILE_A = '44444444-4444-4444-8444-444444444441';
const FILE_B = '44444444-4444-4444-8444-444444444442';
const REQ = '77777777-7777-4777-8777-777777777771';

test('SQL 75 is only the signature_request_id column grant and does not rewrite history', () => {
  const sql = read(SQL75);
  assert.equal(sha256(SQL75), 'cbf158109926f12a8ec2a32b6815978468dc9d3f5fe22560c2646826582c8283');
  assert.equal(sha256(SQL35), 'b2d8fc0578c0e7afb3494e3c879af4b20da0f10b8574d34bdd9647a0f4e29f07');
  assert.equal(sha256(SQL36), 'b2c174ee01bf8527e1980696b5937b3106dbed3ff41de7ba4e4bfa41a8c5eaeb');
  assert.equal(sha256(SQL50), '3ad281a93aed931ab329d28bccfe1bfa15734267f9ce3b0ab8cb1ca5a4b5a08e');
  assert.equal(sha256(SQL73), '02a19f8ef11cb3e60122b1ff1e07dd331f95a677d13028564d497ef06e523c9e');
  assert.equal(sha256(SQL74), 'a7ee929bc25a7ca56bf29dacebdab20198bf1a7625e661333545dc9d1f662c4f');
  assert.match(sql, /GRANT UPDATE \(signature_request_id\) ON TABLE public\.check_files TO checksops, authenticated;/);
  assert.match(sql, /aws_write_check_files/);
  assert.match(sql, /aws_can_write_check\(check_intake_item_id\)/);
  assert.doesNotMatch(sql, /GRANT UPDATE ON TABLE public\.check_files/);
  assert.doesNotMatch(sql, /GRANT ALL ON TABLE public\.check_files/);
  assert.doesNotMatch(sql, /GRANT UPDATE \([^)]*file_name/);
  assert.doesNotMatch(sql, /TO PUBLIC|TO anon/);
  assert.doesNotMatch(sql, /CREATE POLICY|DROP POLICY|ALTER POLICY|ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|CREATE OR REPLACE FUNCTION/);
  assert.doesNotMatch(sql, /35_tranche3_write_grants\.sql\nGRANT/);
  const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((line) => line.trim()).filter(Boolean);
  for (const rel of FROZEN) {
    assert.ok(!changed.includes(rel), `${rel} must stay untouched`);
  }
});

test('live create-payload still links check_files.signature_request_id after request insert', () => {
  const liveHint = read('src/lib/signature-source-files.ts');
  assert.match(liveHint, /buildSendSignatureRequestCreatePayload/);
  const wizard = read('src/components/claim-detail/SignatureRequests.tsx');
  assert.match(wizard, /functions\.invoke\("send-signature-request"/);
  assert.doesNotMatch(wizard, /\.from\("check_files"\)\s*\.update\(/);
});

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

const FIXTURE = `
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE checksops NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT authenticated TO checksops;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.app_user_id', true), '')::uuid;
$$;

CREATE TABLE public.tenant_users (
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL
);
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'owner');
CREATE TABLE public.user_roles (
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
);
CREATE TABLE public.check_files (
  id uuid PRIMARY KEY,
  check_intake_item_id uuid NOT NULL,
  file_name text,
  file_path text,
  file_type text,
  file_size bigint,
  category text,
  source text,
  description text,
  uploaded_by uuid,
  signature_request_id uuid
);

CREATE OR REPLACE FUNCTION public.aws_is_authenticated()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public SET row_security = off AS $$
  SELECT auth.uid() IS NOT NULL;
$$;
CREATE OR REPLACE FUNCTION public.aws_is_cross_tenant_reader()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public SET row_security = off AS $$
  SELECT false;
$$;
CREATE OR REPLACE FUNCTION public.aws_can_access_tenant(_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = _tenant_id AND tu.user_id = auth.uid()
  );
$$;
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id AND ur.role = _role
  );
$$;
CREATE OR REPLACE FUNCTION public.aws_can_write_tenant(_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public SET row_security = off AS $$
  SELECT public.aws_is_authenticated()
     AND _tenant_id IS NOT NULL
     AND public.aws_can_access_tenant(_tenant_id)
     AND (
       public.aws_is_cross_tenant_reader()
       OR public.has_role(auth.uid(), 'admin'::public.app_role)
       OR public.has_role(auth.uid(), 'staff'::public.app_role)
     );
$$;
CREATE OR REPLACE FUNCTION public.aws_can_write_check(_check_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public SET row_security = off AS $$
  SELECT public.aws_is_cross_tenant_reader()
      OR EXISTS (
        SELECT 1
        FROM public.check_intake_items ci
        WHERE ci.id = _check_id
          AND public.aws_can_write_tenant(ci.tenant_id)
      );
$$;

GRANT SELECT ON TABLE public.check_intake_items TO checksops, authenticated;
GRANT SELECT, DELETE ON TABLE public.check_files TO checksops, authenticated;

ALTER TABLE public.check_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY aws_select_check_files ON public.check_files
  FOR SELECT TO authenticated
  USING (public.aws_can_write_check(check_intake_item_id));
CREATE POLICY aws_write_check_files ON public.check_files
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_intake_item_id))
  WITH CHECK (public.aws_can_write_check(check_intake_item_id));

INSERT INTO public.tenant_users (user_id, tenant_id) VALUES
  ('${USER_A}', '${TENANT_A}'),
  ('${USER_B}', '${TENANT_B}');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${USER_A}', 'admin'),
  ('${USER_B}', 'admin');
INSERT INTO public.check_intake_items (id, tenant_id) VALUES
  ('${CHECK_A}', '${TENANT_A}'),
  ('${CHECK_B}', '${TENANT_B}');
INSERT INTO public.check_files
  (id, check_intake_item_id, file_name, file_path, signature_request_id)
VALUES
  ('${FILE_A}', '${CHECK_A}', 'a.pdf', 'check-intake/${CHECK_A}/a.pdf', NULL),
  ('${FILE_B}', '${CHECK_B}', 'b.pdf', 'check-intake/${CHECK_B}/b.pdf', NULL);
`;

test('isolated PostgreSQL: same-check link succeeds; cross-check and other columns stay denied', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql75-grant-'));
  const port = 56200 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
  mustRun(path.join(PG_BIN, 'initdb'), [
    '-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8',
  ]);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `
listen_addresses = ''
port = ${port}
unix_socket_directories = '${pgData}'
logging_collector = off
shared_buffers = 32MB
max_connections = 20
`);
  const started = run(path.join(PG_BIN, 'pg_ctl'), [
    '-D', pgData, '-l', logPath, '-w', '-t', '30', 'start',
  ]);
  if (started.status !== 0) {
    throw new Error(`pg_ctl start failed: ${started.stderr || fs.readFileSync(logPath, 'utf8')}`);
  }
  const psql = (sql) => {
    const result = run(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql,
    ]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return result.stdout.trim();
  };
  const psqlFail = (sql) => run(path.join(PG_BIN, 'psql'), [
    '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql,
  ]);
  try {
    psql(FIXTURE);
    const beforePolicy = psql(`
      SELECT qual FROM pg_policies
      WHERE tablename = 'check_files' AND policyname = 'aws_write_check_files'
    `);
    assert.match(beforePolicy, /aws_can_write_check/);
    assert.equal(psql(`
      SELECT coalesce(string_agg(privilege_type, ','), '')
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'check_files'
        AND grantee IN ('checksops', 'authenticated') AND privilege_type = 'UPDATE'
    `), '');

    psql(read(SQL75));

    const afterPolicy = psql(`
      SELECT qual FROM pg_policies
      WHERE tablename = 'check_files' AND policyname = 'aws_write_check_files'
    `);
    assert.equal(afterPolicy, beforePolicy);

    const colGrants = psql(`
      SELECT grantee || ':' || column_name || ':' || privilege_type
      FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND table_name = 'check_files'
        AND privilege_type = 'UPDATE'
        AND grantee IN ('checksops', 'authenticated', 'PUBLIC', 'anon')
      ORDER BY 1
    `);
    assert.equal(colGrants, [
      `authenticated:signature_request_id:UPDATE`,
      `checksops:signature_request_id:UPDATE`,
    ].join('\n'));

    assert.equal(psql(`
      SELECT coalesce(string_agg(privilege_type, ','), '')
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'check_files'
        AND grantee IN ('checksops', 'authenticated') AND privilege_type = 'UPDATE'
    `), '');
    assert.equal(psql(`
      SELECT coalesce(string_agg(grantee || ':' || privilege_type, ','), '')
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'check_files'
        AND grantee IN ('PUBLIC', 'anon')
    `), '');
    assert.equal(psql(`
      SELECT has_column_privilege('checksops', 'public.check_files', 'file_name', 'UPDATE')::text
    `), 'false');
    assert.equal(psql(`
      SELECT has_column_privilege('authenticated', 'public.check_files', 'file_path', 'UPDATE')::text
    `), 'false');
    assert.equal(psql(`
      SELECT has_column_privilege('anon', 'public.check_files', 'signature_request_id', 'UPDATE')::text
    `), 'false');

    const sameCheck = psql(`
      SET ROLE checksops;
      SELECT set_config('request.app_user_id', '${USER_A}', true);
      UPDATE public.check_files
         SET signature_request_id = '${REQ}'
       WHERE id = '${FILE_A}'
      RETURNING signature_request_id IS NOT NULL;
    `);
    assert.match(sameCheck, /\nt$/);

    const cross = psql(`
      SET ROLE checksops;
      SELECT set_config('request.app_user_id', '${USER_A}', true);
      UPDATE public.check_files
         SET signature_request_id = '${REQ}'
       WHERE id = '${FILE_B}'
      RETURNING id;
    `);
    assert.equal(cross, USER_A);
    assert.equal(psql(`SELECT signature_request_id IS NULL FROM public.check_files WHERE id = '${FILE_B}'`), 't');

    const otherCol = psqlFail(`
      SET ROLE checksops;
      SELECT set_config('request.app_user_id', '${USER_A}', true);
      UPDATE public.check_files SET file_name = 'hijack.pdf' WHERE id = '${FILE_A}';
    `);
    assert.notEqual(otherCol.status, 0);
    assert.match(`${otherCol.stderr}\n${otherCol.stdout}`, /permission denied|42501/i);

    const authRole = psql(`
      SET ROLE authenticated;
      SELECT set_config('request.app_user_id', '${USER_A}', true);
      UPDATE public.check_files
         SET signature_request_id = '${REQ}'
       WHERE id = '${FILE_A}'
      RETURNING 1;
    `);
    assert.match(authRole, /\n1$/);
  } finally {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'fast', 'stop']);
  }
});
