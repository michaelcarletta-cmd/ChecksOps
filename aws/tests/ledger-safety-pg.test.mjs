import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLAIM_NULL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLAIM_MISSING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHECK_1 = '33333333-3333-4333-8333-333333333333';
const CHECK_2 = '44444444-4444-4444-8444-444444444444';
const CHECK_3 = '55555555-5555-4555-8555-555555555555';
const USER_A = 'a1000000-0000-4000-8000-000000000001';

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
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');

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

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role)
$$;

CREATE OR REPLACE FUNCTION public.user_belongs_to_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id = _user_id AND tu.tenant_id = _tenant_id
  )
$$;

CREATE TABLE public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_number text UNIQUE,
  status text,
  org_id uuid,
  policyholder_name text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.check_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  external_system text,
  external_claim_id uuid,
  claim_number text
);

CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  claim_id uuid,
  case_id uuid,
  amount numeric,
  check_source text DEFAULT 'insurance',
  status text DEFAULT 'needs_review',
  check_number text,
  carrier_name text,
  payee_line text,
  issue_date date,
  freedom_claim_id uuid,
  freedom_claim_number text,
  detected_claim_number text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  claim_id uuid,
  check_id uuid,
  event_type text NOT NULL,
  occurred_at timestamptz DEFAULT now(),
  amount numeric,
  actor_label text,
  payload_json jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.claim_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid,
  check_intake_item_id uuid UNIQUE,
  check_number text,
  amount numeric,
  carrier_name text,
  check_date date,
  payee_line text,
  source text,
  check_type text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.claim_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid,
  check_intake_item_id uuid,
  amount numeric,
  payment_method text,
  payment_date date,
  recipient_type text,
  direction text,
  check_number text,
  notes text,
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.resolve_check_case(
  _tenant_id uuid,
  _claim_id uuid DEFAULT NULL,
  _external_claim_id uuid DEFAULT NULL,
  _claim_number text DEFAULT NULL,
  _insured_name text DEFAULT NULL,
  _property_address text DEFAULT NULL,
  _carrier_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case_id uuid;
  v_ext uuid := COALESCE(_claim_id, _external_claim_id);
BEGIN
  IF _tenant_id IS NULL THEN RETURN NULL; END IF;
  IF v_ext IS NOT NULL THEN
    SELECT id INTO v_case_id FROM public.check_cases
     WHERE external_system = 'freedom_crm' AND external_claim_id = v_ext
     LIMIT 1;
    IF v_case_id IS NOT NULL THEN RETURN v_case_id; END IF;
    INSERT INTO public.check_cases (tenant_id, external_system, external_claim_id, claim_number)
    VALUES (_tenant_id, 'freedom_crm', v_ext, _claim_number)
    RETURNING id INTO v_case_id;
    RETURN v_case_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_check_intake_assign_case()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.case_id IS NULL THEN
    NEW.case_id := public.resolve_check_case(
      NEW.tenant_id, NEW.claim_id, NEW.freedom_claim_id,
      COALESCE(NEW.freedom_claim_number, NEW.detected_claim_number)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assign_case_on_check_intake
  BEFORE INSERT OR UPDATE OF claim_id, freedom_claim_id, tenant_id
  ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_check_intake_assign_case();

CREATE OR REPLACE FUNCTION public.tg_auto_link_check_to_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_link_check_to_claim_ins
  BEFORE INSERT ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_auto_link_check_to_claim();

ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;

CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE app_staff LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT authenticated TO app_staff;
GRANT USAGE ON SCHEMA public TO authenticated, service_role, app_staff;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role, app_staff;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role, app_staff;

INSERT INTO public.tenant_users(user_id, tenant_id) VALUES ('${USER_A}'::uuid, '${TENANT_A}'::uuid);
INSERT INTO public.user_roles(user_id, role) VALUES ('${USER_A}'::uuid, 'staff');
`;

test('isolated PostgreSQL claim-link and check_received matrix', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true, 'local PostgreSQL 16 initdb is required');

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-ledger-safety-${stamp}-`));
  const port = 55400 + (process.pid % 1000);
  const dbName = `ledger_safety_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `ledger_safety_pg_${stamp}.log`);
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
  const psql = (extra, input) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra], input ? { input } : {});
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };
  const scalar = (sql) => psql(['-d', dbName, '-A', '-t', '-c', sql]).stdout.trim();
  const applyFile = (rel) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, rel)]);
    if (result.status !== 0) {
      throw new Error(`apply ${rel} failed: ${result.stderr || result.stdout}`);
    }
    note(`applied ${rel}`);
  };

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-c', bootstrapSql]);
  psql(['-d', dbName, '-c', `GRANT CONNECT ON DATABASE ${dbName} TO app_staff`]);
  applyFile('supabase/migrations/20260918170010_guard_check_claim_org.sql');
  applyFile('supabase/migrations/20260918170020_verify_claim_payments_check_intake_index.sql');
  applyFile('supabase/migrations/20260918170040_one_check_received_writer.sql');
  applyFile('supabase/migrations/20260918170100_sync_check_claim_ledger.sql');
  applyFile('supabase/migrations/20260918170110_strip_sync_check_claim_ledger_check_received.sql');

  psql(['-d', dbName, '-c', `
INSERT INTO public.claims(id, claim_number, status, org_id) VALUES
  ('${CLAIM_A}', 'CL-A', 'open', '${TENANT_A}'),
  ('${CLAIM_B}', 'CL-B', 'open', '${TENANT_B}'),
  ('${CLAIM_NULL}', 'CL-NULL', 'open', NULL);
`]);

  note('1 same-org allow');
  assert.equal(scalar(`SELECT public.evaluate_check_claim_link('${TENANT_A}', '${CLAIM_A}')`), 'same_org');

  note('2 foreign-org deny');
  assert.equal(scalar(`SELECT public.evaluate_check_claim_link('${TENANT_A}', '${CLAIM_B}')`), 'cross_org');

  note('3 NULL-org deny');
  assert.equal(scalar(`SELECT public.evaluate_check_claim_link('${TENANT_A}', '${CLAIM_NULL}')`), 'unassigned_claim');

  note('4 NULL-org with check_cases still deny');
  psql(['-d', dbName, '-c', `
INSERT INTO public.check_cases(tenant_id, external_system, external_claim_id)
VALUES ('${TENANT_A}', 'freedom_crm', '${CLAIM_NULL}');
`]);
  assert.equal(scalar(`SELECT public.evaluate_check_claim_link('${TENANT_A}', '${CLAIM_NULL}')`), 'unassigned_claim');

  note('5 NULL-org with older intake still deny');
  psql(['-d', dbName, '-c', `
INSERT INTO public.check_intake_items(id, tenant_id, claim_id, amount)
VALUES ('${CHECK_3}', '${TENANT_A}', NULL, 10);
`]);
  assert.equal(scalar(`SELECT public.evaluate_check_claim_link('${TENANT_A}', '${CLAIM_NULL}')`), 'unassigned_claim');

  note('6 missing claim deny');
  assert.equal(scalar(`SELECT public.evaluate_check_claim_link('${TENANT_A}', '${CLAIM_MISSING}')`), 'missing_claim');

  note('7 new tracking claim with org then link');
  const newId = scalar(`
INSERT INTO public.claims(claim_number, status, org_id)
VALUES ('CL-NEW', 'tracking', '${TENANT_A}')
RETURNING id;
`);
  assert.match(newId, /-/);
  const lateCheck = scalar(`
INSERT INTO public.check_intake_items(tenant_id, claim_id, amount, check_source)
VALUES ('${TENANT_A}', '${newId}', 25, 'insurance')
RETURNING id;
`);
  assert.equal(scalar(`SELECT claim_id::text FROM public.check_intake_items WHERE id = '${lateCheck}'`), newId);

  note('8 unlink allow');
  psql(['-d', dbName, '-c', `UPDATE public.check_intake_items SET claim_id = NULL WHERE id = '${lateCheck}'`]);
  assert.equal(scalar(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${lateCheck}'`), 't');

  note('9 relink A to B same-org allow');
  const claimC = scalar(`INSERT INTO public.claims(claim_number, status, org_id) VALUES ('CL-C', 'open', '${TENANT_A}') RETURNING id;`);
  psql(['-d', dbName, '-c', `
UPDATE public.check_intake_items SET claim_id = '${CLAIM_A}' WHERE id = '${lateCheck}';
UPDATE public.check_intake_items SET claim_id = '${claimC}' WHERE id = '${lateCheck}';
`]);
  assert.equal(scalar(`SELECT claim_id::text FROM public.check_intake_items WHERE id = '${lateCheck}'`), claimC);

  note('10 relink to foreign denied, preserve A');
  psql(['-d', dbName, '-c', `UPDATE public.check_intake_items SET claim_id = '${CLAIM_A}' WHERE id = '${lateCheck}'`]);
  const foreignRelink = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `UPDATE public.check_intake_items SET claim_id = '${CLAIM_B}' WHERE id = '${lateCheck}'`]);
  assert.notEqual(foreignRelink.status, 0);
  assert.match(`${foreignRelink.stderr}${foreignRelink.stdout}`, /check_claim_link_denied: cross_org/);
  assert.equal(scalar(`SELECT claim_id::text FROM public.check_intake_items WHERE id = '${lateCheck}'`), CLAIM_A);

  note('11 service_role cannot bypass');
  const svc = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `SET ROLE service_role; UPDATE public.check_intake_items SET claim_id = '${CLAIM_NULL}' WHERE id = '${lateCheck}'`]);
  assert.notEqual(svc.status, 0);
  assert.match(`${svc.stderr}${svc.stdout}`, /unassigned_claim/);
  assert.equal(scalar(`SELECT claim_id::text FROM public.check_intake_items WHERE id = '${lateCheck}'`), CLAIM_A);

  note('12 auto-link cannot attach NULL-org');
  const autoId = scalar(`
INSERT INTO public.check_intake_items(tenant_id, detected_claim_number, amount)
VALUES ('${TENANT_A}', 'CL-NULL', 11)
RETURNING id;
`);
  assert.equal(scalar(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${autoId}'`), 't');

  note('13 June auto-link cannot attach NULL-org');
  const juneId = scalar(`
INSERT INTO public.check_intake_items(tenant_id, detected_claim_number, amount)
VALUES ('${TENANT_A}', 'cl-null', 12)
RETURNING id;
`);
  assert.equal(scalar(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${juneId}'`), 't');

  note('14 assign_case before guard cannot make NULL-org linkable');
  const assignCase = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `INSERT INTO public.check_intake_items(id, tenant_id, claim_id, amount)
     VALUES ('${CHECK_1}', '${TENANT_A}', '${CLAIM_NULL}', 30)`]);
  assert.notEqual(assignCase.status, 0);
  assert.match(`${assignCase.stderr}${assignCase.stdout}`, /unassigned_claim/);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.check_intake_items WHERE id = '${CHECK_1}'`), '0');

  note('15 linked insurance insert one check_received');
  psql(['-d', dbName, '-c', `
INSERT INTO public.check_intake_items(id, tenant_id, claim_id, amount, check_source)
VALUES ('${CHECK_1}', '${TENANT_A}', '${CLAIM_A}', 100, 'insurance');
`]);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_1}' AND event_type = 'check_received'`), '1');

  note('16 late link one event');
  psql(['-d', dbName, '-c', `
INSERT INTO public.check_intake_items(id, tenant_id, claim_id, amount)
VALUES ('${CHECK_2}', '${TENANT_A}', NULL, 40);
`]);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_2}' AND event_type = 'check_received'`), '0');
  psql(['-d', dbName, '-c', `UPDATE public.check_intake_items SET claim_id = '${CLAIM_A}' WHERE id = '${CHECK_2}'`]);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_2}' AND event_type = 'check_received'`), '1');

  note('17 relink moves same event');
  const eventId = scalar(`SELECT id::text FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_2}' AND event_type = 'check_received'`);
  psql(['-d', dbName, '-c', `UPDATE public.check_intake_items SET claim_id = '${claimC}' WHERE id = '${CHECK_2}'`]);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_2}' AND event_type = 'check_received'`), '1');
  assert.equal(scalar(`SELECT id::text FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_2}' AND event_type = 'check_received'`), eventId);
  assert.equal(scalar(`SELECT claim_id::text FROM public.homeowner_ledger_events WHERE id = '${eventId}'`), claimC);

  note('18 retry no duplicate');
  psql(['-d', dbName, '-c', `UPDATE public.check_intake_items SET claim_id = '${claimC}' WHERE id = '${CHECK_2}'`]);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_2}' AND event_type = 'check_received'`), '1');

  note('19 two physical checks two events');
  assert.equal(scalar(`
SELECT COUNT(*) FROM public.homeowner_ledger_events
WHERE event_type = 'check_received' AND check_id IN ('${CHECK_1}', '${CHECK_2}')
`), '2');

  note('20 status transition no new check_received');
  const beforeStatus = scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_1}' AND event_type = 'check_received'`);
  psql(['-d', dbName, '-c', `UPDATE public.check_intake_items SET status = 'deposited' WHERE id = '${CHECK_1}'`]);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_1}' AND event_type = 'check_received'`), beforeStatus);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${CHECK_1}' AND event_type = 'deposited'`), '1');

  note('21 migrate-all one check_received writer');
  const writers = scalar(`
SELECT COUNT(*) FROM pg_proc
WHERE proname IN ('hle_on_check_intake_insert', 'sync_check_claim_ledger', 'sync_homeowner_ledger_from_check')
  AND prosrc ILIKE '%INSERT INTO public.homeowner_ledger_events%'
  AND prosrc ILIKE '%check_received%'
  AND prosrc NOT ILIKE '%INSERT no longer writes check_received%'
`);
  assert.equal(writers, '1');
  assert.equal(scalar(`
SELECT COUNT(*) FROM pg_proc
WHERE proname = 'hle_on_check_intake_insert'
  AND prosrc ILIKE '%check_received%'
`), '1');
  assert.equal(scalar(`
SELECT COUNT(*) FROM pg_proc
WHERE proname = 'sync_check_claim_ledger'
  AND prosrc ILIKE '%INSERT INTO public.homeowner_ledger_events%'
  AND prosrc ILIKE '%check_received%'
`), '0');

  note('22 insert after migrate-all one event');
  const afterAll = scalar(`
INSERT INTO public.check_intake_items(tenant_id, claim_id, amount)
VALUES ('${TENANT_A}', '${CLAIM_A}', 9)
RETURNING id;
`);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${afterAll}' AND event_type = 'check_received'`), '1');

  note('23 late link after migrate-all one event');
  const late2 = scalar(`
INSERT INTO public.check_intake_items(tenant_id, claim_id, amount)
VALUES ('${TENANT_A}', NULL, 8)
RETURNING id;
`);
  psql(['-d', dbName, '-c', `UPDATE public.check_intake_items SET claim_id = '${CLAIM_A}' WHERE id = '${late2}'`]);
  assert.equal(scalar(`SELECT COUNT(*) FROM public.homeowner_ledger_events WHERE check_id = '${late2}' AND event_type = 'check_received'`), '1');

  note('24 existing correct index pass');
  assert.equal(scalar(`SELECT public.verify_claim_payments_check_intake_index()->>'action'`), 'pass');

  note('25 same-name non-unique fail');
  psql(['-d', dbName, '-c', `DROP INDEX public.idx_claim_payments_check_intake`]);
  psql(['-d', dbName, '-c', `CREATE INDEX idx_claim_payments_check_intake ON public.claim_payments(check_intake_item_id)`]);
  const badUnique = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT public.verify_claim_payments_check_intake_index()`]);
  assert.notEqual(badUnique.status, 0);
  assert.match(`${badUnique.stderr}${badUnique.stdout}`, /catalog shape is not UNIQUE/);

  note('26 wrong key fail');
  psql(['-d', dbName, '-c', `
DROP INDEX public.idx_claim_payments_check_intake;
CREATE UNIQUE INDEX idx_claim_payments_check_intake ON public.claim_payments(claim_id);
`]);
  const badKey = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT public.verify_claim_payments_check_intake_index()`]);
  assert.notEqual(badKey.status, 0);

  note('27 wrong predicate fail');
  psql(['-d', dbName, '-c', `
DROP INDEX public.idx_claim_payments_check_intake;
CREATE UNIQUE INDEX idx_claim_payments_check_intake ON public.claim_payments(check_intake_item_id);
`]);
  const badPred = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT public.verify_claim_payments_check_intake_index()`]);
  assert.notEqual(badPred.status, 0);

  note('28 duplicate identities stop');
  psql(['-d', dbName, '-c', `
DROP INDEX IF EXISTS public.idx_claim_payments_check_intake;
INSERT INTO public.claim_payments(claim_id, check_intake_item_id, amount)
VALUES ('${CLAIM_A}', '${CHECK_1}', 1), ('${CLAIM_A}', '${CHECK_1}', 2);
`]);
  const dupes = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT public.verify_claim_payments_check_intake_index()`]);
  assert.notEqual(dupes.status, 0);
  assert.match(`${dupes.stderr}${dupes.stdout}`, /duplicate claim_payments/);

  note('29 authenticated same-org allowed');
  psql(['-d', dbName, '-c', `
DELETE FROM public.claim_payments WHERE check_intake_item_id = '${CHECK_1}';
CREATE UNIQUE INDEX idx_claim_payments_check_intake
  ON public.claim_payments(check_intake_item_id)
  WHERE check_intake_item_id IS NOT NULL;
`]);
  const staffArgs = ['-h', pgData, '-p', String(port), '-U', 'app_staff', '-d', dbName, '-v', 'ON_ERROR_STOP=1'];
  const authOk = run(path.join(PG_BIN, 'psql'), staffArgs, {
    input: `SELECT set_config('request.jwt.claim.sub', '${USER_A}', true);
UPDATE public.check_intake_items SET claim_id = '${claimC}' WHERE id = '${CHECK_1}';\n`,
  });
  assert.equal(authOk.status, 0, authOk.stderr || authOk.stdout);
  assert.equal(scalar(`SELECT claim_id::text FROM public.check_intake_items WHERE id = '${CHECK_1}'`), claimC);

  note('30 authenticated foreign-org denied');
  const authDeny = run(path.join(PG_BIN, 'psql'), staffArgs, {
    input: `SELECT set_config('request.jwt.claim.sub', '${USER_A}', true);
UPDATE public.check_intake_items SET claim_id = '${CLAIM_B}' WHERE id = '${CHECK_1}';\n`,
  });
  assert.notEqual(authDeny.status, 0);
  assert.equal(scalar(`SELECT claim_id::text FROM public.check_intake_items WHERE id = '${CHECK_1}'`), claimC);

  note('31 RLS does not broaden claims');
  assert.equal(scalar(`
SELECT COUNT(*) FROM pg_policies
WHERE tablename = 'claims' AND cmd IN ('SELECT', 'ALL')
  AND (qual ILIKE '%true%' OR with_check ILIKE '%true%')
`), '0');

  note('32 SECURITY DEFINER/service-role still hits BEFORE guard');
  const definer = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c', `
SET ROLE service_role;
UPDATE public.check_intake_items SET claim_id = '${CLAIM_NULL}' WHERE id = '${CHECK_1}';
`]);
  assert.notEqual(definer.status, 0);
  assert.match(`${definer.stderr}${definer.stdout}`, /unassigned_claim/);

  note('PASS isolated postgres matrix');
});
