/**
 * SQL 84 (aws/workflows/sql/84_mortgage_return_to_queue.sql) and SQL 85
 * (aws/workflows/sql/85_mortgage_compensation_adjust.sql): Mortgage Ops Return
 * to Queue and compensation Adjust, platform owner only.
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
const SQL47 = read(SQL47_PATH);
const SQL84 = read(SQL84_PATH);
const SQL85 = read(SQL85_PATH);
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
    ['85', SQL85, 'adjust_mortgage_agent_compensation\\(uuid, integer, text, uuid, text\\)'],
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
});

const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

const SCHEMA = `
CREATE ROLE checksops NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE outsider NOLOGIN;
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
  const base = ['-h', pg.host, '-p', String(pg.port), '-U', 'ubuntu', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q'];
  const psql = (sql) => {
    const result = run(path.join(PG_BIN, 'psql'), [...base, '-A', '-t'], { input: sql });
    if (result.status !== 0) throw new Error(`psql failed (${result.status}): ${result.stderr || result.stdout}`);
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
  const adjustSql = (parent, cents, reason, counterparty = null, period = null) => `SELECT public.adjust_mortgage_agent_compensation('${parent}', ${cents}, ${reason === null ? 'NULL' : `'${reason}'`}, ${counterparty ? `'${counterparty}'` : 'NULL'}, ${period ? `'${period}'` : 'NULL'})::text;`;
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
    psql(SCHEMA);
    psql(AUTH_UID);
    psql(OWNER_HELPERS);
    psql(SQL47);
    psql(SEED);
    psql(ACCRUAL);
    psql(SQL84);
    psql(SQL85);
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
      'public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text)',
    ]) {
      assert.equal(psql(`SELECT has_function_privilege('outsider', '${fn}', 'EXECUTE');`), 'f', fn);
      assert.equal(psql(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE');`), 't', fn);
      assert.equal(psql(`SELECT has_function_privilege('checksops', '${fn}', 'EXECUTE');`), 't', fn);
      fails(null, `SELECT ${fn.replace(/\(.*/, '')}(NULL, NULL${fn.includes('adjust') ? ', NULL' : ''});`, /permission denied for function/, 'outsider');
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

    // The SQL 47 fact trigger still refuses a direct parent rewrite.
    fails(null, `UPDATE public.mortgage_agent_compensation_entries SET amount_cents = 1 WHERE id = '${parentId}';`, /compensation_facts_immutable/, 'ubuntu');

    // Money rules: no billing writes, no rate change, no extra root entries.
    assert.equal(tableHash('check_billing_events'), billingAll);
    assert.equal(tableHash('mortgage_agent_compensation_rates'), ratesHash);
    assert.equal(psql(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id IS NULL;`), '2');
  } finally {
    pg.stop();
  }
});
