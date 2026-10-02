import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';
const PRIOR = 'supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql';
const MIGRATION = 'supabase/migrations/20261002200000_user_can_move_tenant_checks_membership_only.sql';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '99999999-9999-4999-8999-999999999999';
const MEMBER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTSIDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLATFORM_ADMIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';

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

const bootstrapSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TYPE public.check_stage AS ENUM ('review','loss_draft','endorsing','ready_for_deposit','deposited');

CREATE TABLE public.tenant_users (
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  PRIMARY KEY (user_id, tenant_id)
);
CREATE TABLE public.user_roles (
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role)
$$;

CREATE OR REPLACE FUNCTION public.user_belongs_to_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE user_id = _user_id AND tenant_id = _tenant_id
  )
$$;

CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  status text,
  check_stage public.check_stage,
  deposit_recommendation text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.claim_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_intake_item_id uuid,
  check_stage public.check_stage,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.check_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid,
  tenant_id uuid,
  event_type text,
  actor_id uuid,
  event_description text,
  event_data jsonb
);

INSERT INTO public.tenant_users(user_id, tenant_id) VALUES
  ('${MEMBER}'::uuid, '${FREEDOM}'::uuid),
  ('${OUTSIDER}'::uuid, '${OTHER}'::uuid);
INSERT INTO public.user_roles(user_id, role) VALUES
  ('${MEMBER}'::uuid, 'staff'),
  ('${OUTSIDER}'::uuid, 'admin'),
  ('${PLATFORM_ADMIN}'::uuid, 'admin');

INSERT INTO public.check_intake_items(id, tenant_id, status, check_stage)
VALUES ('${CHECK_ID}'::uuid, '${FREEDOM}'::uuid, 'endorsements_in_progress', 'endorsing');
INSERT INTO public.claim_checks(check_intake_item_id, check_stage)
VALUES ('${CHECK_ID}'::uuid, 'endorsing');
`;

test('real PostgreSQL rejects text assignment to check_stage and accepts public.check_stage', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true, 'local PostgreSQL 16 initdb is required');

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-check-stage-${stamp}-`));
  const port = 55600 + (process.pid % 1000);
  const dbName = `check_stage_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `check_stage_enum_assignment_pg_${stamp}.log`);
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
    } catch { /* ignore */ }
    stopCluster();
  });

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
  mustRun(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', logPath, '-w', 'start']);
  started = true;

  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-v', 'ON_ERROR_STOP=1'];
  const psql = (extra, input, { allowFail = false } = {}) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra], input ? { input } : {});
    if (!allowFail && result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };
  const scalar = (sql) => {
    const raw = psql(['-d', dbName, '-A', '-t', '-c', sql]).stdout.trim();
    const line = raw.split('\n').map((part) => part.trim()).find((part) => (
      part
      && !/^(INSERT|UPDATE|DELETE|SELECT|CREATE|DO|ALTER|DROP|PREPARE|EXECUTE)\b/i.test(part)
    ));
    return line || raw;
  };

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-c', bootstrapSql]);

  const textAssign = run(path.join(PG_BIN, 'psql'), [
    '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', dbName, '-v', 'ON_ERROR_STOP=1',
    '-c', `PREPARE bad_claim_stage(text, uuid) AS
      UPDATE public.claim_checks
      SET check_stage = $1::text, updated_at = now()
      WHERE check_intake_item_id = $2::uuid;`,
  ]);
  note(`text assignment prepare status=${textAssign.status} stderr=${(textAssign.stderr || '').trim()}`);
  note(`text assignment stdout=${(textAssign.stdout || '').trim()}`);
  assert.notEqual(textAssign.status, 0);
  const textError = `${textAssign.stderr}\n${textAssign.stdout}`;
  assert.match(textError, /column "check_stage" is of type check_stage but expression is of type text/);

  const sqlstateRaw = psql(['-d', dbName, '-A', '-t'], `
    CREATE TEMP TABLE check_stage_cast_error (sqlstate text, message text);
    DO $$
    BEGIN
      UPDATE public.claim_checks SET check_stage = 'review'::text;
    EXCEPTION WHEN others THEN
      INSERT INTO check_stage_cast_error VALUES (SQLSTATE, SQLERRM);
    END $$;
    SELECT sqlstate FROM check_stage_cast_error;
  `).stdout.trim();
  const sqlstate = sqlstateRaw.split('\n').map((part) => part.trim()).find((part) => /^\d{5}$/.test(part));
  note(`text assignment sqlstate raw=${sqlstateRaw} parsed=${sqlstate}`);
  assert.equal(sqlstate, '42804');

  const enumAssign = psql(['-d', dbName, '-A', '-t'], `
    PREPARE good_claim_stage(text, uuid) AS
      UPDATE public.claim_checks
      SET check_stage = $1::public.check_stage, updated_at = now()
      WHERE check_intake_item_id = $2::uuid;
    EXECUTE good_claim_stage('review', '${CHECK_ID}');
    SELECT check_stage::text FROM public.claim_checks WHERE check_intake_item_id = '${CHECK_ID}';
  `);
  note(`enum assignment stdout=${enumAssign.stdout.trim()}`);
  assert.match(enumAssign.stdout, /^review$/m);
  assert.equal(scalar(`SELECT check_stage::text FROM public.claim_checks WHERE check_intake_item_id = '${CHECK_ID}'`), 'review');

  const applyFile = (rel) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-f', path.join(ROOT, rel)]);
    if (result.status !== 0) {
      throw new Error(`apply ${rel} failed: ${result.stderr || result.stdout}`);
    }
    note(`applied ${rel}`);
  };
  applyFile(PRIOR);

  const defHash = (identity) => scalar(`
    SELECT encode(sha256(convert_to(pg_get_functiondef('${identity}'::regprocedure), 'UTF8')), 'hex')
  `);
  const priorMoveHash = defHash('public.user_can_move_tenant_checks(uuid,uuid)');
  const priorOverrideHash = defHash('public.admin_override_check_status(uuid,text,uuid)');
  note(`prior user_can_move_tenant_checks sha256=${priorMoveHash}`);
  note(`prior admin_override_check_status sha256=${priorOverrideHash}`);

  applyFile(MIGRATION);

  const moveHash = defHash('public.user_can_move_tenant_checks(uuid,uuid)');
  const overrideHash = defHash('public.admin_override_check_status(uuid,text,uuid)');
  const moveDef = psql([
    '-d', dbName, '-A', '-t', '-c',
    `SELECT pg_get_functiondef('public.user_can_move_tenant_checks(uuid,uuid)'::regprocedure)`,
  ]).stdout;
  note(`new user_can_move_tenant_checks sha256=${moveHash}`);
  note(`post-migration admin_override_check_status sha256=${overrideHash}`);
  note(`new user_can_move_tenant_checks def=\n${moveDef}`);

  assert.notEqual(moveHash, priorMoveHash);
  assert.equal(overrideHash, priorOverrideHash);
  assert.match(moveDef, /user_belongs_to_tenant/);
  assert.doesNotMatch(moveDef, /has_role/);

  const bool = (sql) => scalar(sql) === 't';
  assert.equal(bool(`SELECT public.user_can_move_tenant_checks('${MEMBER}'::uuid, '${FREEDOM}'::uuid)`), true);
  assert.equal(bool(`SELECT public.user_can_move_tenant_checks('${OUTSIDER}'::uuid, '${FREEDOM}'::uuid)`), false);
  assert.equal(bool(`SELECT public.user_can_move_tenant_checks('${OUTSIDER}'::uuid, '${OTHER}'::uuid)`), true);
  assert.equal(bool(`SELECT public.user_can_move_tenant_checks('${PLATFORM_ADMIN}'::uuid, '${FREEDOM}'::uuid)`), false);

  const sourceSha = createHash('sha256').update(fs.readFileSync(path.join(ROOT, MIGRATION))).digest('hex');
  note(`migration file sha256=${sourceSha}`);

  const hashes = {
    migration_file_sha256: sourceSha,
    user_can_move_tenant_checks_prior_sha256: priorMoveHash,
    user_can_move_tenant_checks_sha256: moveHash,
    admin_override_check_status_sha256: overrideHash,
    admin_override_check_status_unchanged: overrideHash === priorOverrideHash,
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'pr601-sql-definition-hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`);
  assert.equal(moveHash.length, 64);
  assert.equal(overrideHash.length, 64);
});
