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
const BARZZINI = 'fd77533e-6e72-4f28-a22d-cf026b392a4f';
const HOME_HERO = '3ea1e5eb-9f60-4905-99bb-59afbe7e1265';
const FREEDOM_USER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const C1C_USER = 'fd857564-9534-4b0f-95ac-624ed1273725';
const MULTI_USER = 'a1000000-0000-4000-8000-000000000099';
const CHECK = 'c1000000-0000-4000-8000-000000000001';
const CLAIM = 'ea7d428b-1f8f-493c-9a10-fca3e75da40d';
const C1C_CODE = 'C1CCODE1';

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

test('claim ownership invariant: stamp org_id from tenant context; share does not reassign', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-claim-owner-${stamp}-`));
  const port = 55600 + (process.pid % 1000);
  const dbName = `claim_owner_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `claim_ownership_invariant_pg_${stamp}.log`);
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
  const lastLine = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).pop() || '';
  const sessionSql = (userId, slug, sql) => `
SELECT set_config('request.app_user_id', '${userId}', false);
SELECT set_config('request.active_tenant_slug', '${slug || ''}', false);
${sql}
`;
  const asUser = (userId, slug, sql) => lastLine(scalar(sessionSql(userId, slug, sql)));
  const insertClaimOrg = (userId, slug, claimNumber, orgIdSql = 'NULL') => asUser(userId, slug, `
WITH ins AS (
  INSERT INTO public.claims (claim_number, org_id)
  VALUES ('${claimNumber}', ${orgIdSql})
  RETURNING org_id::text AS org_id
) SELECT org_id FROM ins;
`);
  const asUserExpectError = (userId, slug, sql) => run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1'], {
    input: sessionSql(userId, slug, sql),
  });

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
CREATE TABLE public.identity_accounts (
  application_user_id uuid PRIMARY KEY,
  email text,
  status text
);
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
  slug text UNIQUE,
  partner_code text UNIQUE,
  subscription_status text NOT NULL DEFAULT 'active'
);
CREATE TABLE public.tenant_partner_code_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  code text NOT NULL
);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  status text
);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  claim_number text
);
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
    '39_claim_owner_org.sql',
  ]) {
    psql(['-d', dbName, '-f', path.join(SQL_DIR, name)]);
  }
  psql(['-d', dbName, '-f', path.join(SQL_DIR, '32_partner_share_lifecycle.sql')]);

  psql(['-d', dbName], `
INSERT INTO public.tenants (id, name, slug, partner_code) VALUES
  ('${FREEDOM}', 'Freedom', 'freedom', 'FREEDOM1'),
  ('${C1C}', 'C1C', 'c1c', '${C1C_CODE}'),
  ('${BARZZINI}', 'Barzzini', 'barzzini', 'BARZZIN1'),
  ('${HOME_HERO}', 'Home Hero', 'home-hero', 'HOMEHER1');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${FREEDOM_USER}', 'admin'),
  ('${C1C_USER}', 'admin'),
  ('${MULTI_USER}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${FREEDOM}', '${FREEDOM_USER}', 'admin'),
  ('${C1C}', '${C1C_USER}', 'admin'),
  ('${FREEDOM}', '${MULTI_USER}', 'admin'),
  ('${C1C}', '${MULTI_USER}', 'admin');
INSERT INTO public.claims (id, org_id, claim_number) VALUES
  ('${CLAIM}', '${FREEDOM}', '271682');
INSERT INTO public.check_intake_items (id, tenant_id, status) VALUES
  ('${CHECK}', '${FREEDOM}', 'received');
INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, accepted_at)
VALUES ('${FREEDOM}', '${C1C}', '${C1C_CODE}', 'active', now());
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checksops;
`);

  const baselineClaims = scalar("SELECT count(*) FROM public.claims");
  const baselineFreedomClaims = scalar(`SELECT count(*) FROM public.claims WHERE org_id = '${FREEDOM}'`);
  const baselineChecks = scalar("SELECT count(*) FROM public.check_intake_items");
  note(`baseline claims=${baselineClaims} freedom=${baselineFreedomClaims} checks=${baselineChecks}`);

  const freedomCreated = insertClaimOrg(FREEDOM_USER, '', 'F-NEW');
  note(`1 freedom-auth create → ${freedomCreated}`);
  assert.equal(freedomCreated, FREEDOM);

  const c1cCreated = insertClaimOrg(C1C_USER, '', 'C-NEW');
  note(`2 c1c-auth create → ${c1cCreated}`);
  assert.equal(c1cCreated, C1C);

  const freedomIgnoresC1c = insertClaimOrg(FREEDOM_USER, '', 'F-SPOOF', `'${C1C}'`);
  note(`3/5 freedom insert with c1c org_id → ${freedomIgnoresC1c}`);
  assert.equal(freedomIgnoresC1c, FREEDOM);

  const c1cIgnoresFreedom = insertClaimOrg(C1C_USER, '', 'C-SPOOF', `'${FREEDOM}'`);
  note(`3/6 c1c insert with freedom org_id → ${c1cIgnoresFreedom}`);
  assert.equal(c1cIgnoresFreedom, C1C);

  const nullRejectedOrStamped = insertClaimOrg(FREEDOM_USER, '', 'F-NULL');
  note(`4 null ownership stamped → ${nullRejectedOrStamped}`);
  assert.equal(nullRejectedOrStamped, FREEDOM);

  const multiNeedsSlug = asUserExpectError(MULTI_USER, '', `
INSERT INTO public.claims (claim_number, org_id) VALUES ('M-NONE', '${BARZZINI}');
`);
  assert.notEqual(multiNeedsSlug.status, 0);
  assert.match(`${multiNeedsSlug.stderr}\n${multiNeedsSlug.stdout}`, /claim_owner_tenant_required/);

  const multiFreedom = insertClaimOrg(MULTI_USER, 'freedom', 'M-FREEDOM', `'${C1C}'`);
  note(`multi + freedom slug ignores c1c org_id → ${multiFreedom}`);
  assert.equal(multiFreedom, FREEDOM);

  const multiC1c = insertClaimOrg(MULTI_USER, 'c1c', 'M-C1C', `'${FREEDOM}'`);
  note(`multi + c1c slug ignores freedom org_id → ${multiC1c}`);
  assert.equal(multiC1c, C1C);

  const uuidSlugIgnored = asUserExpectError(MULTI_USER, C1C, `
INSERT INTO public.claims (claim_number) VALUES ('M-UUID');
`);
  assert.notEqual(uuidSlugIgnored.status, 0);
  assert.match(`${uuidSlugIgnored.stderr}\n${uuidSlugIgnored.stdout}`, /claim_owner_tenant_required/);

  const beforeShare = scalar(`SELECT org_id::text FROM public.claims WHERE id = '${CLAIM}'`);
  const beforeCheck = scalar(`SELECT tenant_id::text FROM public.check_intake_items WHERE id = '${CHECK}'`);
  assert.equal(beforeShare, FREEDOM);
  assert.equal(beforeCheck, FREEDOM);

  const shareId = asUser(FREEDOM_USER, 'freedom', `
SELECT public.aws_share_check_with_partner('${CHECK}'::uuid, '${C1C}'::uuid) ->> 'share_id';
`);
  note(`7 share id=${shareId}`);
  assert.match(shareId, /^[0-9a-f-]{36}$/);
  assert.equal(scalar(`SELECT org_id::text FROM public.claims WHERE id = '${CLAIM}'`), FREEDOM);
  assert.equal(scalar(`SELECT tenant_id::text FROM public.check_intake_items WHERE id = '${CHECK}'`), FREEDOM);

  asUser(FREEDOM_USER, 'freedom', `
SELECT public.aws_revoke_shared_check('${shareId}'::uuid);
`);
  note('8 revoke');
  assert.equal(scalar(`SELECT org_id::text FROM public.claims WHERE id = '${CLAIM}'`), FREEDOM);
  assert.equal(scalar(`SELECT tenant_id::text FROM public.check_intake_items WHERE id = '${CHECK}'`), FREEDOM);
  assert.equal(scalar(`SELECT count(*) FROM public.shared_checks WHERE id = '${shareId}' AND revoked_at IS NOT NULL`), '1');

  const seededUnchanged = scalar(`
SELECT count(*) FILTER (WHERE id = '${CLAIM}' AND org_id = '${FREEDOM}')
FROM public.claims
`);
  assert.equal(seededUnchanged, '1');
  assert.equal(scalar(`SELECT tenant_id::text FROM public.check_intake_items WHERE id = '${CHECK}'`), FREEDOM);

  const report = {
    cases: {
      freedomCreate: freedomCreated,
      c1cCreate: c1cCreated,
      clientOrgIdIgnoredFreedom: freedomIgnoresC1c,
      clientOrgIdIgnoredC1c: c1cIgnoresFreedom,
      nullOwnershipStamped: nullRejectedOrStamped === FREEDOM,
      freedomCannotCreateC1c: freedomIgnoresC1c === FREEDOM,
      c1cCannotCreateFreedom: c1cIgnoresFreedom === C1C,
      shareLeavesFreedomOwned: true,
      revokeLeavesFreedomOwned: true,
    },
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'claim_ownership_invariant_pg.json'), JSON.stringify(report, null, 2));
  note(JSON.stringify(report));
});
