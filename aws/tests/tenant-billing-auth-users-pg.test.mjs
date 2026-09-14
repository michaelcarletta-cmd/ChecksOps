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
const APPLY_SQL = path.join(SQL_DIR, '33_tenant_billing_auth_users_containment.sql');
const ROLLBACK_SQL = path.join(SQL_DIR, '33_tenant_billing_auth_users_containment_rollback.sql');
const SUPABASE_SQL = path.join(
  REPO,
  'supabase/migrations/20260914014800_tenant_billing_auth_users_containment.sql',
);
const PANEL = path.join(REPO, 'src/components/settings/TenantBillingAccountPanel.tsx');
const AUTH_UID_SQL = path.join(ROOT, 'identity/sql/02_auth_uid_guc.sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const MEMBER = 'a1000000-0000-4000-8000-000000000001';
const OTHER = 'a1000000-0000-4000-8000-000000000002';
const STAKE_A = 'b1000000-0000-4000-8000-000000000001';

const uncommented = (sql) => sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

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

test('containment SQL never grants auth.users and stays off other workstreams', () => {
  const awsSql = fs.readFileSync(APPLY_SQL, 'utf8');
  const body = uncommented(awsSql);
  const supabaseSql = fs.readFileSync(SUPABASE_SQL, 'utf8');
  const panel = fs.readFileSync(PANEL, 'utf8');
  const oneshot = fs.readFileSync(path.join(ROOT, 'rls/oneshot/index.mjs'), 'utf8');
  const allowlist = fs.readFileSync(path.join(ROOT, 'functions/api/write-allowlist.mjs'), 'utf8');

  assert.match(awsSql, /permission denied for table users/);
  assert.match(body, /DROP POLICY IF EXISTS "Platform admin manages all billing accounts"/);
  assert.match(body, /REVOKE ALL ON TABLE auth\.users FROM authenticated/);
  assert.match(body, /REVOKE ALL ON TABLE auth\.users FROM checksops/);
  assert.equal(/GRANT\s+(SELECT|ALL).*ON TABLE auth\.users/i.test(body), false);
  assert.equal(/GRANT\s+SELECT\s+ON\s+auth\.users/i.test(body), false);
  assert.equal(/write-allowlist/.test(body), false);
  assert.equal(/completeAuth/.test(uncommented(awsSql)) && /await client\.query/.test(body), false);
  assert.equal(/AdminTenants/.test(body), false);
  assert.equal(/25_fk_retarget/.test(body), false);
  assert.match(uncommented(supabaseSql), /is_platform_owner\(\)/);
  assert.equal(/GRANT\s+(SELECT|ALL)[\s\S]*auth\.users/i.test(uncommented(supabaseSql)), false);
  assert.equal(/ach_authorized_by/.test(panel), false);
  assert.equal(/routing_number/.test(panel), false);
  assert.equal(/account_number_encrypted/.test(panel), false);
  assert.match(panel, /account_number_last4/);
  assert.match(panel, /stakeholder_account_id/);
  assert.equal(/33_tenant_billing_auth_users_containment/.test(oneshot), false);
  assert.match(allowlist, /tenant_billing_accounts:\s*\{/);
});

test('disposable PostgreSQL monthly-fee billing no longer reads auth.users', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  assert.equal(fs.existsSync(APPLY_SQL), true);
  assert.equal(fs.existsSync(ROLLBACK_SQL), true);
  assert.equal(fs.existsSync(AUTH_UID_SQL), true);

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-tenant-billing-${stamp}-`));
  const port = 55400 + (process.pid % 1000);
  const dbName = `tenant_billing_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `tenant_billing_auth_users_pg_${stamp}.log`);
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
  const query = (sql) => {
    const result = psql(['-d', dbName, '-Atq', '-F', '\t'], sql.endsWith('\n') ? sql : `${sql}\n`);
    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      .filter((line) => !/^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COMMENT|GRANT|REVOKE|BEGIN|COMMIT)\b/.test(line));
    return lines.join('\n');
  };
  const asMember = (sql, user = MEMBER) => run(
    path.join(PG_BIN, 'psql'),
    [...psqlArgs, '-d', dbName],
    {
      input: `
\\set VERBOSITY verbose
BEGIN;
SET LOCAL ROLE checksops;
SELECT set_config('request.app_user_id', '${user}', true);
${sql}
COMMIT;
`,
    },
  );

  psql(['-d', 'postgres'], `CREATE DATABASE ${dbName};\n`);
  psql(['-d', dbName], `
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE checksops NOLOGIN;
GRANT authenticated TO checksops;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO authenticated, checksops;
GRANT USAGE ON SCHEMA public TO authenticated, checksops;
`);
  psql(['-d', dbName, '-f', AUTH_UID_SQL]);

  psql(['-d', dbName], `
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text
);
REVOKE ALL ON TABLE auth.users FROM PUBLIC, authenticated, checksops;

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL
);
CREATE TABLE public.tenant_users (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid NOT NULL
);
CREATE TABLE public.stakeholder_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id)
);
CREATE TABLE public.tenant_billing_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id),
  nickname text,
  account_holder_name text NOT NULL,
  routing_number text NOT NULL,
  account_number_last4 text NOT NULL,
  account_number_encrypted text NOT NULL,
  account_type text NOT NULL DEFAULT 'checking',
  entity_type text NOT NULL DEFAULT 'business',
  verification_status text NOT NULL DEFAULT 'pending',
  stakeholder_account_id uuid REFERENCES public.stakeholder_accounts(id),
  ach_authorized_at timestamptz,
  ach_authorized_by uuid REFERENCES auth.users(id),
  auto_debit_enabled boolean NOT NULL DEFAULT true
);

GRANT SELECT, INSERT, UPDATE ON TABLE public.tenant_billing_accounts TO authenticated, checksops;
GRANT SELECT ON TABLE public.tenant_users TO authenticated, checksops;
GRANT SELECT ON TABLE public.stakeholder_accounts TO authenticated, checksops;

ALTER TABLE public.tenant_billing_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admin manages all billing accounts"
ON public.tenant_billing_accounts FOR ALL
TO authenticated
USING (auth.uid() IN (SELECT id FROM auth.users WHERE email = 'mcarletta@freedomadj.com'))
WITH CHECK (auth.uid() IN (SELECT id FROM auth.users WHERE email = 'mcarletta@freedomadj.com'));

CREATE POLICY "Tenant users manage own billing account"
ON public.tenant_billing_accounts FOR ALL
TO authenticated
USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

INSERT INTO public.tenants (id, name) VALUES
  ('${TENANT_A}', 'Tenant A'),
  ('${TENANT_B}', 'Tenant B');
INSERT INTO public.tenant_users (tenant_id, user_id) VALUES
  ('${TENANT_A}', '${MEMBER}'),
  ('${TENANT_B}', '${OTHER}');
INSERT INTO public.stakeholder_accounts (id, tenant_id) VALUES
  ('${STAKE_A}', '${TENANT_A}');
`);
  note('reproduced leftover dump policy and auth.users FK');

  const beforeInsert = asMember(`
INSERT INTO public.tenant_billing_accounts (
  tenant_id, stakeholder_account_id, nickname, account_holder_name,
  routing_number, account_number_last4, account_number_encrypted, auto_debit_enabled
) VALUES (
  '${TENANT_A}', '${STAKE_A}', 'Operating', 'Acme',
  '021000021', '1234', 'cipher', true
);
`);
  assert.notEqual(beforeInsert.status, 0, 'leftover policy must fail the insert');
  const beforeErr = `${beforeInsert.stderr}\n${beforeInsert.stdout}`;
  assert.match(beforeErr, /permission denied for table users/i);
  note('before: permission denied for table users');

  psql(['-d', dbName, '-f', APPLY_SQL]);
  note('applied 33_tenant_billing_auth_users_containment.sql');

  const leftoverPolicy = query(`
SELECT count(*) FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'tenant_billing_accounts'
  AND (coalesce(qual,'') ~* 'auth\\.users' OR coalesce(with_check,'') ~* 'auth\\.users');
`);
  assert.equal(leftoverPolicy, '0');

  const leftoverFk = query(`
SELECT count(*)
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
JOIN pg_namespace n ON t.relnamespace = n.oid
JOIN pg_class ref ON c.confrelid = ref.oid
JOIN pg_namespace rn ON ref.relnamespace = rn.oid
WHERE n.nspname = 'public'
  AND t.relname = 'tenant_billing_accounts'
  AND c.contype = 'f'
  AND rn.nspname = 'auth'
  AND ref.relname = 'users';
`);
  assert.equal(leftoverFk, '0');

  const usersSelect = query(`
SELECT has_table_privilege('authenticated', 'auth.users', 'SELECT')::text
  || ' ' || has_table_privilege('checksops', 'auth.users', 'SELECT')::text;
`);
  assert.equal(usersSelect, 'false false');

  const afterInsert = asMember(`
INSERT INTO public.tenant_billing_accounts (
  tenant_id, stakeholder_account_id, nickname, account_holder_name,
  account_type, entity_type, verification_status, account_number_last4,
  ach_authorized_at, auto_debit_enabled
) VALUES (
  '${TENANT_A}', '${STAKE_A}', 'Operating', 'Acme',
  'checking', 'business', 'verified', '1234',
  now(), true
);
`);
  if (afterInsert.status !== 0) {
    throw new Error(`member insert failed after containment: ${afterInsert.stderr || afterInsert.stdout}`);
  }
  note('after: member insert succeeded without auth.users');

  const toggle = asMember(`
UPDATE public.tenant_billing_accounts
SET auto_debit_enabled = false
WHERE tenant_id = '${TENANT_A}';
`);
  if (toggle.status !== 0) {
    throw new Error(`auto-debit toggle failed: ${toggle.stderr || toggle.stdout}`);
  }

  const outsider = asMember(`
INSERT INTO public.tenant_billing_accounts (
  tenant_id, stakeholder_account_id, nickname, account_holder_name, auto_debit_enabled
) VALUES (
  '${TENANT_A}', '${STAKE_A}', 'Other', 'Nope', true
);
`, OTHER);
  assert.notEqual(outsider.status, 0, 'other tenant must not write this billing row');

  const enabled = query(`
SELECT auto_debit_enabled::text FROM public.tenant_billing_accounts WHERE tenant_id = '${TENANT_A}';
`);
  assert.equal(enabled, 'false');
  note('auto-debit toggle persisted');
});
