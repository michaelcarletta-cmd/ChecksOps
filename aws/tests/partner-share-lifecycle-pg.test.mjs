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
const OTHER = '33333333-3333-4333-8333-333333333333';
const UNRELATED = '44444444-4444-4444-8444-444444444444';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const PARTNER_USER = 'a1000000-0000-4000-8000-000000000002';
const OTHER_USER = 'a1000000-0000-4000-8000-000000000003';
const UNRELATED_USER = 'a1000000-0000-4000-8000-000000000004';
const CHECK_A = 'c1000000-0000-4000-8000-000000000001';
const CHECK_B = 'c1000000-0000-4000-8000-000000000002';
const CHECK_UNRELATED = 'c1000000-0000-4000-8000-000000000003';
const PARTNER_CODE = 'AB3K7X9P';
const OTHER_CODE = 'CD4L8Y0Q';

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

test('disposable PostgreSQL partner connect/share/revoke lifecycle', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-partner-share-${stamp}-`));
  const port = 55400 + (process.pid % 1000);
  const dbName = `partner_share_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `partner_share_lifecycle_pg_${stamp}.log`);
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
  for (const name of ['10_owner_helpers_from_identity.sql', '02_helpers.sql', '03_grants.sql', '11_access_helpers.sql', '20_write_helpers.sql', '15_access_grants.sql']) {
    psql(['-d', dbName, '-f', path.join(SQL_DIR, name)]);
  }

  psql(['-d', dbName], `
INSERT INTO public.tenants (id, name, partner_code) VALUES
  ('${SOURCE}', 'Source Co', 'ZZZZZZZ1'),
  ('${PARTNER}', 'Partner Co', '${PARTNER_CODE}'),
  ('${OTHER}', 'Other Co', '${OTHER_CODE}'),
  ('${UNRELATED}', 'Unrelated Co', 'UNRELAT1');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${OWNER}', 'admin'), ('${PARTNER_USER}', 'admin'), ('${OTHER_USER}', 'admin'), ('${UNRELATED_USER}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${SOURCE}', '${OWNER}', 'admin'),
  ('${PARTNER}', '${PARTNER_USER}', 'admin'),
  ('${OTHER}', '${OTHER_USER}', 'admin'),
  ('${UNRELATED}', '${UNRELATED_USER}', 'admin');
INSERT INTO public.check_intake_items (id, tenant_id, status) VALUES
  ('${CHECK_A}', '${SOURCE}', 'received'),
  ('${CHECK_B}', '${SOURCE}', 'received'),
  ('${CHECK_UNRELATED}', '${UNRELATED}', 'received');
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checksops, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checksops, authenticated;
`);

  psql(['-d', dbName, '-c', `
INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by, accepted_at)
VALUES ('${SOURCE}', '${PARTNER}', '${PARTNER_CODE}', 'active', '${OWNER}', now());
`]);
  note('pre-migration duplicate invite_code insert is expected to fail');
  const dupBefore = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1'], {
    input: `INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status, created_by, accepted_at)
VALUES ('${OTHER}', '${PARTNER}', '${PARTNER_CODE}', 'active', '${OTHER_USER}', now());`,
  });
  assert.notEqual(dupBefore.status, 0);
  assert.match(`${dupBefore.stderr}${dupBefore.stdout}`, /unique|duplicate/i);
  psql(['-d', dbName, '-c', 'DELETE FROM public.tenant_partnerships']);

  psql(['-d', dbName, '-f', path.join(SQL_DIR, '32_partner_share_lifecycle.sql')]);
  note('applied 32_partner_share_lifecycle.sql');

  const matrix = `
CREATE TABLE public._results (test text PRIMARY KEY, ok boolean NOT NULL, detail text);
CREATE OR REPLACE FUNCTION public._ok(_t text, _ok boolean, _d text DEFAULT '') RETURNS void
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public._results VALUES (_t, _ok, _d) ON CONFLICT (test) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail; END; $$;
CREATE OR REPLACE FUNCTION public._call(_user uuid, _sql text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE _err text; _val jsonb;
BEGIN
  PERFORM set_config('request.app_user_id', _user::text, false);
  BEGIN
    EXECUTE 'SET ROLE checksops';
    EXECUTE 'SELECT to_jsonb((' || regexp_replace(_sql, '^\s*SELECT\s+', '', 'i') || '))' INTO _val;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.app_user_id', '', false);
    RETURN jsonb_build_object('ok', true, 'val', _val, 'error', NULL);
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
  pid uuid;
  sid uuid;
  sid2 uuid;
  n int;
BEGIN
  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${SOURCE}'::uuid)$q$);
  PERFORM public._ok('1_valid_code_creates', (r->>'ok')::boolean AND (r->'val'->>'created')::boolean, r::text);
  pid := (r->'val'->>'partnership_id')::uuid;

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_connect_partner_by_code('NOPE0000', '${SOURCE}'::uuid)$q$);
  PERFORM public._ok('2_invalid_code_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%partner_code_not_found%', r::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_connect_partner_by_code('ZZZZZZZ1', '${SOURCE}'::uuid)$q$);
  PERFORM public._ok('3_self_code_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%self_partnership%', r::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${UNRELATED}'::uuid)$q$);
  PERFORM public._ok('4_manipulated_source_tenant_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%not_authorized%', r::text);

  r := public._call('${UNRELATED_USER}'::uuid, $q$SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${SOURCE}'::uuid)$q$);
  PERFORM public._ok('5_unrelated_user_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%not_authorized%', r::text);

  r := public._call('${OTHER_USER}'::uuid, $q$SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${OTHER}'::uuid)$q$);
  PERFORM public._ok('6_second_source_same_code', (r->>'ok')::boolean AND (r->'val'->>'created')::boolean, r::text);

  SELECT count(*) INTO n FROM public.tenant_partnerships WHERE invitee_tenant_id = '${PARTNER}'::uuid AND status = 'active';
  PERFORM public._ok('6b_two_rows_same_code', n = 2, n::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${SOURCE}'::uuid)$q$);
  PERFORM public._ok('7_duplicate_idempotent', (r->>'ok')::boolean AND (r->'val'->>'created')::boolean IS FALSE, r::text);
  SELECT count(*) INTO n FROM public.tenant_partnerships WHERE inviter_tenant_id = '${SOURCE}'::uuid AND invitee_tenant_id = '${PARTNER}'::uuid;
  PERFORM public._ok('7b_no_duplicate_row', n = 1, n::text);

  UPDATE public.tenant_partnerships SET status = 'revoked', revoked_at = now() WHERE id = pid;
  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_connect_partner_by_code('${PARTNER_CODE}', '${SOURCE}'::uuid)$q$);
  PERFORM public._ok('8_reactivate_revoked_partnership', (r->>'ok')::boolean AND (r->'val'->>'reactivated')::boolean, r::text);
  SELECT count(*) INTO n FROM public.tenant_partnerships WHERE inviter_tenant_id = '${SOURCE}'::uuid AND invitee_tenant_id = '${PARTNER}'::uuid;
  PERFORM public._ok('8b_reactivate_no_new_row', n = 1, n::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK_A}'::uuid, '${PARTNER}'::uuid)$q$);
  PERFORM public._ok('9_owner_share_pass', (r->>'ok')::boolean AND (r->'val'->>'created')::boolean, r::text);
  sid := (r->'val'->>'share_id')::uuid;

  r := public._call('${PARTNER_USER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK_A}'::uuid, '${OTHER}'::uuid)$q$);
  PERFORM public._ok('10_non_owner_share_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%not_authorized%', r::text);

  r := public._call('${PARTNER_USER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK_A}'::uuid, '${UNRELATED}'::uuid)$q$);
  PERFORM public._ok('11_partner_share_onward_deny', (r->>'ok')::boolean IS FALSE, r::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK_A}'::uuid, '${UNRELATED}'::uuid)$q$);
  PERFORM public._ok('13_share_non_partner_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%not_a_partner%', r::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK_A}'::uuid, '${PARTNER}'::uuid)$q$);
  PERFORM public._ok('14_duplicate_share_idempotent', (r->>'ok')::boolean AND (r->'val'->>'created')::boolean IS FALSE AND (r->'val'->>'reactivated')::boolean IS FALSE, r::text);
  SELECT count(*) INTO n FROM public.shared_checks WHERE check_id = '${CHECK_A}'::uuid AND target_tenant_id = '${PARTNER}'::uuid;
  PERFORM public._ok('14b_one_share_row', n = 1, n::text);

  UPDATE public.shared_checks SET revoked_at = now() WHERE id = sid;
  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK_A}'::uuid, '${PARTNER}'::uuid)$q$);
  PERFORM public._ok('15_reshare_clears_revoked_at', (r->>'ok')::boolean AND (r->'val'->>'reactivated')::boolean, r::text);
  SELECT count(*) INTO n FROM public.shared_checks WHERE id = sid AND revoked_at IS NULL;
  PERFORM public._ok('15b_same_row_active', n = 1, n::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK_UNRELATED}'::uuid, '${PARTNER}'::uuid)$q$);
  PERFORM public._ok('16_unrelated_check_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%not_authorized%', r::text);

  r := public._call('${OWNER}'::uuid, format('SELECT public.aws_revoke_shared_check(%L::uuid)', sid));
  PERFORM public._ok('17_owner_revoke_share', (r->>'ok')::boolean AND (r->'val'->>'revoked')::boolean, r::text);

  UPDATE public.shared_checks SET revoked_at = NULL WHERE id = sid;
  r := public._call('${PARTNER_USER}'::uuid, format('SELECT public.aws_revoke_shared_check(%L::uuid)', sid));
  PERFORM public._ok('18_target_revoke_share_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%not_authorized%', r::text);

  r := public._call('${UNRELATED_USER}'::uuid, format('SELECT public.aws_revoke_shared_check(%L::uuid)', sid));
  PERFORM public._ok('19_unrelated_revoke_share_deny', (r->>'ok')::boolean IS FALSE AND (r->>'error') ILIKE '%not_authorized%', r::text);

  UPDATE public.shared_checks SET revoked_at = now() WHERE id = sid;
  r := public._call('${PARTNER_USER}'::uuid, $q$SELECT public.aws_is_active_shared_check_target('${CHECK_A}'::uuid)$q$);
  PERFORM public._ok('20_revoked_partner_read_false', (r->>'ok')::boolean AND (r->>'val')::boolean IS NOT TRUE, r::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_can_write_check('${CHECK_A}'::uuid)$q$);
  PERFORM public._ok('21_owner_write_after_revoke_share', (r->>'ok')::boolean AND (r->>'val')::boolean, r::text);
  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_can_access_check('${CHECK_A}'::uuid)$q$);
  PERFORM public._ok('21b_owner_read_after_revoke_share', (r->>'ok')::boolean AND (r->>'val')::boolean, r::text);

  UPDATE public.shared_checks SET revoked_at = NULL WHERE id = sid;
  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_share_check_with_partner('${CHECK_B}'::uuid, '${PARTNER}'::uuid)$q$);
  sid2 := (r->'val'->>'share_id')::uuid;
  INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, shared_by)
  VALUES ('${CHECK_UNRELATED}', '${UNRELATED}', '${OTHER}', '${UNRELATED_USER}');

  r := public._call('${OWNER}'::uuid, format('SELECT public.aws_revoke_tenant_partnership(%L::uuid)', pid));
  PERFORM public._ok('22_source_revoke_partnership', (r->>'ok')::boolean, r::text);
  SELECT count(*) INTO n FROM public.shared_checks WHERE source_tenant_id = '${SOURCE}'::uuid AND target_tenant_id = '${PARTNER}'::uuid AND revoked_at IS NULL;
  PERFORM public._ok('23_pair_shares_revoked', n = 0, n::text);
  SELECT count(*) INTO n FROM public.shared_checks WHERE check_id = '${CHECK_UNRELATED}'::uuid AND revoked_at IS NULL;
  PERFORM public._ok('24_unrelated_share_untouched', n = 1, n::text);

  r := public._call('${PARTNER_USER}'::uuid, $q$SELECT public.aws_is_active_shared_check_target('${CHECK_A}'::uuid)$q$);
  PERFORM public._ok('25_partner_reads_gone', (r->>'ok')::boolean AND (r->>'val')::boolean IS NOT TRUE, r::text);
  r := public._call('${PARTNER_USER}'::uuid, $q$SELECT public.aws_is_active_shared_check_target('${CHECK_B}'::uuid)$q$);
  PERFORM public._ok('25b_partner_reads_gone_check_b', (r->>'ok')::boolean AND (r->>'val')::boolean IS NOT TRUE, r::text);

  r := public._call('${OWNER}'::uuid, $q$SELECT public.aws_can_write_check('${CHECK_A}'::uuid)$q$);
  PERFORM public._ok('26_owner_retains_write', (r->>'ok')::boolean AND (r->>'val')::boolean, r::text);

  SELECT count(*) INTO n FROM public.tenant_partnerships WHERE id = pid AND status = 'revoked' AND revoked_at IS NOT NULL;
  PERFORM public._ok('27_partnership_revoked_row_kept', n = 1, n::text);
  SELECT count(*) INTO n FROM public.shared_checks WHERE id IN (sid, sid2);
  PERFORM public._ok('27b_share_rows_kept', n = 2, n::text);

  r := public._call('${UNRELATED_USER}'::uuid, format('SELECT public.aws_revoke_tenant_partnership(%L::uuid)', pid));
  PERFORM public._ok('22b_unrelated_partnership_revoke_deny', (r->>'ok')::boolean IS FALSE, r::text);

  r := public._call('${PARTNER_USER}'::uuid, $q$SELECT public.aws_can_write_check('${CHECK_A}'::uuid)$q$);
  PERFORM public._ok('30_partner_write_check_false', (r->>'ok')::boolean AND (r->>'val')::boolean IS NOT TRUE, r::text);
END $$;
`;
  psql(['-d', dbName], matrix);
  const results = JSON.parse(scalar(`
SELECT coalesce(json_object_agg(test, json_build_object('ok', ok, 'detail', detail) ORDER BY test), '{}'::json)
FROM public._results;
`));
  note(`matrix ${JSON.stringify(results)}`);
  const failed = Object.entries(results).filter(([, row]) => row.ok !== true);
  assert.equal(failed.length, 0, `failed cases: ${JSON.stringify(failed)}`);

  const pairUnique = scalar(`
SELECT indexdef FROM pg_indexes
WHERE tablename = 'tenant_partnerships' AND indexname = 'tenant_partnerships_unique_pair'
`);
  assert.match(pairUnique, /inviter_tenant_id/);
  const oldUnique = scalar(`
SELECT count(*) FROM pg_constraint
WHERE conrelid = 'public.tenant_partnerships'::regclass AND conname = 'tenant_partnerships_invite_code_key'
`);
  assert.equal(oldUnique, '0');
});
