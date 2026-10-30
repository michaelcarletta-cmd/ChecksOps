/**
 * SQL 123 against PostgreSQL 16: a check deposited through Check Alt moves to Deposited, and a
 * deposit that is later rejected or returned moves the check to Returned. Every object is owned by
 * a non-superuser checksops_admin LOGIN (production's admin login, which applies the file); the API
 * login checksops writes checkalt_deposits (as the submit, auto-approve and poll paths do) and holds
 * SELECT only on check_intake_items, so the check moves through the definer functions alone.
 *
 * The usage and cash-job triggers that react to the same deposit are the real ones: SQL 98's
 * record_check_billing_event (from its file), the SQL 120 and SQL 121 files, the Supabase
 * sync_cash_job_check_payment() and its trigger, and tg_set_deposited_metadata(). That proves the
 * owner's rules hold together: one usage event and one cash-job payment per check, removed again
 * when the deposit did not go through.
 *
 * Owner (2026-10-28): "proceed with database trigger that marks it deposited when check alt
 * submits. If it is later rejected it shows up in returned and not in deposited."
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { RELEASE_SQL_SPECS } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';

const REPO = path.join(AWS_ROOT, '..');
const SQL_98 = path.join(AWS_ROOT, 'workflows/sql/98_tenant_fee_collection.sql');
const SQL_120 = path.join(AWS_ROOT, 'workflows/sql/120_usage_events_at_approval_and_send.sql');
const SQL_121 = path.join(AWS_ROOT, 'workflows/sql/121_cash_jobs_production_grants.sql');
const SQL_123 = path.join(AWS_ROOT, 'workflows/sql/123_checkalt_deposit_check_status.sql');
const SUPABASE_CHECK_PAYMENT = path.join(REPO, 'supabase/migrations/20260522142101_6c46a740-87fc-48ab-afd4-07af285f1ae3.sql');
const SUPABASE_DEPOSITED_METADATA = path.join(REPO, 'supabase/migrations/20260527171651_357a79e6-8571-4ad1-a7e6-092ece413a8d.sql');

const T_A = '11111111-1111-4111-8111-111111111111'; // per-check billing on, 250
const USER = 'a1000000-0000-4000-8000-000000000001';
const JOB = 'b0000000-0000-4000-8000-000000000001';
const C_NEW = 'c0000000-0000-4000-8000-000000000001'; // insurance check: submitted, cleared, then rejected
const C_CASH = 'c0000000-0000-4000-8000-000000000002'; // cash-job check: approved, rejected, resubmitted
const C_TWO = 'c0000000-0000-4000-8000-000000000003'; // two deposits
const C_RET = 'c0000000-0000-4000-8000-000000000004'; // cleared, then returned by the bank
const C_LATE = 'c0000000-0000-4000-8000-000000000005'; // funds already released when approved
const C_BANK = 'c0000000-0000-4000-8000-000000000006'; // returned by hand before Check Alt
const C_STUCK = 'c0000000-0000-4000-8000-000000000007'; // backfill: approved after SQL 120, billed
const C_OLD = 'c0000000-0000-4000-8000-000000000008'; // backfill: approved in September, never billed
const C_GONE = 'c0000000-0000-4000-8000-000000000009'; // backfill: approved and billed, funds released since

const slice = (file, from, to) => {
  const text = fs.readFileSync(file, 'utf8');
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${path.basename(file)}: ${from}`);
  return text.slice(a, b);
};

// tg_set_deposited_metadata() and its trigger: the end of their migration (the columns are in SCHEMA).
const depositedMetadataSql = () => {
  const text = fs.readFileSync(SUPABASE_DEPOSITED_METADATA, 'utf8');
  const from = text.indexOf('CREATE OR REPLACE FUNCTION public.tg_set_deposited_metadata()');
  assert.ok(from > 0);
  return text.slice(from);
};

const SCHEMA = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
GRANT authenticated TO checksops;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
GRANT USAGE ON SCHEMA public TO checksops, authenticated;
SET ROLE checksops_admin;
CREATE TYPE public.check_stage AS ENUM ('review', 'loss_draft', 'endorsing', 'ready_for_deposit', 'deposited',
  'funds_released', 'disbursed_externally', 'returned');
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, per_check_billing_enabled boolean, per_check_rate_cents integer,
  next_day_rate_cents integer, same_day_rate_cents integer);
CREATE TABLE public.cash_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, title text,
  contract_amount numeric NOT NULL DEFAULT 0, total_paid numeric NOT NULL DEFAULT 0);
CREATE TABLE public.cash_job_line_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, cash_job_id uuid);
CREATE TABLE public.cash_job_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, cash_job_id uuid);
CREATE TABLE public.cash_job_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cash_job_id uuid NOT NULL REFERENCES public.cash_jobs(id),
  created_by uuid, amount numeric NOT NULL, payment_method text, payment_date date, reference_number text, notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id), status text NOT NULL DEFAULT 'approved_for_deposit',
  check_stage public.check_stage DEFAULT 'ready_for_deposit', claim_id uuid, amount numeric, uploaded_by uuid,
  deposited_at timestamptz, deposited_by_tenant_id uuid,
  pre_return_stage public.check_stage, returned_at timestamptz, return_code text, return_reason text, return_notes text,
  return_recorded_by uuid, return_source text, return_resolved_at timestamptz, return_resolution text,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid, tenant_id uuid, actor_id uuid, event_type text NOT NULL,
  event_description text, event_data jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.check_billing_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price_per_check_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  payment_transfer_id uuid, event_type text DEFAULT 'check_processing',
  unit_price_cents integer NOT NULL, currency text NOT NULL DEFAULT 'usd', status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded','reported','invoiced','failed','voided')),
  billed_at timestamptz NOT NULL DEFAULT now(), billing_period text, invoice_id uuid, source_kind text,
  source_id uuid, claim_id uuid, mortgage_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_billing_events_check_event_unique UNIQUE (check_intake_item_id, event_type));
ALTER TABLE public.check_billing_events ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid REFERENCES public.check_intake_items(id),
  tenant_id uuid, status text NOT NULL DEFAULT 'pending', return_reason text, submitted_at timestamptz,
  cleared_at timestamptz, returned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft',
  speed text NOT NULL DEFAULT 'standard', requested_speed text, leg_role text, check_id uuid, claim_id uuid,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT c.price_per_check_cents FROM public.check_billing_config c WHERE c.active = true ORDER BY c.created_at DESC LIMIT 1 $$;
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = public AS $$ SELECT true $$;
${fs.readFileSync(SUPABASE_CHECK_PAYMENT, 'utf8')};
${depositedMetadataSql()}
`;

test('SQL 123: Check Alt approval moves the check to Deposited; a later rejection or return to Returned (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql123-checkalt-', 56750);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
  const api = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
  const check = async (id) => (await superuser.query(
    `SELECT status, check_stage::text AS stage, deposited_at, pre_return_stage::text AS pre_return_stage, returned_at,
            return_code, return_reason, return_source, return_resolved_at, return_resolution
       FROM public.check_intake_items WHERE id = $1`, [id])).rows[0];
  const usage = async (id) => (await superuser.query(
    `SELECT status FROM public.check_billing_events WHERE check_intake_item_id = $1 AND event_type = 'check_processing'`, [id])).rows.map((r) => r.status);
  const payments = async (id) => (await superuser.query(
    'SELECT amount::text AS amount FROM public.cash_job_payments WHERE reference_number = $1', [id])).rows.map((r) => r.amount);
  const audits = async (id) => (await superuser.query(
    `SELECT event_type, event_data->>'return_code' AS code FROM public.check_audit_log WHERE check_id = $1 ORDER BY created_at`, [id])).rows;
  const deposit = async (id, status, extra = {}) => (await api.query(
    `INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status, submitted_at, return_reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [id, T_A, status, extra.submitted_at ?? null, extra.return_reason ?? null])).rows[0].id;
  const setDeposit = (id, status, extra = {}) => api.query(
    `UPDATE public.checkalt_deposits SET status = $2, return_reason = COALESCE($3, return_reason),
            returned_at = COALESCE($4::timestamptz, returned_at) WHERE id = $1`,
    [id, status, extra.return_reason ?? null, extra.returned_at ?? null]);
  try {
    await superuser.connect();
    await superuser.query(SCHEMA + `
SET ROLE checksops_admin;
${slice(SQL_98, 'CREATE OR REPLACE FUNCTION public.record_check_billing_event()', '-- 2) one charge per tenant period')}
INSERT INTO public.check_billing_config (price_per_check_cents) VALUES (300);
INSERT INTO public.tenants VALUES ('${T_A}', true, 250, NULL, NULL);
INSERT INTO public.cash_jobs (id, tenant_id, title, contract_amount) VALUES ('${JOB}', '${T_A}', 'Roof', 10000);
INSERT INTO public.check_intake_items (id, tenant_id, amount, uploaded_by, check_source, cash_job_id, cash_job_payment_class, check_stage, status) VALUES
  ('${C_NEW}', '${T_A}', 1000, '${USER}', 'insurance', NULL, NULL, 'ready_for_deposit', 'approved_for_deposit'),
  ('${C_CASH}', '${T_A}', 2500, '${USER}', 'cash_job', '${JOB}', 'progress_payment', 'ready_for_deposit', 'approved_for_deposit'),
  ('${C_TWO}', '${T_A}', 300, '${USER}', 'insurance', NULL, NULL, 'ready_for_deposit', 'approved_for_deposit'),
  ('${C_RET}', '${T_A}', 400, '${USER}', 'insurance', NULL, NULL, 'ready_for_deposit', 'approved_for_deposit'),
  ('${C_LATE}', '${T_A}', 500, '${USER}', 'insurance', NULL, NULL, 'funds_released', 'funds_released'),
  ('${C_BANK}', '${T_A}', 600, '${USER}', 'insurance', NULL, NULL, 'returned', 'returned'),
  ('${C_STUCK}', '${T_A}', 700, '${USER}', 'insurance', NULL, NULL, 'ready_for_deposit', 'approved_for_deposit'),
  ('${C_OLD}', '${T_A}', 800, '${USER}', 'insurance', NULL, NULL, 'ready_for_deposit', 'approved_for_deposit'),
  ('${C_GONE}', '${T_A}', 900, '${USER}', 'insurance', NULL, NULL, 'ready_for_deposit', 'approved_for_deposit');
UPDATE public.check_intake_items SET return_source = 'manual', returned_at = '2026-10-02T12:00:00Z' WHERE id = '${C_BANK}';
GRANT SELECT ON public.check_intake_items, public.check_billing_events, public.cash_job_payments TO checksops;
GRANT SELECT, INSERT, UPDATE ON public.checkalt_deposits, public.payment_transfers TO checksops;
-- Approved in September, before SQL 120 (whose backfill starts 2026-10-01): never billed.
INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status, submitted_at) VALUES
  ('${C_OLD}', '${T_A}', 'cleared', '2026-09-15T15:00:00Z');
RESET ROLE;
`);
    await owner.connect();
    await api.connect();
    await owner.query(fs.readFileSync(SQL_120, 'utf8'));
    await owner.query(fs.readFileSync(SQL_121, 'utf8'));

    // Before SQL 123 (production today): approval bills the check but the check stays in Ready for deposit.
    await deposit(C_STUCK, 'submitted', { submitted_at: '2026-10-20T15:00:00Z' });
    const gone = await deposit(C_GONE, 'cleared', { submitted_at: '2026-10-21T15:00:00Z' });
    assert.ok(gone);
    await superuser.query(`UPDATE public.check_intake_items SET check_stage = 'funds_released', status = 'funds_released' WHERE id = '${C_GONE}'`);
    assert.equal((await check(C_STUCK)).stage, 'ready_for_deposit');
    assert.deepEqual(await usage(C_STUCK), ['recorded']);
    assert.deepEqual(await usage(C_OLD), []);

    await owner.query(fs.readFileSync(SQL_123, 'utf8'));

    // 3) Backfill: the billed stuck check moves with its deposit time; the never-billed one and the one
    // already past deposit stay; no new usage event.
    let stuck = await check(C_STUCK);
    assert.deepEqual([stuck.status, stuck.stage], ['deposited', 'deposited']);
    assert.equal(stuck.deposited_at.toISOString(), '2026-10-20T15:00:00.000Z');
    assert.deepEqual(await usage(C_STUCK), ['recorded']);
    assert.equal((await check(C_OLD)).stage, 'ready_for_deposit');
    assert.deepEqual(await usage(C_OLD), []);
    assert.equal((await check(C_GONE)).stage, 'funds_released');
    const eventsAfterApply = (await superuser.query('SELECT count(*)::int AS n FROM public.check_billing_events')).rows[0].n;
    await owner.query(fs.readFileSync(SQL_123, 'utf8')); // idempotent: nothing moves again
    stuck = await check(C_STUCK);
    assert.equal(stuck.deposited_at.toISOString(), '2026-10-20T15:00:00.000Z');
    assert.equal((await superuser.query('SELECT count(*)::int AS n FROM public.check_billing_events')).rows[0].n, eventsAfterApply);

    // Fires first: among checkalt_deposits' AFTER triggers, SQL 123's sorts before SQL 120's and SQL 121's.
    const order = (await superuser.query(`SELECT tgname FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'public.checkalt_deposits'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows.map((r) => r.tgname);
    assert.deepEqual(order, ['aws_checkalt_deposit_apply_check_status', 'aws_checkalt_deposit_billing_event', 'aws_checkalt_deposit_cash_job_payment']);
    await superuser.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', false)");
    const def = (await superuser.query(`SELECT pg_catalog.pg_get_triggerdef(t.oid) AS def FROM pg_catalog.pg_trigger t
      WHERE t.tgname = 'aws_checkalt_deposit_apply_check_status'`)).rows[0].def;
    assert.equal(def, RELEASE_SQL_SPECS.sql123.triggers[0].def);
    await superuser.query("SELECT pg_catalog.set_config('search_path', 'public', false)");

    // a) pending and pending approval leave the check where it is; submitted moves it to Deposited once,
    // with one usage event; cleared changes nothing more.
    const dNew = await deposit(C_NEW, 'pending');
    await setDeposit(dNew, 'pending_approval');
    assert.equal((await check(C_NEW)).stage, 'ready_for_deposit');
    await setDeposit(dNew, 'submitted');
    let row = await check(C_NEW);
    assert.deepEqual([row.status, row.stage], ['deposited', 'deposited']);
    assert.ok(row.deposited_at, 'deposited_at set');
    const depositedAt = row.deposited_at.toISOString();
    assert.deepEqual(await usage(C_NEW), ['recorded']);
    await setDeposit(dNew, 'cleared');
    row = await check(C_NEW);
    assert.equal(row.deposited_at.toISOString(), depositedAt);
    assert.deepEqual(await usage(C_NEW), ['recorded']);

    // b) Rejected after approval: Returned (as record_check_return records it), the usage event voided,
    // one audit row; it no longer counts as deposited.
    await setDeposit(dNew, 'rejected', { return_reason: 'Image unreadable' });
    row = await check(C_NEW);
    assert.deepEqual([row.status, row.stage, row.pre_return_stage], ['returned', 'returned', 'deposited']);
    assert.deepEqual([row.return_code, row.return_reason, row.return_source, row.return_resolved_at],
      ['checkalt_rejected', 'Image unreadable', 'checkalt', null]);
    assert.ok(row.returned_at);
    assert.deepEqual(await usage(C_NEW), ['voided']);
    assert.deepEqual(await audits(C_NEW), [{ event_type: 'check_returned', code: 'checkalt_rejected' }]);
    // Shown on the Returned tab: returned_at set, return not resolved.
    const returnedTab = (await superuser.query(`SELECT id FROM public.check_intake_items
      WHERE returned_at IS NOT NULL AND return_resolved_at IS NULL ORDER BY id`)).rows.map((r) => r.id);
    assert.ok(returnedTab.includes(C_NEW));

    // Cash-job check: approval records its one payment (SQL 121 and the deposited trigger share it);
    // a rejection removes it, because the check is no longer 'deposited' when SQL 121 runs; a new
    // deposit approves it again: Deposited, the open Check Alt return resolved, one payment, one event.
    const dCash = await deposit(C_CASH, 'pending_approval');
    await setDeposit(dCash, 'submitted');
    assert.equal((await check(C_CASH)).stage, 'deposited');
    assert.deepEqual(await payments(C_CASH), ['2500']);
    assert.deepEqual(await usage(C_CASH), ['recorded']);
    await setDeposit(dCash, 'duplicate');
    row = await check(C_CASH);
    assert.deepEqual([row.stage, row.return_code, row.return_reason], ['returned', 'checkalt_duplicate', 'Check Alt deposit duplicate']);
    assert.deepEqual(await payments(C_CASH), []);
    assert.deepEqual(await usage(C_CASH), ['voided']);
    const dCash2 = await deposit(C_CASH, 'submitted');
    row = await check(C_CASH);
    assert.deepEqual([row.status, row.stage, row.return_resolution], ['deposited', 'deposited', 'checkalt_redeposited']);
    assert.ok(row.return_resolved_at);
    assert.deepEqual(await payments(C_CASH), ['2500']);
    assert.deepEqual(await usage(C_CASH), ['recorded']);
    await setDeposit(dCash2, 'cleared');
    assert.deepEqual(await payments(C_CASH), ['2500']);

    // Two deposits of one check: a rejection while the other is approved keeps it Deposited; an error
    // on the last approved one returns it.
    const two1 = await deposit(C_TWO, 'submitted');
    const two2 = await deposit(C_TWO, 'submitted');
    await setDeposit(two1, 'rejected');
    assert.equal((await check(C_TWO)).stage, 'deposited');
    await setDeposit(two2, 'error');
    row = await check(C_TWO);
    assert.deepEqual([row.stage, row.return_code], ['returned', 'checkalt_error']);
    // Returned again later on the same check: not recorded twice.
    await setDeposit(two1, 'returned');
    assert.equal((await audits(C_TWO)).length, 1);

    // A bank return after the deposit cleared: Returned with the deposit's return date; the usage event
    // stays (SQL 120: a return is its own fee).
    const dRet = await deposit(C_RET, 'cleared');
    assert.equal((await check(C_RET)).stage, 'deposited');
    await setDeposit(dRet, 'returned', { returned_at: '2026-10-27T10:00:00Z', return_reason: 'R01 insufficient funds' });
    row = await check(C_RET);
    assert.deepEqual([row.stage, row.return_code, row.return_reason], ['returned', 'checkalt_returned', 'R01 insufficient funds']);
    assert.equal(row.returned_at.toISOString(), '2026-10-27T10:00:00.000Z');
    assert.deepEqual(await usage(C_RET), ['recorded']);

    // Never backwards: funds already released, or a return recorded by hand, are left as they are.
    await deposit(C_LATE, 'submitted');
    assert.deepEqual([(await check(C_LATE)).status, (await check(C_LATE)).stage], ['funds_released', 'funds_released']);
    await deposit(C_BANK, 'cleared');
    row = await check(C_BANK);
    assert.deepEqual([row.stage, row.return_source, row.return_resolved_at], ['returned', 'manual', null]);

    // Rejected before approval: nothing moves.
    const dOld = await deposit(C_OLD, 'pending');
    await setDeposit(dOld, 'rejected');
    assert.equal((await check(C_OLD)).stage, 'ready_for_deposit');

    // The functions: owner's definers, search_path pinned, row_security off, EXECUTE for the owner only.
    for (const identity of RELEASE_SQL_SPECS.sql123.functions.map((f) => f.identity)) {
      const fn = (await superuser.query(`
        SELECT p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
               has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops_exec,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
               (SELECT array_agg(pg_catalog.pg_get_userbyid(a.grantee)::text) FROM pg_catalog.aclexplode(p.proacl) a) AS grantees
          FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [identity])).rows[0];
      assert.equal(fn.prosecdef, true, identity);
      assert.deepEqual(fn.proconfig, ['search_path=public, pg_temp', 'row_security=off'], identity);
      assert.equal(fn.owner, 'checksops_admin', identity);
      assert.equal(fn.checksops_exec, false, identity);
      assert.equal(fn.authenticated_exec, false, identity);
      assert.deepEqual(fn.grantees, ['checksops_admin'], identity);
    }
    await assert.rejects(api.query(`SELECT public.aws_checkalt_mark_check_deposited('${C_OLD}', now())`), (e) => e.code === '42501');
    assert.equal((await check(C_OLD)).stage, 'ready_for_deposit');
  } finally {
    await api.end().catch(() => {});
    await owner.end().catch(() => {});
    await superuser.end().catch(() => {});
    server.stop();
  }
});
