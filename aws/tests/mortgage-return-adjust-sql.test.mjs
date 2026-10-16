/**
 * SQL 84 (aws/workflows/sql/84_mortgage_return_to_queue.sql) and SQL 85
 * (aws/workflows/sql/85_mortgage_compensation_adjust.sql): Mortgage Ops Return
 * to Queue and compensation Adjust, platform owner only. SQL 86
 * (aws/workflows/sql/86_mortgage_compensation_owner_only.sql): SQL 47's
 * compensation admin helper becomes platform owner only.
 *
 * Static checks plus an isolated PostgreSQL 16 run on top of the real identity
 * helpers (aws/identity/sql/02_auth_uid_guc.sql), the real platform-owner
 * predicate (aws/rls/sql/10_owner_helpers_from_identity.sql) and the Cursor
 * SQL 47 compensation ledger (byte-identical fixture).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PG_BIN, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SQL47_PATH = 'aws/tests/fixtures/mortgage-agent-compensation/47_mortgage_agent_compensation.sql';
const SQL84_PATH = 'aws/workflows/sql/84_mortgage_return_to_queue.sql';
const SQL85_PATH = 'aws/workflows/sql/85_mortgage_compensation_adjust.sql';
const SQL86_PATH = 'aws/workflows/sql/86_mortgage_compensation_owner_only.sql';
const SQL47 = read(SQL47_PATH);
const SQL84 = read(SQL84_PATH);
const SQL85 = read(SQL85_PATH);
const SQL86 = read(SQL86_PATH);
const AUTH_UID = read('aws/identity/sql/02_auth_uid_guc.sql');
const OWNER_HELPERS = read('aws/rls/sql/10_owner_helpers_from_identity.sql');
const stripComments = (sql) => sql.replace(/^\s*--.*$/gm, '');

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const GLOBAL_ADMIN = '00000000-0000-4000-8000-0000000000ab';
const TENANT_ADMIN = '00000000-0000-4000-8000-0000000000ac';
const AGENT_A = '00000000-0000-4000-8000-0000000000a1';
const AGENT_B = '00000000-0000-4000-8000-0000000000a2';
const TENANT_A = '00000000-0000-4000-8000-0000000000d1';
const TENANT_B = '00000000-0000-4000-8000-0000000000d2';
const CLAIM = '00000000-0000-4000-8000-0000000000c1';
const CHECK1 = '00000000-0000-4000-8000-000000000011';
const CHECK3 = '00000000-0000-4000-8000-000000000013';
const CHECK_X = '00000000-0000-4000-8000-000000000014';
const REQ1 = '00000000-0000-4000-8000-000000000021';
const REQ_QUEUED = '00000000-0000-4000-8000-000000000022';
const REQ3 = '00000000-0000-4000-8000-000000000023';
const REQ_EXCLUDED = '00000000-0000-4000-8000-000000000024';
const REQ_FOREIGN = '00000000-0000-4000-8000-000000000025';
// Seeded into mortgage_agent_compensation_exclusions by SQL 47 itself.
const SQL47_EXCLUDED = '5b20db20-13e1-4919-9528-06388d8661d2';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

test('SQL 47 fixture is byte-identical to the Cursor source', () => {
  assert.equal(
    createHash('sha256').update(SQL47).digest('hex'),
    'bdbdccbc44ca70ae86c7212f16fb1a2d2786071b61acb6b62c98e7863b2cc99c',
  );
});

test('SQL 84/85 are platform-owner-only forward migrations with no money side effects', () => {
  assert.match(SQL84, /^-- AWS: Mortgage Ops Return to Queue \(SQL 84\)\./);
  assert.match(SQL85, /^-- AWS: Mortgage Agent compensation Adjust \(SQL 85\)\./);
  for (const [name, sql, fn] of [
    ['84', SQL84, 'return_mortgage_handling_request_to_queue\\(uuid, text\\)'],
    ['85', SQL85, 'adjust_mortgage_agent_compensation\\(uuid, integer, text, uuid, text, text\\)'],
  ]) {
    const body = stripComments(sql);
    assert.doesNotMatch(body, /aws_can_admin_mortgage_agent_compensation/, `${name} admin helper`);
    assert.doesNotMatch(body, /has_role\(auth\.uid\(\), 'admin'/, `${name} admin role`);
    assert.doesNotMatch(body, /is_master_owner/, `${name} uses is_platform_owner()`);
    assert.match(body, /IF NOT COALESCE\(public\.is_platform_owner\(\), false\) THEN\s+RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';/);
    assert.doesNotMatch(sql, /5b20db20|7a7ec1ce|71ea6822/, `${name} hardcoded request ids`);
    assert.doesNotMatch(body, /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i, `${name} uuid literal`);
    assert.match(body, /mortgage_agent_compensation_exclusions x/);
    assert.match(body, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC;`));
    assert.match(body, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\s+TO checksops, authenticated;`));
    assert.equal((body.match(/SECURITY DEFINER/g) || []).length, 1);
    assert.match(body, /SET search_path = public\s+SET row_security = off/);
    // Money rules: no billing writes, no rate or payout changes, no providers.
    assert.doesNotMatch(body, /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.check_billing_events/i);
    assert.doesNotMatch(body, /mortgage_agent_compensation_rates/);
    assert.doesNotMatch(body, /status\s*=\s*'(paid|approved)'|'paid'\s*,|paid_at|approved_at/);
    assert.doesNotMatch(body, /\bmoov\b|\bstripe\b|\bach\b|\bwallet\b|clawback|tenant_billing_engine/i);
    assert.doesNotMatch(body, /GRANT\s+(UPDATE|INSERT|DELETE|ALL)\s+ON\s+TABLE/i);
    assert.doesNotMatch(body, /ALTER\s+TABLE\s+public\.mortgage_handling_requests/i);
  }
  const b84 = stripComments(SQL84);
  assert.match(b84, /USING \(COALESCE\(public\.is_platform_owner\(\), false\)\);/);
  assert.equal((b84.match(/UPDATE public\.mortgage_handling_requests/g) || []).length, 1);
  assert.match(b84, /SET assigned_employee_id = NULL,\s+status = 'requested',\s+updated_at = now\(\)/);
  assert.doesNotMatch(b84, /accepted_at\s*=\s*NULL/);
  const b85 = stripComments(SQL85);
  assert.doesNotMatch(b85, /UPDATE public\.mortgage_agent_compensation_entries/);
  assert.equal((b85.match(/INSERT INTO public\.mortgage_agent_compensation_entries/g) || []).length, 3);
  // Every child is booked as a new 'earned' entry for the chosen pay period.
  assert.equal((b85.match(/v_period,\s+'earned',\s+v_parent\.id,/g) || []).length, 3);
  assert.match(b85, /CHECK \(action IN \('approve', 'pay', 'adjust'\)\)/);
  // Children leave payment_batch_id NULL; the adjust batch links via audit.
  assert.doesNotMatch(b85, /payment_batch_id/);
  assert.match(b85, /DROP FUNCTION IF EXISTS public\.adjust_mortgage_agent_compensation\(uuid, integer, text, uuid, text\);/);
  assert.match(b85, /NOT COALESCE\(public\.aws_is_active_mortgage_agent\(p_counterparty_agent_id\), false\)/);
  assert.match(b85, /RAISE EXCEPTION 'adjustment_exceeds_parent'/);
  assert.match(b85, /RAISE EXCEPTION 'adjustment_exceeds_net'/);
  assert.match(b85, /RAISE EXCEPTION 'idempotency_key_conflict'/);
  assert.match(b85, /CREATE UNIQUE INDEX IF NOT EXISTS mortgage_agent_compensation_batches_adjust_idem_uidx\s+ON public\.mortgage_agent_compensation_batches \(idempotency_key\)\s+WHERE action = 'adjust' AND idempotency_key IS NOT NULL;/);
  // GATE 0 is exact, not ILIKE; the audit's billing lookup is tenant-bound and non-voided.
  assert.doesNotMatch(b84, /ILIKE/);
  assert.match(b84, /AND e\.tenant_id = v_req\.tenant_id\s+AND e\.event_type IN \('mortgage_ops_initial', 'mortgage_ops_additional_check'\)\s+AND e\.status IS DISTINCT FROM 'voided'/);
  for (const sql of [SQL84, SQL85, SQL86]) {
    assert.match(stripComments(sql), /RAISE EXCEPTION 'sql47_prerequisite_missing:/);
    assert.doesNotMatch(stripComments(sql), /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
    assert.doesNotMatch(sql, /rolls back/);
  }
});

test('SQL 86 makes the SQL 47 admin helper platform owner only and closes earn', () => {
  assert.match(SQL86, /^-- AWS: Mortgage Agent compensation is platform owner only \(SQL 86\)\./);
  const body = stripComments(SQL86);
  assert.match(body, /CREATE OR REPLACE FUNCTION public\.aws_can_admin_mortgage_agent_compensation\(\)\nRETURNS boolean\nLANGUAGE sql\nSTABLE\nSECURITY DEFINER\nSET search_path = public\nSET row_security = off\nAS \$\$\n  SELECT COALESCE\(public\.is_platform_owner\(\), false\);\n\$\$;/);
  // Same header as SQL 47's version, so CREATE OR REPLACE keeps its shape.
  assert.ok(SQL47.includes(`CREATE OR REPLACE FUNCTION public.aws_can_admin_mortgage_agent_compensation()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$`));
  assert.doesNotMatch(body, /public\.has_role|is_master_owner|'admin'/);
  for (const role of ['PUBLIC', 'checksops', 'authenticated']) {
    assert.match(body, new RegExp(`REVOKE ALL ON FUNCTION public\\.earn_mortgage_agent_compensation\\(uuid\\) FROM ${role};`));
  }
  assert.doesNotMatch(body, /CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE public|DELETE FROM|CREATE POLICY|DROP POLICY|^GRANT /m);
  // The earn revoke is guarded and re-grants the owner.
  assert.match(body, /RAISE EXCEPTION 'earn_owner_unsafe: earn_mortgage_agent_compensation \(owner %\) and tg_earn/);
  assert.match(body, /EXECUTE format\('GRANT EXECUTE ON FUNCTION public\.earn_mortgage_agent_compensation\(uuid\) TO %I', v_owner\);/);
  // Reconciliation keeps its query and gains the admin check.
  const recon = (sql) => sql.slice(sql.indexOf('  WITH completed AS ('), sql.indexOf('IS DISTINCT FROM p.amount_cents;') + 32)
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  assert.equal(recon(SQL86), recon(SQL47));
  assert.match(body, /AS \$\$\n#variable_conflict use_column\nBEGIN\n  IF NOT public\.aws_can_admin_mortgage_agent_compensation\(\) THEN\n    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';\n  END IF;\n\n  RETURN QUERY\n/);
  assert.match(body, /CREATE OR REPLACE FUNCTION public\.mortgage_agent_compensation_reconciliation\(\n  p_pay_period text DEFAULT NULL\n\)\nRETURNS TABLE \(\n  anomaly_type text,\n  mortgage_request_id uuid,\n  compensation_entry_id uuid,\n  tenant_billing_event_id uuid,\n  detail jsonb\n\)\nLANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER\nSET search_path = public\nSET row_security = off/);
  // Every SQL 47 caller of the helper is compensation administration.
  const callers = SQL47.split('\n').filter((line) => line.includes('aws_can_admin_mortgage_agent_compensation()')).length;
  assert.equal(callers, 11); // definition, 3 RPC checks, 6 SELECT policies, 1 GRANT
});

const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

const ROLES = `
CREATE ROLE checksops NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE outsider NOLOGIN;
`;

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL,
  UNIQUE (user_id, role));
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text, slug text);
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid, check_intake_item_id uuid, claim_id uuid,
  mortgage_company text, loan_number text, homeowner_name text, claim_number text,
  status text NOT NULL DEFAULT 'requested', assigned_employee_id uuid,
  accepted_at timestamptz, completed_at timestamptz, cancelled_at timestamptz, work_notes text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, check_intake_item_id uuid, claim_id uuid,
  mortgage_request_id uuid, event_type text NOT NULL, unit_price_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'recorded', created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role);
$$;
`;

// Stand-in for the live Accept-time accrual (tr_accrue_mortgage_ops_billing,
// idempotent per check). Runs only when work moves requested -> in_progress.
const ACCRUAL = `
CREATE OR REPLACE FUNCTION public.test_accrue_mortgage_ops_billing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'in_progress' AND NEW.accepted_at IS NOT NULL
     AND OLD.status IS DISTINCT FROM 'in_progress' THEN
    INSERT INTO public.check_billing_events
      (tenant_id, check_intake_item_id, claim_id, mortgage_request_id, event_type, unit_price_cents)
    VALUES (NEW.tenant_id, NEW.check_intake_item_id, NEW.claim_id, NEW.id,
      CASE WHEN EXISTS (SELECT 1 FROM public.check_billing_events b WHERE b.claim_id = NEW.claim_id
                          AND b.check_intake_item_id IS DISTINCT FROM NEW.check_intake_item_id)
           THEN 'mortgage_ops_additional_check' ELSE 'mortgage_ops_initial' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.check_billing_events b WHERE b.claim_id = NEW.claim_id
                          AND b.check_intake_item_id IS DISTINCT FROM NEW.check_intake_item_id)
           THEN 500 ELSE 1000 END)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tr_test_accrue AFTER UPDATE OF status, accepted_at ON public.mortgage_handling_requests
  FOR EACH ROW EXECUTE FUNCTION public.test_accrue_mortgage_ops_billing();
`;

const SEED = `
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${OWNER}', 'checksopsadmin@gmail.com', 'active'),
  ('${GLOBAL_ADMIN}', 'ops-admin@example.com', 'active'),
  ('${TENANT_ADMIN}', 'tenant-admin@example.com', 'active'),
  ('${AGENT_A}', 'agent-a@example.com', 'active'),
  ('${AGENT_B}', 'agent-b@example.com', 'active');
INSERT INTO public.profiles (id, email, full_name) VALUES
  ('${OWNER}', 'checksopsadmin@gmail.com', 'Owner'),
  ('${GLOBAL_ADMIN}', 'ops-admin@example.com', 'Global Admin'),
  ('${TENANT_ADMIN}', 'tenant-admin@example.com', 'Tenant Admin'),
  ('${AGENT_A}', 'agent-a@example.com', 'Agent A'),
  ('${AGENT_B}', 'agent-b@example.com', 'Agent B');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${GLOBAL_ADMIN}', 'admin'),
  ('${GLOBAL_ADMIN}', 'staff'),
  ('${AGENT_A}', 'mortgage_agent'),
  ('${AGENT_B}', 'mortgage_agent');
INSERT INTO public.tenants (id, name, slug) VALUES ('${TENANT_A}', 'Acme', 'acme'), ('${TENANT_B}', 'Other', 'other');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${TENANT_ADMIN}', 'owner'), ('${TENANT_B}', '${TENANT_ADMIN}', 'admin');
INSERT INTO public.mortgage_handling_requests
  (id, tenant_id, check_intake_item_id, claim_id, mortgage_company, loan_number, homeowner_name, status)
VALUES
  ('${REQ1}', '${TENANT_A}', '${CHECK1}', '${CLAIM}', 'Lender', 'LOAN-1', 'Pat Doe', 'requested'),
  ('${REQ_QUEUED}', '${TENANT_A}', NULL, '${CLAIM}', 'Lender', 'LOAN-Q', 'Pat Doe', 'requested'),
  ('${REQ3}', '${TENANT_A}', '${CHECK3}', '${CLAIM}', 'Lender', 'LOAN-3', 'Pat Doe', 'requested'),
  ('${REQ_EXCLUDED}', '${TENANT_A}', '${CHECK_X}', '${CLAIM}', 'Lender', 'LOAN-X', 'Pat Doe', 'requested'),
  ('${REQ_FOREIGN}', '${TENANT_B}', NULL, NULL, 'Lender', 'LOAN-F', 'Lee Roe', 'requested'),
  ('${SQL47_EXCLUDED}', '${TENANT_A}', NULL, '${CLAIM}', 'PROD E2E TEST LENDER', 'SKIP', 'Pat Doe', 'requested');
INSERT INTO public.mortgage_agent_compensation_exclusions (mortgage_request_id, reason)
VALUES ('${REQ_EXCLUDED}', 'test exclusion');
`;

test('SQL 84/85 run on PostgreSQL 16: platform owner only, accepted_at and billing kept, parent never rewritten', { timeout: 180000 }, (t) => {
  const skip = pgSkipReason();
  if (skip) { t.skip(skip); return; }
  const pg = startPg('pg-mortgage-return-adjust-', 57300);
  const conn = ['-h', pg.host, '-p', String(pg.port), '-U', 'ubuntu', '-v', 'ON_ERROR_STOP=1', '-X', '-q'];
  const base = [...conn, '-d', 'postgres'];
  const psql = (sql) => {
    const result = run(path.join(PG_BIN, 'psql'), [...base, '-A', '-t'], { input: sql });
    if (result.status !== 0) throw new Error(`psql failed (${result.status}): ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  // Another database, one transaction per call (as the guarded executor runs a file).
  const inDb = (db, sql) => run(path.join(PG_BIN, 'psql'), [...conn, '-d', db, '-A', '-t', '--single-transaction'], { input: sql });
  const okDb = (db, sql) => {
    const result = inDb(db, sql);
    if (result.status !== 0) throw new Error(`psql ${db} failed (${result.status}): ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const ident = (user) => (user
    ? `SELECT set_config('request.app_user_id', '${user}', false) \\g /dev/null\n`
    : '');
  // Calls as the API does: application identity in request.app_user_id, then
  // the role the API runs SQL as.
  const as = (user, sql, role = 'authenticated') => psql(`${ident(user)}SET ROLE ${role};\n${sql}`);
  const fails = (user, sql, pattern, role = 'authenticated') => {
    const result = run(path.join(PG_BIN, 'psql'), [...base, '-A', '-t'], { input: `${ident(user)}SET ROLE ${role};\n${sql}` });
    assert.notEqual(result.status, 0, `expected failure: ${sql}`);
    assert.match(result.stderr, pattern, sql);
    return result.stderr;
  };
  const returnSql = (id, reason = 'Agent unavailable') => `SELECT status FROM public.return_mortgage_handling_request_to_queue('${id}', ${reason === null ? 'NULL' : `'${reason}'`});`;
  const adjustSql = (parent, cents, reason, counterparty = null, period = null, key = null) => `SELECT public.adjust_mortgage_agent_compensation('${parent}', ${cents}, ${reason === null ? 'NULL' : `'${reason}'`}, ${counterparty ? `'${counterparty}'` : 'NULL'}, ${period ? `'${period}'` : 'NULL'}${key === null ? '' : `, '${key}'`})::text;`;
  const accept = (id, agent) => psql(`UPDATE public.mortgage_handling_requests
     SET assigned_employee_id = '${agent}', status = 'in_progress', accepted_at = COALESCE(accepted_at, now()), updated_at = now()
   WHERE id = '${id}' AND assigned_employee_id IS NULL AND status = 'requested';`);
  const complete = (id) => psql(`UPDATE public.mortgage_handling_requests SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = '${id}';`);
  const row = (table, id) => psql(`SELECT md5(to_jsonb(t)::text) FROM public.${table} t WHERE id = '${id}';`);
  const tableHash = (table) => psql(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t::text), '')) FROM public.${table} t;`);
  const reqState = (id) => psql(`SELECT concat_ws('|', status, coalesce(assigned_employee_id::text, '-'), coalesce(accepted_at::text, '-'), coalesce(completed_at::text, '-')) FROM public.mortgage_handling_requests WHERE id = '${id}';`);
  const fnDefs = () => psql(`SELECT md5(string_agg(pg_get_functiondef(p.oid), '' ORDER BY p.proname))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('return_mortgage_handling_request_to_queue', 'adjust_mortgage_agent_compensation');`);

  try {
    psql(ROLES);

    // Missing SQL 47: every file refuses with a clear error and keeps nothing.
    psql('CREATE DATABASE bare;');
    okDb('bare', SCHEMA + AUTH_UID + OWNER_HELPERS);
    for (const [name, sql, missing] of [
      ['84', SQL84, /SQL 84 needs SQL 47 .*missing public\.mortgage_agent_compensation_audit, public\.mortgage_agent_compensation_entries, public\.mortgage_agent_compensation_exclusions/],
      ['85', SQL85, /SQL 85 needs SQL 47 .*missing public\.aws_is_active_mortgage_agent\(uuid\), public\.mortgage_agent_compensation_audit/],
      ['86', SQL86, /SQL 86 needs SQL 47 .*missing public\.aws_can_admin_mortgage_agent_compensation\(\), public\.earn_mortgage_agent_compensation\(uuid\)/],
    ]) {
      const result = inDb('bare', sql);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /sql47_prerequisite_missing/, name);
      assert.match(result.stderr, missing, name);
    }
    assert.equal(okDb('bare', `SELECT count(*) FROM pg_class WHERE relname IN ('mortgage_ops_request_audit', 'check_billing_events_one_mortgage_ops_per_check');`), '0');

    // GATE 0: duplicates refuse with the check ids; ILIKE look-alikes do not
    // count; the exact staging index does.
    psql('CREATE DATABASE dupes;');
    okDb('dupes', SCHEMA + AUTH_UID + OWNER_HELPERS + SQL47);
    okDb('dupes', `INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents, status) VALUES
      ('${TENANT_A}', '${CHECK1}', 'mortgage_ops_initial', 1000, 'recorded'),
      ('${TENANT_A}', '${CHECK1}', 'mortgage_ops_additional_check', 500, 'recorded'),
      ('${TENANT_A}', '${CHECK3}', 'mortgage_ops_initial', 1000, 'recorded'),
      ('${TENANT_A}', '${CHECK3}', 'mortgage_ops_initial', 1000, 'voided');
    CREATE UNIQUE INDEX decoy_mortgage_ops_check_claim ON public.check_billing_events (check_intake_item_id, claim_id)
      WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check');`);
    const dup = inDb('dupes', SQL84);
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, new RegExp(`duplicate_mortgage_ops_billing_events: .*${CHECK1} \\(2\\)`));
    assert.doesNotMatch(dup.stderr, new RegExp(CHECK3));
    assert.equal(okDb('dupes', `SELECT count(*) FROM pg_class WHERE relname IN ('mortgage_ops_request_audit', 'check_billing_events_one_mortgage_ops_per_check');`), '0');
    okDb('dupes', `UPDATE public.check_billing_events SET status = 'voided' WHERE event_type = 'mortgage_ops_additional_check';`);
    okDb('dupes', SQL84);
    assert.equal(okDb('dupes', `SELECT count(*) FROM pg_class WHERE relname = 'check_billing_events_one_mortgage_ops_per_check';`), '1');
    okDb('dupes', `DROP INDEX public.check_billing_events_one_mortgage_ops_per_check;
      DELETE FROM public.check_billing_events WHERE status = 'voided';
      CREATE UNIQUE INDEX check_billing_events_mortgage_ops_check_uidx ON public.check_billing_events (check_intake_item_id)
        WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check') AND check_intake_item_id IS NOT NULL;`);
    okDb('dupes', SQL84);
    assert.equal(okDb('dupes', `SELECT count(*) FROM pg_class WHERE relname = 'check_billing_events_one_mortgage_ops_per_check';`), '0');
    // The staging name alone does not count: a different predicate gets the fallback.
    okDb('dupes', `DROP INDEX public.check_billing_events_mortgage_ops_check_uidx;
      CREATE UNIQUE INDEX check_billing_events_mortgage_ops_check_uidx ON public.check_billing_events (check_intake_item_id)
        WHERE event_type = 'mortgage_ops_initial';`);
    okDb('dupes', SQL84);
    assert.equal(okDb('dupes', `SELECT count(*) FROM pg_class WHERE relname = 'check_billing_events_one_mortgage_ops_per_check';`), '1');
    // An invalid index holding the fallback name is refused, not skipped.
    okDb('dupes', `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'public.check_billing_events_one_mortgage_ops_per_check'::regclass;`);
    const invalid = inDb('dupes', SQL84);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /mortgage_ops_per_check_unique_missing/);

    // SQL 86 refuses when the earn revoke could break the completion trigger.
    psql(`CREATE ROLE migrator NOLOGIN BYPASSRLS; CREATE ROLE api_member NOLOGIN IN ROLE checksops;`);
    const earnOwner = (db) => okDb(db, `SELECT p.proname || ':' || pg_get_userbyid(p.proowner) FROM pg_proc p
      WHERE p.proname IN ('earn_mortgage_agent_compensation', 'tg_earn_mortgage_agent_compensation') ORDER BY 1;`);
    for (const [label, sql, pattern] of [
      ['owner checksops', `ALTER FUNCTION public.earn_mortgage_agent_compensation(uuid) OWNER TO checksops;
        ALTER FUNCTION public.tg_earn_mortgage_agent_compensation() OWNER TO checksops;`, /earn_owner_unsafe: .*owner checksops is or belongs/],
      ['owner in checksops', `ALTER FUNCTION public.earn_mortgage_agent_compensation(uuid) OWNER TO api_member;
        ALTER FUNCTION public.tg_earn_mortgage_agent_compensation() OWNER TO api_member;`, /earn_owner_unsafe: .*owner api_member is or belongs/],
      ['different owners', `ALTER FUNCTION public.earn_mortgage_agent_compensation(uuid) OWNER TO migrator;
        ALTER FUNCTION public.tg_earn_mortgage_agent_compensation() OWNER TO ubuntu;`, /earn_owner_unsafe: .*\(owner migrator\) and tg_earn_mortgage_agent_compensation \(owner ubuntu\) must have the same owner/],
    ]) {
      okDb('dupes', sql);
      const before = okDb('dupes', `SELECT md5(pg_get_functiondef('public.aws_can_admin_mortgage_agent_compensation()'::regprocedure)) || has_function_privilege('authenticated', 'public.earn_mortgage_agent_compensation(uuid)', 'EXECUTE');`);
      const refused = inDb('dupes', SQL86);
      assert.notEqual(refused.status, 0, label);
      assert.match(refused.stderr, pattern, label);
      assert.equal(okDb('dupes', `SELECT md5(pg_get_functiondef('public.aws_can_admin_mortgage_agent_compensation()'::regprocedure)) || has_function_privilege('authenticated', 'public.earn_mortgage_agent_compensation(uuid)', 'EXECUTE');`), before, label);
    }
    assert.equal(earnOwner('dupes'), 'earn_mortgage_agent_compensation:migrator\ntg_earn_mortgage_agent_compensation:ubuntu');

    psql(SCHEMA);
    psql(AUTH_UID);
    psql(OWNER_HELPERS);
    psql(SQL47);
    psql(SEED);
    psql(ACCRUAL);
    // A SQL 49-shaped five-argument body that grants a global admin; SQL 85 drops it.
    psql(`CREATE FUNCTION public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid DEFAULT NULL, text DEFAULT NULL)
      RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{"legacy": true}'::jsonb $$;
      GRANT EXECUTE ON FUNCTION public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text) TO authenticated;`);
    psql(SQL84);
    psql(SQL85);
    assert.equal(psql(`SELECT string_agg(pg_get_function_identity_arguments(p.oid), ';') FROM pg_proc p
      WHERE p.proname = 'adjust_mortgage_agent_compensation';`),
      'p_parent_entry_id uuid, p_amount_cents integer, p_reason text, p_counterparty_agent_id uuid, p_pay_period text, p_idempotency_key text');
    const defs = fnDefs();
    // Idempotent: both files apply again cleanly and leave the same bodies.
    psql(SQL84);
    psql(SQL85);
    assert.equal(fnDefs(), defs);
    assert.equal(psql(`SELECT count(*) FROM pg_indexes WHERE indexname = 'check_billing_events_one_mortgage_ops_per_check'`), '1');

    // The predicate: only the owner mailbox identity is the platform owner.
    assert.equal(as(OWNER, 'SELECT public.is_platform_owner();'), 't');
    for (const user of [GLOBAL_ADMIN, TENANT_ADMIN, AGENT_A]) {
      assert.equal(as(user, 'SELECT public.is_platform_owner();'), 'f');
    }

    // Grants: PUBLIC has no EXECUTE; the API roles do; no table write grants.
    for (const fn of [
      'public.return_mortgage_handling_request_to_queue(uuid, text)',
      'public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text, text)',
    ]) {
      assert.equal(psql(`SELECT has_function_privilege('outsider', '${fn}', 'EXECUTE');`), 'f', fn);
      assert.equal(psql(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE');`), 't', fn);
      assert.equal(psql(`SELECT has_function_privilege('checksops', '${fn}', 'EXECUTE');`), 't', fn);
      fails(null, `SELECT ${fn.replace(/\(.*/, '')}(NULL::uuid, NULL${fn.includes('adjust') ? '::integer, NULL' : ''});`, /permission denied for function/, 'outsider');
    }
    assert.equal(psql(`SELECT count(*) FROM information_schema.role_table_grants
      WHERE grantee IN ('authenticated', 'checksops', 'PUBLIC')
        AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
        AND table_name IN ('mortgage_handling_requests', 'check_billing_events', 'mortgage_ops_request_audit',
          'mortgage_agent_compensation_entries', 'mortgage_agent_compensation_batches',
          'mortgage_agent_compensation_audit', 'mortgage_agent_compensation_exclusions',
          'mortgage_agent_compensation_rates');`), '0');

    // Agent A accepts REQ1: exactly one tenant billing event.
    accept(REQ1, AGENT_A);
    const before = reqState(REQ1);
    const acceptedAt = psql(`SELECT accepted_at FROM public.mortgage_handling_requests WHERE id = '${REQ1}';`);
    const billingId = psql(`SELECT id FROM public.check_billing_events WHERE check_intake_item_id = '${CHECK1}';`);
    assert.match(billingId, /^[0-9a-f-]{36}$/);
    const billingRow = row('check_billing_events', billingId);
    const ratesHash = tableHash('mortgage_agent_compensation_rates');

    // Return to Queue: everyone but the platform owner is refused, in SQL.
    for (const user of [GLOBAL_ADMIN, TENANT_ADMIN, AGENT_A, AGENT_B, null]) {
      fails(user, returnSql(REQ1), /not_authorized/);
      fails(user, returnSql(REQ1), /not_authorized/, 'checksops');
    }
    fails(TENANT_ADMIN, returnSql(REQ_FOREIGN), /not_authorized/);
    assert.equal(reqState(REQ1), before);
    assert.equal(psql('SELECT count(*) FROM public.mortgage_ops_request_audit;'), '0');

    // Reason required.
    fails(OWNER, returnSql(REQ1, '   '), /invalid_reason/);
    fails(OWNER, returnSql(REQ1, null), /invalid_reason/);
    assert.equal(reqState(REQ1), before);

    // Only in_progress, assigned, uncompleted work can be returned.
    fails(OWNER, returnSql(REQ_QUEUED), /request_not_returnable/);
    fails(OWNER, returnSql(MISSING), /request_not_found/);

    // Exclusions come from the table: SQL 47's seeded row and a new one.
    psql(`UPDATE public.mortgage_handling_requests SET assigned_employee_id = '${AGENT_A}', status = 'in_progress', accepted_at = now()
      WHERE id IN ('${SQL47_EXCLUDED}', '${REQ_EXCLUDED}');`);
    fails(OWNER, returnSql(SQL47_EXCLUDED), /request_excluded/);
    fails(OWNER, returnSql(REQ_EXCLUDED), /request_excluded/);
    assert.match(reqState(SQL47_EXCLUDED), new RegExp(`^in_progress\\|${AGENT_A}\\|`));

    // The platform owner returns REQ1: requested, unassigned, accepted_at and
    // the billing event unchanged, audit rows written.
    assert.equal(as(OWNER, returnSql(REQ1, 'Agent A unavailable')), 'requested');
    assert.equal(reqState(REQ1), `requested|-|${acceptedAt}|-`);
    assert.equal(row('check_billing_events', billingId), billingRow);
    assert.equal(psql(`SELECT count(*) FROM public.check_billing_events WHERE check_intake_item_id = '${CHECK1}';`), '1');
    assert.equal(psql(`SELECT concat_ws('|', action, actor_id, previous_agent_id, reason, from_status, to_status, accepted_at_preserved = '${acceptedAt}'::timestamptz, tenant_billing_event_id)
      FROM public.mortgage_ops_request_audit WHERE mortgage_request_id = '${REQ1}';`),
      `return_to_queue|${OWNER}|${AGENT_A}|Agent A unavailable|in_progress|requested|t|${billingId}`);
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_audit WHERE action = 'return_to_queue' AND actor_id = '${OWNER}';`), '1');
    // A second return of the same (now queued) request is refused.
    fails(OWNER, returnSql(REQ1), /request_not_returnable/);

    // The audit trail is platform-owner only to read, across every tenant.
    assert.equal(as(OWNER, 'SELECT count(*) FROM public.mortgage_ops_request_audit;'), '1');
    for (const user of [GLOBAL_ADMIN, TENANT_ADMIN, AGENT_A, null]) {
      assert.equal(as(user, 'SELECT count(*) FROM public.mortgage_ops_request_audit;'), '0');
    }

    // Agent B accepts normally: still one billing event, accepted_at kept.
    accept(REQ1, AGENT_B);
    assert.equal(reqState(REQ1), `in_progress|${AGENT_B}|${acceptedAt}|-`);
    assert.equal(psql(`SELECT count(*) FROM public.check_billing_events WHERE check_intake_item_id = '${CHECK1}';`), '1');
    assert.equal(row('check_billing_events', billingId), billingRow);

    // B completes: one root entry for B; A earns nothing; Return is refused.
    complete(REQ1);
    const parentId = psql(`SELECT id FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = '${REQ1}' AND parent_entry_id IS NULL;`);
    assert.match(parentId, /^[0-9a-f-]{36}$/);
    assert.equal(psql(`SELECT concat_ws('|', agent_user_id, amount_cents, status, tenant_billing_event_id) FROM public.mortgage_agent_compensation_entries WHERE id = '${parentId}';`),
      `${AGENT_B}|1000|earned|${billingId}`);
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE agent_user_id = '${AGENT_A}';`), '0');
    fails(OWNER, returnSql(REQ1), /request_not_returnable/);

    // Refusal when compensation already exists for still in_progress work.
    accept(REQ3, AGENT_A);
    psql(`INSERT INTO public.mortgage_agent_compensation_entries
      (agent_user_id, mortgage_request_id, check_intake_item_id, claim_id, tenant_id, classification, amount_cents, pay_period, status)
      VALUES ('${AGENT_A}', '${REQ3}', '${CHECK3}', '${CLAIM}', '${TENANT_A}', 'additional', 500, '2026-10', 'earned');`);
    const req3 = reqState(REQ3);
    fails(OWNER, returnSql(REQ3), /compensation_already_exists/);
    assert.equal(reqState(REQ3), req3);

    // Adjust: platform owner only.
    const parentRow = row('mortgage_agent_compensation_entries', parentId);
    const billingAll = tableHash('check_billing_events');
    for (const user of [GLOBAL_ADMIN, TENANT_ADMIN, AGENT_A, AGENT_B, null]) {
      fails(user, adjustSql(parentId, 250, 'bonus'), /not_authorized/);
      fails(user, adjustSql(parentId, 250, 'bonus'), /not_authorized/, 'checksops');
    }
    fails(OWNER, adjustSql(parentId, 250, '  '), /invalid_reason/);
    fails(OWNER, adjustSql(parentId, 250, null), /invalid_reason/);
    fails(OWNER, adjustSql(parentId, 0, 'zero'), /invalid_adjustment/);
    fails(OWNER, adjustSql(parentId, 250, 'bad month', null, '2026-13'), /invalid_pay_period/);
    fails(OWNER, adjustSql(MISSING, 250, 'missing'), /entry_not_found/);
    fails(OWNER, adjustSql(parentId, 250, 'not an agent', OWNER), /invalid_counterparty/);
    fails(OWNER, adjustSql(parentId, 250, 'same agent', AGENT_B), /invalid_counterparty/);
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id IS NOT NULL;`), '0');
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_batches WHERE action = 'adjust';`), '0');

    // Positive and negative single adjustments: new child rows only.
    const plus = JSON.parse(as(OWNER, adjustSql(parentId, 250, 'underpayment')));
    assert.equal(plus.paired, false);
    assert.equal(plus.debit.amount_cents, 250);
    assert.equal(plus.debit.parent_entry_id, parentId);
    assert.equal(plus.debit.agent_user_id, AGENT_B);
    assert.equal(plus.debit.status, 'earned');
    assert.equal(plus.debit.adjustment_reason, 'underpayment');
    as(OWNER, adjustSql(parentId, -100, 'overpayment', null, '2026-11'));
    assert.equal(psql(`SELECT string_agg(amount_cents::text || ':' || pay_period, ',' ORDER BY amount_cents) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id = '${parentId}';`),
      `-100:2026-11,250:${plus.pay_period}`);
    assert.equal(row('mortgage_agent_compensation_entries', parentId), parentRow);

    // Children cannot be adjusted (root only).
    fails(OWNER, adjustSql(plus.debit.id, 50, 'child'), /parent_must_be_root/);

    // Paid parent, then a wrong-agent pair: -B and +A in one transaction.
    as(OWNER, `SELECT public.mark_mortgage_agent_compensation_paid(ARRAY['${parentId}']::uuid[], CURRENT_DATE, 'CHK-1', 'bookkeeping');`);
    const paidRow = row('mortgage_agent_compensation_entries', parentId);
    const pair = JSON.parse(as(OWNER, adjustSql(parentId, 1000, 'wrong agent', AGENT_A)));
    assert.equal(pair.paired, true);
    assert.equal(pair.debit.agent_user_id, AGENT_B);
    assert.equal(pair.debit.amount_cents, -1000);
    assert.equal(pair.credit.agent_user_id, AGENT_A);
    assert.equal(pair.credit.amount_cents, 1000);
    assert.equal(pair.parent_status, 'paid');
    assert.equal(row('mortgage_agent_compensation_entries', parentId), paidRow);
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id = '${parentId}';`), '4');
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id IS NOT NULL AND (status <> 'earned' OR paid_at IS NOT NULL OR approved_at IS NOT NULL OR payment_reference IS NOT NULL);`), '0');
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_batches WHERE action = 'adjust' AND created_by = '${OWNER}';`), '3');
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_audit WHERE action = 'adjust' AND actor_id = '${OWNER}';`), '7');

    // Children carry no payment batch; the adjust batch links via the audit rows.
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id IS NOT NULL AND payment_batch_id IS NOT NULL;`), '0');
    assert.equal(psql(`SELECT count(DISTINCT a.batch_id) FROM public.mortgage_agent_compensation_audit a
      JOIN public.mortgage_agent_compensation_batches b ON b.id = a.batch_id AND b.action = 'adjust'
      WHERE a.action = 'adjust' AND a.entry_id IN (SELECT id FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id = '${parentId}');`), '3');
    assert.equal(pair.debit.payment_batch_id, null);
    assert.match(pair.batch_id, /^[0-9a-f-]{36}$/);

    // Caps: |amount| <= parent amount (1000); a debit to B <= B's net on the file.
    // B's net is now 1000 + 250 - 100 - 1000 = 150.
    const childCount = () => psql(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id = '${parentId}';`);
    fails(OWNER, adjustSql(parentId, 1001, 'too much'), /adjustment_exceeds_parent/);
    fails(OWNER, adjustSql(parentId, -1001, 'too much'), /adjustment_exceeds_parent/);
    fails(OWNER, adjustSql(parentId, 1001, 'too much', AGENT_A), /adjustment_exceeds_parent/);
    fails(OWNER, adjustSql(parentId, 151, 'pair over net', AGENT_A), /adjustment_exceeds_net/);
    fails(OWNER, adjustSql(parentId, -151, 'debit over net'), /adjustment_exceeds_net/);
    fails(OWNER, adjustSql(parentId, 2147483647, 'huge'), /adjustment_exceeds_parent/);
    fails(OWNER, adjustSql(parentId, -2147483648, 'huge'), /adjustment_exceeds_parent/);
    // INT_MIN with a counterparty: abs() is taken in bigint, so a clean 22023.
    assert.match(fails(OWNER, adjustSql(parentId, -2147483648, 'huge pair', AGENT_A), /adjustment_exceeds_parent/), /ERROR:  adjustment_exceeds_parent/);
    assert.equal(childCount(), '4');
    // A positive single adjustment is bounded only by the parent amount.
    as(OWNER, adjustSql(parentId, 1000, 'catch-up'));
    assert.equal(childCount(), '5');
    // B's net is 1150: a 1000 pair now fits.

    // The counterparty must be an active Mortgage Agent.
    as(OWNER, `SELECT public.set_mortgage_agent_account_status('${AGENT_A}', 'inactive', 'test');`);
    fails(OWNER, adjustSql(parentId, 100, 'inactive agent', AGENT_A), /invalid_counterparty/);
    as(OWNER, `SELECT public.set_mortgage_agent_account_status('${AGENT_A}', 'active', NULL);`);

    // Idempotency: a repeat returns the first result and writes nothing.
    const first = JSON.parse(as(OWNER, adjustSql(parentId, 100, 'move', AGENT_A, null, 'dialog-key-1')));
    assert.equal(first.idempotent_replay, false);
    const snapshot = [childCount(), tableHash('mortgage_agent_compensation_batches'), tableHash('mortgage_agent_compensation_audit')];
    const again = JSON.parse(as(OWNER, adjustSql(parentId, 100, 'move', AGENT_A, null, 'dialog-key-1')));
    assert.equal(again.idempotent_replay, true);
    assert.equal(again.batch_id, first.batch_id);
    assert.equal(again.debit.id, first.debit.id);
    assert.equal(again.credit.id, first.credit.id);
    assert.deepEqual([childCount(), tableHash('mortgage_agent_compensation_batches'), tableHash('mortgage_agent_compensation_audit')], snapshot);
    const req3Root = psql(`SELECT id FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = '${REQ3}' AND parent_entry_id IS NULL;`);
    for (const [cents, reason, counterparty, parent, period = null] of [
      [200, 'move', AGENT_A, parentId],
      [100, 'other reason', AGENT_A, parentId],
      [100, 'move', null, parentId],
      [100, 'move', AGENT_A, parentId, '1999-01'],
      [100, 'move', AGENT_A, req3Root],
    ]) {
      fails(OWNER, adjustSql(parent, cents, reason, counterparty, period, 'dialog-key-1'), /idempotency_key_conflict/);
    }
    // The key is checked only after authorization.
    fails(GLOBAL_ADMIN, adjustSql(parentId, 100, 'move', AGENT_A, null, 'dialog-key-1'), /not_authorized/);
    fails(OWNER, adjustSql(parentId, 100, 'long key', null, null, 'k'.repeat(201)), /invalid_idempotency_key/);
    assert.deepEqual([childCount(), tableHash('mortgage_agent_compensation_batches')], snapshot.slice(0, 2));
    // A blank key means no key; a new key is a new adjustment.
    as(OWNER, adjustSql(parentId, 10, 'blank key', null, null, '  '));
    as(OWNER, adjustSql(parentId, 10, 'second key', null, null, 'dialog-key-2'));
    assert.equal(childCount(), String(Number(snapshot[0]) + 2));
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_batches WHERE action = 'adjust' AND idempotency_key IS NOT NULL;`), '2');

    // SQL 47's approve and mark_paid handle children by id and attribute
    // their own batches (payment_batch_id was NULL).
    const childId = first.debit.id;
    assert.equal(as(OWNER, `SELECT public.approve_mortgage_agent_compensation(ARRAY['${childId}']::uuid[], 'ok');`), '1');
    assert.equal(psql(`SELECT b.action FROM public.mortgage_agent_compensation_entries e JOIN public.mortgage_agent_compensation_batches b ON b.id = e.payment_batch_id WHERE e.id = '${childId}';`), 'approve');
    assert.equal(as(OWNER, `SELECT public.mark_mortgage_agent_compensation_paid(ARRAY['${childId}']::uuid[], CURRENT_DATE, 'CHK-2', NULL);`), '1');
    assert.equal(psql(`SELECT e.status || ':' || b.action FROM public.mortgage_agent_compensation_entries e JOIN public.mortgage_agent_compensation_batches b ON b.id = e.payment_batch_id WHERE e.id = '${childId}';`), 'paid:pay');
    assert.equal(row('mortgage_agent_compensation_entries', parentId), paidRow);

    // The SQL 47 fact trigger still refuses a direct parent rewrite.
    fails(null, `UPDATE public.mortgage_agent_compensation_entries SET amount_cents = 1 WHERE id = '${parentId}';`, /compensation_facts_immutable/, 'ubuntu');

    // Money rules: no billing writes, no rate change, no extra root entries.
    assert.equal(tableHash('check_billing_events'), billingAll);
    assert.equal(tableHash('mortgage_agent_compensation_rates'), ratesHash);
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id IS NULL;`), '2');

    // SQL 86. Before it, SQL 47's helper lets a global admin in.
    assert.equal(as(GLOBAL_ADMIN, 'SELECT public.aws_can_admin_mortgage_agent_compensation();'), 't');
    assert.notEqual(as(GLOBAL_ADMIN, 'SELECT count(*) FROM public.mortgage_agent_compensation_entries;'), '0');
    assert.equal(psql(`SELECT has_function_privilege('authenticated', 'public.earn_mortgage_agent_compensation(uuid)', 'EXECUTE');`), 't');
    // A non-superuser owner for earn and its trigger (as a migration role would be).
    psql(`GRANT USAGE ON SCHEMA public, auth TO migrator;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO migrator;
      ALTER FUNCTION public.earn_mortgage_agent_compensation(uuid) OWNER TO migrator;
      ALTER FUNCTION public.tg_earn_mortgage_agent_compensation() OWNER TO migrator;`);
    const reconHash = (user) => as(user, `SELECT count(*) || ':' || md5(coalesce(string_agg(t::text, ';' ORDER BY t::text), '')) FROM public.mortgage_agent_compensation_reconciliation(NULL) t;`);
    // A completed request with no compensation (inserted, so no trigger ran) is an anomaly.
    psql(`INSERT INTO public.mortgage_handling_requests (id, tenant_id, status, assigned_employee_id, accepted_at, completed_at)
      VALUES ('00000000-0000-4000-8000-000000000026', '${TENANT_B}', 'completed', '${AGENT_B}', now(), now());`);
    const reconBefore = reconHash(OWNER);
    assert.notEqual(reconBefore.split(':')[0], '0');
    assert.equal(reconHash(GLOBAL_ADMIN), reconBefore); // SQL 47: no caller check at all
    psql(SQL86);
    psql(SQL86);
    assert.equal(psql(`SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.earn_mortgage_agent_compensation(uuid)'::regprocedure;`), 'migrator');
    assert.equal(psql(`SELECT has_function_privilege('migrator', 'public.earn_mortgage_agent_compensation(uuid)', 'EXECUTE');`), 't');
    assert.match(psql(`SELECT array_to_string(proacl, ',') FROM pg_proc WHERE oid = 'public.earn_mortgage_agent_compensation(uuid)'::regprocedure;`), /^migrator=X\/migrator$/);
    // Reconciliation: same rows for the owner, refused for everyone else.
    assert.equal(reconHash(OWNER), reconBefore);
    assert.equal(as(OWNER, `SELECT count(*) FROM public.mortgage_agent_compensation_reconciliation('1999-01');`), '0');
    for (const user of [GLOBAL_ADMIN, TENANT_ADMIN, AGENT_A, null]) {
      fails(user, 'SELECT * FROM public.mortgage_agent_compensation_reconciliation(NULL);', /not_authorized/);
      fails(user, 'SELECT * FROM public.mortgage_agent_compensation_reconciliation(NULL);', /not_authorized/, 'checksops');
    }
    const helper = psql(`SELECT concat_ws('|', provolatile, prosecdef, prorettype::regtype, array_to_string(proconfig, ','))
      FROM pg_proc WHERE oid = 'public.aws_can_admin_mortgage_agent_compensation()'::regprocedure;`);
    assert.equal(helper, 's|t|boolean|search_path=public,row_security=off');
    for (const user of [GLOBAL_ADMIN, TENANT_ADMIN, AGENT_A, null]) {
      assert.equal(as(user, 'SELECT public.aws_can_admin_mortgage_agent_compensation();'), 'f');
      for (const table of ['mortgage_agent_accounts', 'mortgage_agent_compensation_rates', 'mortgage_agent_compensation_exclusions',
        'mortgage_agent_compensation_entries', 'mortgage_agent_compensation_batches', 'mortgage_agent_compensation_audit']) {
        assert.equal(as(user, `SELECT count(*) FROM public.${table};`), '0', `${user} ${table}`);
      }
      fails(user, `SELECT public.approve_mortgage_agent_compensation(ARRAY['${plus.debit.id}']::uuid[], NULL);`, /not_authorized/);
      fails(user, `SELECT public.mark_mortgage_agent_compensation_paid(ARRAY['${plus.debit.id}']::uuid[], CURRENT_DATE, NULL, NULL);`, /not_authorized/);
      fails(user, `SELECT public.set_mortgage_agent_account_status('${AGENT_A}', 'inactive', NULL);`, /not_authorized/);
    }
    assert.equal(as(OWNER, 'SELECT public.aws_can_admin_mortgage_agent_compensation();'), 't');
    for (const table of ['mortgage_agent_accounts', 'mortgage_agent_compensation_rates', 'mortgage_agent_compensation_exclusions',
      'mortgage_agent_compensation_entries', 'mortgage_agent_compensation_batches', 'mortgage_agent_compensation_audit']) {
      assert.notEqual(as(OWNER, `SELECT count(*) FROM public.${table};`), '0', table);
    }
    assert.equal(as(OWNER, `SELECT public.approve_mortgage_agent_compensation(ARRAY['${plus.debit.id}']::uuid[], NULL);`), '1');
    assert.equal(as(OWNER, `SELECT public.mark_mortgage_agent_compensation_paid(ARRAY['${plus.debit.id}']::uuid[], CURRENT_DATE, NULL, NULL);`), '1');
    assert.equal(as(OWNER, `SELECT (public.set_mortgage_agent_account_status('${AGENT_B}', 'active', NULL)).status;`), 'active');

    // earn: no app role can call it directly; Complete still earns via the
    // trigger, which runs as the non-superuser owner migrator.
    for (const role of ['authenticated', 'checksops', 'outsider']) {
      assert.equal(psql(`SELECT has_function_privilege('${role}', 'public.earn_mortgage_agent_compensation(uuid)', 'EXECUTE');`), 'f', role);
      fails(OWNER, `SELECT public.earn_mortgage_agent_compensation('${REQ1}');`, /permission denied for function earn_mortgage_agent_compensation/, role);
    }
    accept(REQ_FOREIGN, AGENT_A);
    complete(REQ_FOREIGN);
    assert.equal(psql(`SELECT concat_ws('|', agent_user_id, status) FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = '${REQ_FOREIGN}' AND parent_entry_id IS NULL;`), `${AGENT_A}|earned`);
  } finally {
    pg.stop();
  }
});
