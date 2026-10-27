/**
 * SQL 120 against PostgreSQL 16: usage events at Check Alt approval and at send time.
 * Every object is owned by a non-superuser checksops_admin LOGIN (production's admin login, which
 * applies the file); the API login checksops writes checkalt_deposits and payment_transfers, as the
 * Check Alt and send paths do. check_billing_events carries production's unique rules
 * ((check_intake_item_id, event_type) and (tenant_id, check_intake_item_id, event_type)) and RLS.
 *
 * Owner rules (2026-10-27): a check is counted once it is approved; never when it did not go through.
 * A next-day ($0.75) or same-day ($1.00) send shows on usage when it is sent, for its claim check, at
 * the tenant's rate when one is set, once per recipient, and is removed when the send fails.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const SQL_120 = path.join(AWS_ROOT, 'workflows/sql/120_usage_events_at_approval_and_send.sql');

const T_ON = '11111111-1111-4111-8111-111111111111'; // per-check on, 250; same-day 120
const T_OFF = '22222222-2222-4222-8222-222222222222'; // per-check off, no tenant send rates
const CLAIM = '66666666-6666-4666-8666-666666666666';
const CHECK_1 = 'c0000000-0000-4000-8000-000000000001';
const CHECK_2 = 'c0000000-0000-4000-8000-000000000002';
const CHECK_3 = 'c0000000-0000-4000-8000-000000000003';
const CHECK_OLD = 'c0000000-0000-4000-8000-000000000004';
const CHECK_BF = 'c0000000-0000-4000-8000-000000000005';

const SCHEMA = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
GRANT USAGE ON SCHEMA public TO checksops;
SET ROLE checksops_admin;
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, per_check_billing_enabled boolean, per_check_rate_cents integer,
  next_day_rate_cents integer, same_day_rate_cents integer);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text, claim_id uuid);
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
GRANT SELECT, INSERT, UPDATE ON public.checkalt_deposits, public.payment_transfers TO checksops;
GRANT SELECT ON public.check_billing_events TO checksops;
-- SQL 98's price functions, as that file defines them.
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT c.price_per_check_cents FROM public.check_billing_config c WHERE c.active = true ORDER BY c.created_at DESC LIMIT 1 $$;
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = public AS $$ SELECT true $$;
INSERT INTO public.check_billing_config (price_per_check_cents) VALUES (300);
INSERT INTO public.tenants VALUES ('${T_ON}', true, 250, NULL, 120), ('${T_OFF}', false, 999, NULL, NULL);
INSERT INTO public.check_intake_items VALUES
  ('${CHECK_1}', '${T_ON}', 'needs_review', '${CLAIM}'),
  ('${CHECK_2}', '${T_OFF}', 'needs_review', NULL),
  ('${CHECK_3}', '${T_ON}', 'needs_review', '${CLAIM}'),
  ('${CHECK_OLD}', '${T_ON}', 'needs_review', NULL),
  ('${CHECK_BF}', '${T_ON}', 'needs_review', '${CLAIM}');
-- Before SQL 120 (the backfill reads these): one October approval, one September approval,
-- one October send (wallet leg and bank top-up for the same recipient), one held send.
INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status, submitted_at) VALUES
  ('${CHECK_BF}', NULL, 'cleared', '2026-10-20T15:00:00Z'),
  ('${CHECK_OLD}', '${T_ON}', 'submitted', '2026-09-20T15:00:00Z');
INSERT INTO public.payment_transfers (tenant_id, status, speed, leg_role, check_id, provider_metadata, submitted_at) VALUES
  ('${T_ON}', 'completed', 'same_day', 'send_wallet', '${CHECK_BF}', '{"request_hash":"bf","recipient_index":0}', '2026-10-21T15:00:00Z'),
  ('${T_ON}', 'completed', 'same_day', 'send_bank', '${CHECK_BF}', '{"request_hash":"bf","recipient_index":0}', '2026-10-21T15:00:01Z'),
  ('${T_ON}', 'ready', 'standard', 'send_wallet', '${CHECK_BF}', '{"request_hash":"held","recipient_index":0}', NULL);
RESET ROLE;
`;

test('SQL 120: usage events at Check Alt approval and at send time (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql120-usage-', 56300);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
  const api = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
  const events = async (where = 'true') => (await superuser.query(
    `SELECT event_type, check_intake_item_id, payment_transfer_id, claim_id, unit_price_cents, status, billed_at, source_kind
       FROM public.check_billing_events WHERE ${where} ORDER BY created_at`)).rows;
  try {
    await superuser.connect();
    await superuser.query(SCHEMA);
    await owner.connect();
    await owner.query(fs.readFileSync(SQL_120, 'utf8'));
    await api.connect();

    // Backfill: October only, billed when it happened; one fee per recipient; nothing for the held send.
    const backfilled = await events();
    assert.deepEqual(backfilled.map((e) => [e.event_type, e.unit_price_cents, e.status]), [
      ['check_processing', 250, 'recorded'],
      ['moov_same_day', 120, 'recorded'],
    ]);
    assert.equal(backfilled[0].check_intake_item_id, CHECK_BF);
    assert.equal(backfilled[0].billed_at.toISOString(), '2026-10-20T15:00:00.000Z');
    assert.equal(backfilled[1].claim_id, CLAIM);
    assert.equal(backfilled[1].check_intake_item_id, null);
    assert.equal(backfilled[1].billed_at.toISOString(), '2026-10-21T15:00:00.000Z');
    await owner.query(fs.readFileSync(SQL_120, 'utf8')); // re-run: nothing more
    assert.equal((await events()).length, 2);

    // Check Alt: pending and pending approval are not charged; approval is, once per check.
    const deposit = (await api.query(
      `INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [CHECK_1, T_ON])).rows[0].id;
    await api.query(`UPDATE public.checkalt_deposits SET status = 'pending_approval' WHERE id = $1`, [deposit]);
    assert.equal((await events(`check_intake_item_id = '${CHECK_1}'`)).length, 0);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'submitted' WHERE id = $1`, [deposit]);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'cleared' WHERE id = $1`, [deposit]);
    let check1 = await events(`check_intake_item_id = '${CHECK_1}'`);
    assert.deepEqual(check1.map((e) => [e.event_type, e.unit_price_cents, e.status]), [['check_processing', 250, 'recorded']]);

    // Per-check billing off bills the default (SQL 98 owner question (b), default true).
    await api.query(`INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, NULL, 'submitted')`, [CHECK_2]);
    assert.deepEqual((await events(`check_intake_item_id = '${CHECK_2}'`)).map((e) => e.unit_price_cents), [300]);

    // Rejected or errored deposits are never charged; a rejection after approval voids the uninvoiced event.
    const rejected = (await api.query(
      `INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [CHECK_3, T_ON])).rows[0].id;
    await api.query(`UPDATE public.checkalt_deposits SET status = 'rejected' WHERE id = $1`, [rejected]);
    assert.equal((await events(`check_intake_item_id = '${CHECK_3}'`)).length, 0);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'submitted' WHERE id = $1`, [rejected]);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'rejected' WHERE id = $1`, [rejected]);
    assert.deepEqual((await events(`check_intake_item_id = '${CHECK_3}'`)).map((e) => e.status), ['voided']);
    // Approved again (resubmission): the same event is recorded again, still one per check.
    await api.query(`INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, $2, 'submitted')`, [CHECK_3, T_ON]);
    assert.deepEqual((await events(`check_intake_item_id = '${CHECK_3}'`)).map((e) => e.status), ['recorded']);

    // Returned is a return, not a failure: the event stays. An invoiced event is never voided.
    await api.query(`UPDATE public.checkalt_deposits SET status = 'returned' WHERE id = $1`, [deposit]);
    check1 = await events(`check_intake_item_id = '${CHECK_1}'`);
    assert.deepEqual(check1.map((e) => e.status), ['recorded']);

    // Send: a held send (legs ready) records nothing; posting the first leg records the fee for the
    // claim check at the tenant's rate; the recipient's bank top-up leg adds nothing.
    const leg = async (role, meta, speed = 'standard', status = 'ready', tenant = T_ON, check = CHECK_1) => (await api.query(
      `INSERT INTO public.payment_transfers (tenant_id, status, speed, leg_role, check_id, provider_metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [tenant, status, speed, role, check, JSON.stringify(meta)])).rows[0].id;
    const setStatus = (id, status) => api.query(`UPDATE public.payment_transfers SET status = $2 WHERE id = $1`, [id, status]);
    const w0 = await leg('send_wallet', { request_hash: 'h1', recipient_index: 0 });
    const b0 = await leg('send_bank', { request_hash: 'h1', recipient_index: 0 });
    const w1 = await leg('send_wallet', { request_hash: 'h1', recipient_index: 1 }, 'same_day');
    assert.equal((await events(`source_kind LIKE 'moov_%' AND billed_at > now() - interval '1 hour'`)).length, 0);
    await setStatus(w0, 'submitting');
    await setStatus(w0, 'pending');
    await setStatus(b0, 'submitting');
    await setStatus(w1, 'submitting');
    let sent = await events(`payment_transfer_id IN ('${w0}', '${b0}', '${w1}')`);
    assert.deepEqual(sent.map((e) => [e.event_type, e.unit_price_cents, e.claim_id, e.status]), [
      ['moov_next_day', 75, CLAIM, 'recorded'],
      ['moov_same_day', 120, CLAIM, 'recorded'],
    ]);
    assert.equal(sent[0].payment_transfer_id, w0);
    assert.equal(sent[0].check_intake_item_id, null);

    // A failed bank top-up while the wallet leg went out keeps the fee; the recipient whose only
    // leg failed has it voided.
    await setStatus(b0, 'failed');
    await setStatus(w1, 'failed');
    sent = await events(`payment_transfer_id IN ('${w0}', '${w1}')`);
    assert.deepEqual(sent.map((e) => [e.event_type, e.status]), [['moov_next_day', 'recorded'], ['moov_same_day', 'voided']]);

    // Every leg failed or canceled: voided. Returned: kept.
    await setStatus(w0, 'returned');
    assert.equal((await events(`payment_transfer_id = '${w0}'`))[0].status, 'recorded');
    const other = await leg('send_wallet', { request_hash: 'h2', recipient_index: 0 }, 'standard', 'ready', T_OFF, CHECK_2);
    await setStatus(other, 'submitting');
    assert.deepEqual((await events(`payment_transfer_id = '${other}'`)).map((e) => [e.unit_price_cents, e.claim_id]), [[75, null]]);
    await setStatus(other, 'canceled');
    assert.equal((await events(`payment_transfer_id = '${other}'`))[0].status, 'voided');

    // Invoiced events are never voided.
    const billed = await leg('send_wallet', { request_hash: 'h3', recipient_index: 0 }, 'same_day');
    await setStatus(billed, 'submitting');
    await superuser.query(`UPDATE public.check_billing_events SET status = 'invoiced', invoice_id = gen_random_uuid() WHERE payment_transfer_id = $1`, [billed]);
    await setStatus(billed, 'failed');
    assert.equal((await events(`payment_transfer_id = '${billed}'`))[0].status, 'invoiced');

    // Instant, non-send legs and legs with no check are not charged here.
    const instant = await leg('send_wallet', { request_hash: 'h4', recipient_index: 0 }, 'instant');
    const funding = await leg('wallet_funding', { request_hash: 'h5', recipient_index: 0 });
    const noCheck = await leg('send_wallet', { request_hash: 'h6', recipient_index: 0 }, 'standard', 'ready', T_ON, null);
    for (const id of [instant, funding, noCheck]) await setStatus(id, 'submitting');
    assert.equal((await events(`payment_transfer_id IN ('${instant}', '${funding}', '${noCheck}')`)).length, 0);

    // One fee per leg is unique; the trigger functions are EXECUTE for their owner only.
    const index = (await superuser.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'check_billing_events_transfer_event_uidx'`)).rows[0];
    assert.match(index.indexdef, /UNIQUE INDEX .* \(payment_transfer_id, event_type\) WHERE \(payment_transfer_id IS NOT NULL\)/);
    for (const fn of ['aws_record_checkalt_billing_event()', 'aws_record_send_speed_fee()', 'aws_check_processing_price_cents(uuid)', 'aws_send_speed_fee_cents(uuid,text)']) {
      const ok = (await superuser.query(`SELECT has_function_privilege('checksops', 'public.${fn}', 'EXECUTE') AS ok`)).rows[0].ok;
      assert.equal(ok, false, fn);
    }
  } finally {
    await api.end().catch(() => {});
    await owner.end().catch(() => {});
    await superuser.end().catch(() => {});
    server.stop();
  }
});
