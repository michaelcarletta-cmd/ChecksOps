/**
 * SQL 174 against PostgreSQL 16: the one Check Alt deposit attempt stranded before the provider sign-in goes back to
 * queued. Every object is owned by a non-superuser checksops_admin LOGIN (production's admin login, which applies the
 * file); the API login checksops writes checkalt_deposits as the submit path does.
 *
 * The four status triggers on checkalt_deposits are the real ones (SQL 98's record_check_billing_event, the SQL 120,
 * SQL 121, SQL 123 and SQL 152 files, the Supabase sync_cash_job_check_payment() and tg_set_deposited_metadata()), so the
 * reset is proven to write nothing through them, and a later approval of the reset row still moves its check (they are
 * live).
 *
 * Through the production tool (release-sql-production-apply.mjs, the code the one-shot runs): two stranded attempts in
 * the window or none refuse before the file runs (checkalt_stranded_attempt_in_window); the file run by hand with two
 * aborts with sql174_ambiguous_stranded_attempts and changes nothing; with exactly one the apply resets only that row
 * (near misses: another minute, the window's end, created earlier, a reference, a failure_class, a last_error, another
 * status, the check deposited, the check with a second deposit row) and is then refused as already in place; a re-run
 * of the bytes and a second call change nothing; the reset row is claimable by the API's own markHttpAttempted.
 *
 * Owner 2026-11-24: "start step 3" (clear the one stranded CheckAlt deposit attempt).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import {
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  markHttpAttempted,
  pickBlockingDeposit,
  rowHasProviderHttpAttempt,
  shouldBlockNewProcessPost,
  shouldReconcileInsteadOfPost,
} from '../functions/api/providers/production/checkalt-idempotency.mjs';

const REPO = path.join(AWS_ROOT, '..');
const KEY = 'sql174';
const SQL_98 = path.join(AWS_ROOT, 'workflows/sql/98_tenant_fee_collection.sql');
const SQL_120 = path.join(AWS_ROOT, 'workflows/sql/120_usage_events_at_approval_and_send.sql');
const SQL_121 = path.join(AWS_ROOT, 'workflows/sql/121_cash_jobs_production_grants.sql');
const SQL_123 = path.join(AWS_ROOT, 'workflows/sql/123_checkalt_deposit_check_status.sql');
const SQL_152 = path.join(AWS_ROOT, 'workflows/sql/152_invoice_and_failed_deposit_fees.sql');
const SQL_174 = path.join(AWS_ROOT, 'workflows/sql/174_checkalt_reset_stranded_attempt.sql');
const SUPABASE_CHECK_PAYMENT = path.join(REPO, 'supabase/migrations/20260522142101_6c46a740-87fc-48ab-afd4-07af285f1ae3.sql');
const SUPABASE_DEPOSITED_METADATA = path.join(REPO, 'supabase/migrations/20260527171651_357a79e6-8571-4ad1-a7e6-092ece413a8d.sql');
const ROOT = REPO;
const PIN = loadReleaseProductionPin(KEY, ROOT);
const ABSENT = releaseStateHash(KEY, {});

const T = '11111111-1111-4111-8111-111111111111';
const USER = 'a1000000-0000-4000-8000-000000000001';
const JOB = 'b0000000-0000-4000-8000-000000000001';
// One check per deposit, so the "only deposit row of its check" rule is tested on its own (C_TWO has two).
const ROWS = Object.freeze({
  stranded: 1, // the row: submitting, attempted 19:58:53, created 19:58:52, no reference, no error
  second: 2, // a second exact match (removed before the apply)
  before_window: 3, // attempted and created 19:57:59
  window_end: 4, // attempted and created 19:59:00 (the end is exclusive)
  created_earlier: 5, // attempted in the window, created 19:50
  has_reference: 6,
  failure_class: 7,
  last_error: 8,
  status_error: 9, // status error in the window
  check_deposited: 10,
  two_rows: 11, // the check also has an older error row (12)
  two_rows_other: 12,
  cash_job: 13, // a cash-job check, for the trigger positive control (stays out of the window)
});
const dep = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const chk = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STRANDED_PAYLOAD = '{"phase": "submitting", "scale": "integer_cents", "amount_cents": 125000, "provider_http_attempted": true}';

const slice = (file, from, to) => {
  const text = fs.readFileSync(file, 'utf8');
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${path.basename(file)}: ${from}`);
  return text.slice(a, b);
};
const depositedMetadataSql = () => {
  const text = fs.readFileSync(SUPABASE_DEPOSITED_METADATA, 'utf8');
  const from = text.indexOf('CREATE OR REPLACE FUNCTION public.tg_set_deposited_metadata()');
  assert.ok(from > 0);
  return text.slice(from);
};

// SQL 123's test schema (sql123-checkalt-check-status-pg.test.mjs) with checkalt_deposits as SQL 65 and the Supabase
// migrations leave it, and the tables SQL 152 needs.
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
  tenant_id uuid, checkalt_reference text, status text NOT NULL DEFAULT 'pending', amount numeric, amount_cents bigint,
  idempotency_key text, provider_http_attempted_at timestamptz, failure_class text, last_error text,
  last_status_payload jsonb, submitted_by uuid, return_reason text, submitted_at timestamptz,
  cleared_at timestamptz, returned_at timestamptz, last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX checkalt_deposits_tenant_idempotency_key_uq ON public.checkalt_deposits (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
ALTER TABLE public.checkalt_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY checkalt_deposits_api ON public.checkalt_deposits FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft',
  speed text NOT NULL DEFAULT 'standard', requested_speed text, leg_role text, check_id uuid, claim_id uuid,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.moov_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft',
  sent_at timestamptz, claim_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.tenant_maintenance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, amount_cents integer NOT NULL,
  billing_period text, usage_total_cents integer, mortgage_ops_additional_amount_cents integer);
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT c.price_per_check_cents FROM public.check_billing_config c WHERE c.active = true ORDER BY c.created_at DESC LIMIT 1 $$;
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = public AS $$ SELECT true $$;
${fs.readFileSync(SUPABASE_CHECK_PAYMENT, 'utf8')};
${depositedMetadataSql()}
`;

/** Every row of checkalt_deposits in id order, every column as text. */
const deposits = async (client) => (await client.query(
  'SELECT to_jsonb(d) AS row FROM public.checkalt_deposits d ORDER BY id')).rows.map((r) => r.row);
const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));
/** The side tables the status triggers write, and the checks. */
const sideEffects = async (client) => ({
  checks: (await client.query('SELECT to_jsonb(c) AS row FROM public.check_intake_items c ORDER BY id')).rows.map((r) => r.row),
  billing: (await client.query('SELECT count(*)::int AS n FROM public.check_billing_events')).rows[0].n,
  payments: (await client.query('SELECT count(*)::int AS n FROM public.cash_job_payments')).rows[0].n,
  audit: (await client.query('SELECT count(*)::int AS n FROM public.check_audit_log')).rows[0].n,
});

function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${KEY}-pg-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${KEY}-pg-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-24T00:00:00.000Z',
  };
}
/** An approved, accepted copy of the committed pin with the absent pre-state (test only). */
const APPROVED = Object.freeze({
  ...PIN,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: ABSENT,
  staging_acceptance: { ok: true, reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000', basis: 'test fixture' },
});

test('SQL 174: only the one stranded attempt goes back to queued; two or none refuse; near misses, triggers and re-runs untouched (PostgreSQL 16)', { timeout: 300000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql174-reset-', 61374);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
  const api = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
  const connect = async () => {
    const client = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
    await client.connect();
    return client;
  };
  const consumedPath = path.join(os.tmpdir(), `sql174-pg-consumed-${process.pid}-${Date.now()}.json`);
  const productionInspect = async () => {
    const out = await inspectReleaseProduction(KEY, { connect, pin: APPROVED, root: ROOT });
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.details;
  };
  const productionApply = () => executeReleaseProductionApply(KEY, manifest(APPROVED), { root: ROOT, pin: APPROVED, connect, consumedPath });
  const insertDeposit = (n, { check = n, status = 'submitting', ref = null, attempted = '2026-11-24 19:58:53+00', created = '2026-11-24 19:58:52+00',
    failure = null, error = null, payload = STRANDED_PAYLOAD } = {}) => superuser.query(
    `INSERT INTO public.checkalt_deposits (id, check_intake_item_id, tenant_id, checkalt_reference, status, amount, amount_cents,
       idempotency_key, provider_http_attempted_at, failure_class, last_error, last_status_payload, submitted_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1250.00, 125000, $6, $7::timestamptz, $8, $9, $10::jsonb, $11, $12::timestamptz, COALESCE($7::timestamptz, $12::timestamptz))`,
    [dep(n), chk(check), T, ref, status, `key-${String(n).padStart(4, "0")}`.padEnd(64, "0"), attempted, failure, error, payload, USER, created]);
  try {
    await superuser.connect();
    await superuser.query(SCHEMA + `
SET ROLE checksops_admin;
${slice(SQL_98, 'CREATE OR REPLACE FUNCTION public.record_check_billing_event()', '-- 2) one charge per tenant period')}
INSERT INTO public.check_billing_config (price_per_check_cents) VALUES (300);
INSERT INTO public.tenants VALUES ('${T}', true, 250, NULL, NULL);
INSERT INTO public.cash_jobs (id, tenant_id, title, contract_amount) VALUES ('${JOB}', '${T}', 'Roof', 10000);
GRANT SELECT ON public.check_intake_items, public.check_billing_events, public.cash_job_payments TO checksops;
GRANT SELECT, INSERT, UPDATE ON public.checkalt_deposits, public.payment_transfers TO checksops;
RESET ROLE;
`);
    await owner.connect();
    await api.connect();
    for (const file of [SQL_120, SQL_121, SQL_123, SQL_152]) await owner.query(fs.readFileSync(file, 'utf8'));
    // One check per deposit row (approved for deposit, ready for deposit, not deposited) but the deposited one.
    for (const n of Object.values(ROWS).filter((v) => v !== ROWS.two_rows_other)) {
      await superuser.query(
        `INSERT INTO public.check_intake_items (id, tenant_id, amount, uploaded_by, check_source, cash_job_id, cash_job_payment_class, check_stage, status, deposited_at)
         VALUES ($1, $2, 1250, $3, $4, $5, $6, $7, $8, $9)`,
        [chk(n), T, USER, n === ROWS.cash_job ? 'cash_job' : 'insurance', n === ROWS.cash_job ? JOB : null, n === ROWS.cash_job ? 'progress_payment' : null,
          n === ROWS.check_deposited ? 'deposited' : 'ready_for_deposit', n === ROWS.check_deposited ? 'deposited' : 'approved_for_deposit',
          n === ROWS.check_deposited ? '2026-11-24 19:00:00+00' : null]);
    }
    await insertDeposit(ROWS.stranded);
    await insertDeposit(ROWS.second);
    await insertDeposit(ROWS.before_window, { attempted: '2026-11-24 19:57:59+00', created: '2026-11-24 19:57:59+00' });
    await insertDeposit(ROWS.window_end, { attempted: '2026-11-24 19:59:00+00', created: '2026-11-24 19:59:00+00' });
    await insertDeposit(ROWS.created_earlier, { created: '2026-11-24 19:50:00+00' });
    await insertDeposit(ROWS.has_reference, { ref: 'CA-REF-6' });
    await insertDeposit(ROWS.failure_class, { failure: 'provider_timeout' });
    await insertDeposit(ROWS.last_error, { error: 'CheckAlt auth failed [504]' });
    await insertDeposit(ROWS.status_error, { status: 'error' });
    await insertDeposit(ROWS.check_deposited);
    await insertDeposit(ROWS.two_rows_other, { check: ROWS.two_rows, status: 'error', attempted: '2026-11-23 10:00:00+00', created: '2026-11-23 10:00:00+00' });
    await insertDeposit(ROWS.two_rows);
    await insertDeposit(ROWS.cash_job, { status: 'queued', attempted: null, created: '2026-11-24 18:00:00+00',
      payload: '{"phase": "queued_before_http", "scale": "integer_cents", "amount_cents": 125000, "provider_http_attempted": false}' });
    const seeded = await deposits(superuser);
    const seededSide = await sideEffects(superuser);
    const fnAbsent = async () => (await superuser.query(
      "SELECT to_regprocedure('public.aws_checkalt_reset_stranded_attempt(timestamptz, timestamptz)') AS f")).rows[0].f === null;

    // 1) Two exact matches: the production tool refuses before the file runs, and the file run by hand aborts; nothing
    // changes (not even the function).
    let inspect = await productionInspect();
    assert.deepEqual(inspect.counts, { checkalt_stranded_attempts_in_window: 2, checkalt_reset_attempts_in_window: 0 });
    assert.deepEqual(inspect.precondition_failures, ['checkalt_stranded_attempt_in_window']);
    assert.equal(inspect.live_definition_sha256, ABSENT);
    assert.equal(inspect.apply_preconditions_met, false);
    const refusedTwo = await productionApply();
    assert.equal(refusedTwo.ok, false);
    assert.match(JSON.stringify(refusedTwo), /checkalt_stranded_attempt_in_window/);
    await assert.rejects(owner.query(fs.readFileSync(SQL_174, 'utf8')),
      (err) => err.code === '55000' && /^sql174_ambiguous_stranded_attempts: 2 rows match; nothing changed/.test(err.message));
    assert.ok(await fnAbsent());
    assert.deepEqual(await deposits(superuser), seeded);

    // 2) None: the production rule refuses (production must hold exactly the one the inspect found).
    const strandedRow = byId(seeded)[dep(ROWS.stranded)];
    await superuser.query('DELETE FROM public.checkalt_deposits WHERE id = ANY($1::uuid[])', [[dep(ROWS.stranded), dep(ROWS.second)]]);
    inspect = await productionInspect();
    assert.deepEqual(inspect.counts, { checkalt_stranded_attempts_in_window: 0, checkalt_reset_attempts_in_window: 0 });
    assert.deepEqual(inspect.precondition_failures, ['checkalt_stranded_attempt_in_window']);
    assert.equal((await productionApply()).ok, false);
    assert.ok(await fnAbsent());

    // 3) Exactly one: the production inspect proceeds and the apply resets only that row.
    await insertDeposit(ROWS.stranded);
    const beforeApply = await deposits(superuser);
    assert.deepEqual(byId(beforeApply)[dep(ROWS.stranded)], strandedRow);
    inspect = await productionInspect();
    assert.deepEqual(inspect.counts, { checkalt_stranded_attempts_in_window: 1, checkalt_reset_attempts_in_window: 0 });
    assert.deepEqual(inspect.precondition_failures, []);
    assert.equal(inspect.already_applied, false);
    assert.equal(inspect.apply_preconditions_met, true);
    const t0 = Date.now();
    const applied = await productionApply();
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.deepEqual(applied.details.receipt.release_sql_inspect.counts, { checkalt_stranded_attempts_in_window: 0, checkalt_reset_attempts_in_window: 1 });

    const afterApply = await deposits(superuser);
    const was = byId(beforeApply);
    const now = byId(afterApply);
    assert.deepEqual(Object.keys(now), Object.keys(was));
    for (const id of Object.keys(was).filter((k) => k !== dep(ROWS.stranded))) assert.deepEqual(now[id], was[id], id);
    const reset = now[dep(ROWS.stranded)];
    const changed = Object.keys(reset).filter((k) => JSON.stringify(reset[k]) !== JSON.stringify(was[dep(ROWS.stranded)][k])).sort();
    assert.deepEqual(changed, ['last_status_payload', 'provider_http_attempted_at', 'status', 'updated_at']);
    assert.equal(reset.status, 'queued');
    assert.equal(reset.provider_http_attempted_at, null);
    assert.equal(reset.checkalt_reference, null);
    const { stranded_reset: audit, ...payload } = reset.last_status_payload;
    assert.deepEqual(payload, { phase: 'queued_before_http', scale: 'integer_cents', amount_cents: 125000, provider_http_attempted: false });
    assert.deepEqual(Object.keys(audit).sort(), ['at', 'migration', 'reason']);
    assert.deepEqual([audit.reason, audit.migration], ['pre_provider_sign_in_504', '174']);
    assert.ok(Math.abs(Date.parse(audit.at) - t0) < 60000, audit.at);
    assert.ok(Date.parse(reset.updated_at) >= t0 - 60000);
    // The four status triggers wrote nothing: no check moved, no usage event, cash-job payment or audit row.
    assert.deepEqual(await sideEffects(superuser), seededSide);
    // The function is owner-only.
    await assert.rejects(api.query("SELECT public.aws_checkalt_reset_stranded_attempt('2026-11-24 19:58:00+00', '2026-11-24 19:59:00+00')"), /permission denied/);

    // 4) Already in place: the tools refuse a second apply; a re-run of the bytes and a second call change nothing.
    inspect = await productionInspect();
    assert.equal(inspect.already_applied, true);
    assert.equal(inspect.live_definition_sha256, PIN.intended_replacement_sha256);
    assert.deepEqual(inspect.counts, { checkalt_stranded_attempts_in_window: 0, checkalt_reset_attempts_in_window: 1 });
    const again = await executeReleaseProductionApply(KEY, manifest(APPROVED), { root: ROOT, pin: APPROVED, connect, consumedPath });
    assert.equal(again.ok, false);
    const notices = [];
    owner.on('notice', (msg) => notices.push(msg.message));
    await owner.query(fs.readFileSync(SQL_174, 'utf8'));
    assert.ok(notices.some((m) => /^sql174_already_reset: 1 row\(s\) of the window already reset; nothing changed$/.test(m)), JSON.stringify(notices));
    assert.ok(notices.includes('SQL 174: 0 stranded Check Alt deposit attempt(s) put back to queued'), JSON.stringify(notices));
    assert.equal((await owner.query("SELECT public.aws_checkalt_reset_stranded_attempt('2026-11-24 19:58:00+00', '2026-11-24 19:59:00+00') AS n")).rows[0].n, 0);
    assert.deepEqual(await deposits(superuser), afterApply);
    assert.deepEqual(await sideEffects(superuser), seededSide);
    // The window must be non-empty and at most one hour.
    for (const [from, to] of [['2026-11-24 19:59:00+00', '2026-11-24 19:58:00+00'], ['2026-11-24 18:00:00+00', '2026-11-24 19:00:01+00'], [null, '2026-11-24 19:59:00+00']]) {
      await assert.rejects(owner.query('SELECT public.aws_checkalt_reset_stranded_attempt($1, $2)', [from, to]),
        (err) => err.code === '22023' && /^sql174_invalid_window/.test(err.message));
    }
    assert.deepEqual(await deposits(superuser), afterApply);

    // 5) The reset row as the API reads it: not blocking, not to reconcile, and markHttpAttempted claims it.
    const apiRow = (await api.query(
      `SELECT id, tenant_id, check_intake_item_id, checkalt_reference, status, amount, amount_cents, idempotency_key,
              provider_http_attempted_at, failure_class, last_status_payload, last_error, submitted_at, submitted_by, created_at, updated_at
         FROM public.checkalt_deposits WHERE id = $1`, [dep(ROWS.stranded)])).rows[0];
    assert.equal(rowHasProviderHttpAttempt(apiRow), false);
    assert.equal(shouldReconcileInsteadOfPost(apiRow), false);
    assert.equal(shouldBlockNewProcessPost(apiRow), false);
    assert.equal(pickBlockingDeposit([apiRow]), null);
    await api.query('BEGIN');
    try {
      const claimed = await markHttpAttempted(api, dep(ROWS.stranded));
      assert.equal(claimed.claimed, true);
      assert.equal(claimed.row.status, 'submitting');
      assert.ok(claimed.row.provider_http_attempted_at);
      // A positive control for the triggers: the claimed attempt approved by Check Alt moves its check to Deposited.
      await api.query(`UPDATE public.checkalt_deposits SET status = 'submitted', checkalt_reference = 'CA-NEW', submitted_at = now() WHERE id = $1`, [dep(ROWS.stranded)]);
      const moved = (await api.query('SELECT check_stage::text AS stage FROM public.check_intake_items WHERE id = $1', [chk(ROWS.stranded)])).rows[0];
      assert.equal(moved.stage, 'deposited');
    } finally {
      await api.query('ROLLBACK');
    }
    assert.deepEqual(await deposits(superuser), afterApply);
  } finally {
    await api.end().catch(() => {});
    await owner.end().catch(() => {});
    await superuser.end().catch(() => {});
    server.stop();
    fs.rmSync(consumedPath, { force: true });
  }
});

test('SQL 174 refuses without its prerequisites and without reading past row security (PostgreSQL 16)', { timeout: 120000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql174-prereq-', 61474);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  try {
    await superuser.connect();
    await superuser.query(`
      CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
      CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, deposited_at timestamptz);
      CREATE TABLE public.checkalt_deposits (id uuid PRIMARY KEY, check_intake_item_id uuid, checkalt_reference text, status text,
        provider_http_attempted_at timestamptz, created_at timestamptz, updated_at timestamptz, last_status_payload jsonb);
      ALTER TABLE public.check_intake_items OWNER TO checksops_admin;
      ALTER TABLE public.checkalt_deposits OWNER TO checksops_admin;`);
    const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
    await owner.connect();
    try {
      await assert.rejects(owner.query(fs.readFileSync(SQL_174, 'utf8')), (err) => (
        err.code === '55000' && err.message === 'sql174_prerequisite_missing: column public.checkalt_deposits.failure_class, column public.checkalt_deposits.last_error'));
      await superuser.query('ALTER TABLE public.checkalt_deposits ADD COLUMN failure_class text, ADD COLUMN last_error text');
      await superuser.query('ALTER TABLE public.checkalt_deposits FORCE ROW LEVEL SECURITY');
      await assert.rejects(owner.query(fs.readFileSync(SQL_174, 'utf8')), (err) => err.code === '55000' && /^sql174_definer_cannot_read/.test(err.message));
      await superuser.query('ALTER TABLE public.checkalt_deposits NO FORCE ROW LEVEL SECURITY');
      // Then it applies (no stranded row: returns 0).
      await owner.query(fs.readFileSync(SQL_174, 'utf8'));
    } finally {
      await owner.end().catch(() => {});
    }
  } finally {
    await superuser.end().catch(() => {});
    server.stop();
  }
});
