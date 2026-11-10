/**
 * SQL 149 against PostgreSQL 16: the invoice fee ($0.30, agreement 3.6) and the failed deposit fee
 * ($2.00, agreement 3.7) as usage events. Every object is owned by a non-superuser checksops_admin
 * LOGIN (production's admin login, which applies the file); the API login checksops writes
 * moov_invoices and checkalt_deposits, as the invoice and Check Alt paths do. check_billing_events
 * carries production's unique rules and RLS. SQL 120 is applied first, as on staging and production.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const SQL_120 = path.join(AWS_ROOT, 'workflows/sql/120_usage_events_at_approval_and_send.sql');
const SQL_149 = path.join(AWS_ROOT, 'workflows/sql/149_invoice_and_failed_deposit_fees.sql');

const T = '11111111-1111-4111-8111-111111111111';
const CLAIM = '66666666-6666-4666-8666-666666666666';
const CHECK_1 = 'c0000000-0000-4000-8000-000000000001';
const CHECK_2 = 'c0000000-0000-4000-8000-000000000002';
const OLD_INVOICE = 'a0000000-0000-4000-8000-000000000001';

const SCHEMA = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
GRANT USAGE ON SCHEMA public TO checksops;
SET ROLE checksops_admin;
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, per_check_billing_enabled boolean, per_check_rate_cents integer,
  next_day_rate_cents integer, same_day_rate_cents integer);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text, claim_id uuid, check_number text);
CREATE TABLE public.check_billing_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price_per_check_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd', active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  payment_transfer_id uuid, event_type text DEFAULT 'check_processing',
  unit_price_cents integer NOT NULL, currency text NOT NULL DEFAULT 'usd', status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded','reported','invoiced','failed','voided')),
  billed_at timestamptz NOT NULL DEFAULT now(), billing_period text, invoice_id uuid, source_kind text,
  source_id uuid, claim_id uuid, mortgage_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_billing_events_check_event_unique UNIQUE (check_intake_item_id, event_type));
CREATE UNIQUE INDEX check_billing_events_tenant_check_event_uniq
  ON public.check_billing_events (tenant_id, check_intake_item_id, event_type);
ALTER TABLE public.check_billing_events ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, tenant_id uuid,
  status text NOT NULL DEFAULT 'pending', submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'production', status text NOT NULL DEFAULT 'draft', speed text NOT NULL DEFAULT 'standard',
  requested_speed text, leg_role text, check_id uuid, claim_id uuid, amount_cents bigint NOT NULL DEFAULT 100,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.moov_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, environment text NOT NULL DEFAULT 'sandbox',
  customer_name text NOT NULL DEFAULT 'Customer', status text NOT NULL DEFAULT 'draft',
  sent_at timestamptz, claim_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.tenant_maintenance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, amount_cents integer NOT NULL,
  billing_period text, usage_total_cents integer, mortgage_ops_additional_amount_cents integer);
GRANT SELECT, INSERT, UPDATE ON public.checkalt_deposits, public.payment_transfers, public.moov_invoices,
  public.tenant_maintenance_payments TO checksops;
GRANT SELECT ON public.check_billing_events TO checksops;
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT c.price_per_check_cents FROM public.check_billing_config c WHERE c.active = true ORDER BY c.created_at DESC LIMIT 1 $$;
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = public AS $$ SELECT true $$;
INSERT INTO public.check_billing_config (price_per_check_cents) VALUES (400);
INSERT INTO public.tenants VALUES ('${T}', false, NULL, NULL, NULL);
INSERT INTO public.check_intake_items VALUES
  ('${CHECK_1}', '${T}', 'needs_review', '${CLAIM}', '1001'),
  ('${CHECK_2}', '${T}', 'needs_review', NULL, '1002');
-- Before SQL 149: an invoice sent and a deposit rejected. Neither is charged (no backfill).
INSERT INTO public.moov_invoices (id, tenant_id, status, sent_at) VALUES ('${OLD_INVOICE}', '${T}', 'unpaid', now() - interval '1 day');
INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ('${CHECK_2}', '${T}', 'rejected');
RESET ROLE;
`;

test('SQL 149: invoice fee and failed deposit fee usage events (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql149-usage-fees-', 56400);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
  const api = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
  const events = async (where = 'true') => (await superuser.query(
    `SELECT event_type, check_intake_item_id, claim_id, unit_price_cents, status, source_kind, source_id, billed_at
       FROM public.check_billing_events WHERE ${where} ORDER BY created_at`)).rows;
  try {
    await superuser.connect();
    await superuser.query(SCHEMA);
    await owner.connect();
    await owner.query(fs.readFileSync(SQL_120, 'utf8'));
    await owner.query(fs.readFileSync(SQL_149, 'utf8'));
    await api.connect();

    // No backfill: nothing for the invoice sent or the deposit rejected before the launch.
    assert.deepEqual(await events(), []);
    const launch = (await superuser.query('SELECT launched_at FROM public.tenant_usage_fee_launch')).rows;
    assert.equal(launch.length, 1);
    // Re-running keeps the launch and adds nothing.
    await owner.query(fs.readFileSync(SQL_149, 'utf8'));
    const again = (await superuser.query('SELECT launched_at FROM public.tenant_usage_fee_launch')).rows;
    assert.equal(again[0].launched_at.toISOString(), launch[0].launched_at.toISOString());
    // The API login cannot read or change the launch, nor run the rate or trigger functions.
    await assert.rejects(api.query('SELECT * FROM public.tenant_usage_fee_launch'), /permission denied/);
    await assert.rejects(api.query('SELECT public.aws_usage_fee_launched_at()'), /permission denied/);

    // Invoice fee: a draft is not charged; the first send is, once, for the invoice's claim.
    const invoice = (await api.query(
      `INSERT INTO public.moov_invoices (tenant_id, claim_id) VALUES ($1, $2) RETURNING id`, [T, CLAIM])).rows[0].id;
    assert.equal((await events(`source_id = '${invoice}'`)).length, 0);
    await api.query(`UPDATE public.moov_invoices SET status = 'unpaid', sent_at = now() WHERE id = $1`, [invoice]);
    let fees = await events(`source_id = '${invoice}'`);
    assert.deepEqual(fees.map((e) => [e.event_type, e.unit_price_cents, e.status, e.source_kind, e.claim_id, e.check_intake_item_id]),
      [['invoice_sent', 30, 'recorded', 'moov_invoice', CLAIM, null]]);
    // Resend (sent_at moves), sync, cancel: still one fee.
    await api.query(`UPDATE public.moov_invoices SET sent_at = now() + interval '1 minute' WHERE id = $1`, [invoice]);
    await api.query(`UPDATE public.moov_invoices SET status = 'canceled' WHERE id = $1`, [invoice]);
    assert.equal((await events(`source_id = '${invoice}'`)).length, 1);
    // Created and sent in one step (create_and_send) is charged too.
    const sentNow = (await api.query(
      `INSERT INTO public.moov_invoices (tenant_id, status, sent_at) VALUES ($1, 'unpaid', now()) RETURNING id`, [T])).rows[0].id;
    assert.deepEqual((await events(`source_id = '${sentNow}'`)).map((e) => e.unit_price_cents), [30]);
    // A recovered invoice sent before the launch is not charged.
    const recovered = (await api.query(
      `INSERT INTO public.moov_invoices (tenant_id, status, sent_at) VALUES ($1, 'unpaid', now() - interval '30 days') RETURNING id`, [T])).rows[0].id;
    assert.equal((await events(`source_id = '${recovered}'`)).length, 0);
    // The old invoice re-saved with its old sent_at is not charged.
    await api.query(`UPDATE public.moov_invoices SET status = 'paid' WHERE id = $1`, [OLD_INVOICE]);
    assert.equal((await events(`source_id = '${OLD_INVOICE}'`)).length, 0);

    // Failed deposit fee: approval records the $4.00 check fee (SQL 120); a rejection voids it and
    // records $2.00 for that deposit, for the check's claim, not linked to the check itself.
    const deposit = (await api.query(
      `INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [CHECK_1, T])).rows[0].id;
    await api.query(`UPDATE public.checkalt_deposits SET status = 'submitted' WHERE id = $1`, [deposit]);
    assert.deepEqual((await events(`check_intake_item_id = '${CHECK_1}'`)).map((e) => [e.event_type, e.unit_price_cents, e.status]),
      [['check_processing', 400, 'recorded']]);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'rejected' WHERE id = $1`, [deposit]);
    assert.deepEqual((await events(`check_intake_item_id = '${CHECK_1}'`)).map((e) => e.status), ['voided']);
    fees = await events(`source_id = '${deposit}'`);
    assert.deepEqual(fees.map((e) => [e.event_type, e.unit_price_cents, e.status, e.source_kind, e.claim_id, e.check_intake_item_id]),
      [['failed_deposit', 200, 'recorded', 'checkalt_deposit', CLAIM, null]]);
    // Moving between failed statuses, or back and failing again, is the same deposit: one fee.
    await api.query(`UPDATE public.checkalt_deposits SET status = 'error' WHERE id = $1`, [deposit]);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'pending' WHERE id = $1`, [deposit]);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'rejected' WHERE id = $1`, [deposit]);
    assert.equal((await events(`source_id = '${deposit}'`)).length, 1);

    // The check deposited again (a new deposit) is charged the check fee again; a second failed
    // deposit of the same check is a second $2.00.
    const second = (await api.query(
      `INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, NULL, 'duplicate') RETURNING id`,
      [CHECK_1])).rows[0].id;
    assert.deepEqual((await events(`source_id = '${second}'`)).map((e) => [e.event_type, e.unit_price_cents]), [['failed_deposit', 200]]);
    const third = (await api.query(
      `INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, $2, 'submitted') RETURNING id`,
      [CHECK_1, T])).rows[0].id;
    assert.deepEqual((await events(`check_intake_item_id = '${CHECK_1}'`)).map((e) => e.status), ['recorded']);
    // A bank return keeps the check fee (SQL 120) and adds the failed deposit fee.
    await api.query(`UPDATE public.checkalt_deposits SET status = 'cleared' WHERE id = $1`, [third]);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'returned' WHERE id = $1`, [third]);
    assert.deepEqual((await events(`check_intake_item_id = '${CHECK_1}'`)).map((e) => e.status), ['recorded']);
    assert.deepEqual((await events(`source_id = '${third}'`)).map((e) => [e.event_type, e.unit_price_cents]), [['failed_deposit', 200]]);
    // Pending, approval and clearing are never failed deposits; neither is a deposit with no check.
    await api.query(`INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES (NULL, $1, 'rejected')`, [T]);
    assert.equal((await events(`event_type = 'failed_deposit'`)).length, 3);

    // One fee per invoice and per deposit, whoever writes it.
    await assert.rejects(superuser.query(
      `INSERT INTO public.check_billing_events (tenant_id, event_type, unit_price_cents, source_kind, source_id)
       VALUES ($1, 'failed_deposit', 200, 'checkalt_deposit', $2)`, [T, deposit]), /check_billing_events_usage_source_uidx/);

    // The monthly invoice row has the breakdown columns, zero by default.
    const cols = (await superuser.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'tenant_maintenance_payments' AND column_name IN
          ('invoice_fee_count', 'invoice_fee_amount_cents', 'failed_deposit_count', 'failed_deposit_amount_cents')
        ORDER BY column_name`)).rows;
    assert.deepEqual(cols.map((c) => [c.column_name, c.is_nullable, c.column_default]), [
      ['failed_deposit_amount_cents', 'NO', '0'],
      ['failed_deposit_count', 'NO', '0'],
      ['invoice_fee_amount_cents', 'NO', '0'],
      ['invoice_fee_count', 'NO', '0'],
    ]);
    await api.query(`INSERT INTO public.tenant_maintenance_payments (tenant_id, amount_cents) VALUES ($1, 0)`, [T]);

    // The trigger functions run for their owner only.
    const execs = (await superuser.query(
      `SELECT p.proname, has_function_privilege('checksops', p.oid, 'EXECUTE') AS api_exec, p.prosecdef
         FROM pg_proc p WHERE p.proname IN ('aws_record_invoice_fee', 'aws_record_failed_deposit_fee')
        ORDER BY p.proname`)).rows;
    assert.deepEqual(execs.map((r) => [r.proname, r.api_exec, r.prosecdef]), [
      ['aws_record_failed_deposit_fee', false, true],
      ['aws_record_invoice_fee', false, true],
    ]);
  } finally {
    await api.end().catch(() => {});
    await owner.end().catch(() => {});
    await superuser.end().catch(() => {});
    server.stop();
  }
});

test('SQL 149 refuses to run without SQL 120', { timeout: 120000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql149-prereq-', 56500);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  try {
    await superuser.connect();
    await superuser.query(SCHEMA);
    await assert.rejects(superuser.query(fs.readFileSync(SQL_149, 'utf8')), (err) => (
      err.code === '55000' && /sql149_prerequisite_missing: .*SQL 120/.test(err.message)));
  } finally {
    await superuser.end().catch(() => {});
    server.stop();
  }
});
