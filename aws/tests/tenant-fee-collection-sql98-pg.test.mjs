/**
 * SQL 98 and the manual fee pull against PostgreSQL 16 (shared helper
 * stakeholder-policies-pg.mjs). The engine runs as the checksops role with the
 * platform owner's (or a member's) identity in request.app_user_id, each call
 * in its own transaction committed only when the result is ok, like
 * withIdentityWrite. Covers:
 *   - per-check price stamping (record_check_billing_event, one default from
 *     check_billing_config);
 *   - preview amount = pull amount, posted once to the ChecksOps destination
 *     from the tenant's bank only;
 *   - one charge per tenant period (repeat, concurrent double click,
 *     duplicate-period refusal of the unique index);
 *   - preview mismatch (invoice changed, or the tenant's authorized bank
 *     changed), member refusal, unset destination, production post flag off:
 *     nothing booked, nothing posted;
 *   - the destination table keeps only SQL 98's platform-owner policies and
 *     checksops SELECT/INSERT/UPDATE, whatever it had before;
 *   - owner question (b)'s switch (per-check billing off, no fee);
 *   - audit rows (who, tenant, period, amount, Moov transfer id) and that only
 *     the platform owner writes / reads the audit and the destination.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { handleTenantBillingAdmin } from '../functions/api/tenant-billing-handlers.mjs';
import { periodKey } from '../functions/api/tenant-billing-engine.mjs';
import { CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID } from '../functions/api/tenant-billing-destination.mjs';
import {
  CHECKSOPS_PLATFORM_ACCOUNT_ID,
  CHECKSOPS_PLATFORM_WALLET_PM_ID,
} from '../functions/api/tenant-collection-v2.mjs';

const SQL_98 = path.join(AWS_ROOT, 'workflows/sql/98_tenant_fee_collection.sql');
const AUTH_UID = path.join(AWS_ROOT, 'identity/sql/02_auth_uid_guc.sql');
const OWNER_HELPERS = path.join(AWS_ROOT, 'rls/sql/10_owner_helpers_from_identity.sql');

const OWNER = 'a1000000-0000-4000-8000-0000000000aa';
const MEMBER = 'a1000000-0000-4000-8000-0000000000bb';
const T_A = '11111111-1111-4111-8111-111111111111'; // per-check on, 250
const T_B = '22222222-2222-4222-8222-222222222222'; // per-check off
const T_C = '33333333-3333-4333-8333-333333333333'; // per-check on, NULL rate
const DEST_PM = '44444444-4444-4444-8444-444444444444';

const SCHEMA = `
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT authenticated TO checksops;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
INSERT INTO public.identity_accounts VALUES ('${OWNER}', 'checksopsadmin@gmail.com', 'active'), ('${MEMBER}', 'member@example.com', 'active');

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, name text, slug text, subscription_status text,
  monthly_rate_cents integer, referral_discount_cents integer, is_founding_partner boolean,
  per_check_rate_cents integer, per_check_billing_enabled boolean,
  next_day_rate_cents integer, same_day_rate_cents integer,
  mortgage_ops_initial_rate_cents integer, mortgage_ops_additional_rate_cents integer);
CREATE TABLE public.tenant_users (tenant_id uuid, user_id uuid, role text);
CREATE TABLE public.tenant_billing_settings (
  tenant_id uuid PRIMARY KEY, billing_enabled boolean NOT NULL DEFAULT false,
  billing_day_of_month integer NOT NULL DEFAULT 1, next_period_start date, updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.tenant_billing_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid UNIQUE, stakeholder_account_id uuid,
  auto_debit_enabled boolean, ach_authorized_at timestamptz, ach_authorized_by uuid, verification_status text,
  provider_payment_method_id text, provider_bank_account_id text, provider_account_id text,
  provider_environment text, nickname text, account_holder_name text, account_number_last4 text);
CREATE TABLE public.payment_provider_accounts (
  tenant_id uuid, provider text, environment text, provider_account_id text, onboarding_status text,
  can_ach_debit boolean, can_send_payments boolean, verification_status text, capabilities jsonb,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.payment_provider_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, provider_account_id text,
  provider_payment_method_id text, provider_bank_account_id text, rail_payment_method_ids jsonb,
  rails_synced_at timestamptz, connection_status text, verification_status text, can_send boolean,
  environment text, holder_name text, last_four text, updated_at timestamptz DEFAULT now());
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text);
CREATE TABLE public.check_billing_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price_per_check_cents integer NOT NULL DEFAULT 300,
  currency text NOT NULL DEFAULT 'usd', stripe_meter_event_name text NOT NULL DEFAULT 'checks_processed',
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  payment_transfer_id uuid, event_type text NOT NULL DEFAULT 'check_processing',
  unit_price_cents integer NOT NULL, currency text NOT NULL DEFAULT 'usd', status text NOT NULL DEFAULT 'recorded',
  billed_at timestamptz NOT NULL DEFAULT now(), billing_period text, invoice_id uuid, source_kind text,
  source_id uuid, claim_id uuid, mortgage_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, provider text, environment text, status text,
  idempotency_key text, amount_cents bigint, platform_fee_cents bigint, net_amount_cents bigint, speed text,
  requested_speed text, description text, source_tenant_account_id text, wallet_id uuid, leg_role text,
  provider_transfer_id text, provider_status text, failure_reason text, provider_metadata jsonb,
  provider_fee_cents bigint, submitted_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key));
CREATE TABLE public.tenant_maintenance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, amount_cents integer NOT NULL,
  monthly_rate_cents integer, discount_cents integer, period_start date, period_end date, billing_period text,
  method text, status text, idempotence_key text UNIQUE, recorded_by uuid, notes text, reference text,
  funding_source_method_id text, destination_account_id text, destination_payment_method_id text,
  provider_environment text, provider_transfer_id text,
  maintenance_net_cents integer, check_usage_cents integer, next_day_usage_cents integer,
  same_day_usage_cents integer, usage_total_cents integer, check_count integer, next_day_count integer,
  same_day_count integer, mortgage_ops_initial_count integer, mortgage_ops_initial_amount_cents integer,
  mortgage_ops_additional_count integer, mortgage_ops_additional_amount_cents integer,
  occurrence_kind text NOT NULL DEFAULT 'monthly_subscription',
  submitted_at timestamptz, settled_at timestamptz, returned_at timestamptz, failure_reason text,
  return_reason text, received_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.email_send_log (
  id uuid PRIMARY KEY, template_name text, recipient_email text, tenant_id uuid, status text, provider text,
  provider_message_id text, idempotency_key text, error_message text, metadata jsonb, created_at timestamptz);
CREATE TABLE public.tenant_invoice_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, tenant_id uuid, billing_period text,
  source_kind text, source_id uuid, fee_type text, unit_price_cents integer, amount_cents integer,
  billed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id, fee_type));
`;

const GRANTS = `
CREATE OR REPLACE FUNCTION public.aws_is_authenticated() RETURNS boolean LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path = public AS $$ SELECT auth.uid() IS NOT NULL $$;
GRANT SELECT, INSERT, UPDATE ON public.tenants, public.tenant_users, public.tenant_billing_settings,
  public.tenant_billing_accounts, public.payment_provider_accounts, public.payment_provider_methods,
  public.check_intake_items, public.check_billing_config, public.check_billing_events, public.payment_transfers,
  public.tenant_maintenance_payments, public.tenant_invoice_allocations TO checksops;
GRANT SELECT ON public.identity_accounts, public.profiles TO checksops;
GRANT SELECT, INSERT ON public.email_send_log TO checksops;
-- SQL 96 is a prerequisite of SQL 98; only its setter's presence is checked here
-- (tenant-pricing-platform-owner and sql90 PG tests cover SQL 96 itself).
CREATE FUNCTION public.aws_platform_owner_set_tenant_pricing(_tenant_id uuid, _pricing jsonb) RETURNS jsonb
  LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
`;

const seedTenant = (id, { perCheck, rate }) => `
INSERT INTO public.tenants VALUES ('${id}', 'Tenant ${id.slice(0, 1)}', 't${id.slice(0, 1)}', 'active',
  10000, 1000, false, ${rate === null ? 'NULL' : rate}, ${perCheck}, NULL, NULL, NULL, NULL);
INSERT INTO public.tenant_users VALUES ('${id}', '${MEMBER}', 'owner');
INSERT INTO public.tenant_billing_settings (tenant_id, billing_enabled, billing_day_of_month) VALUES ('${id}', true, 1);
INSERT INTO public.tenant_billing_accounts (tenant_id, auto_debit_enabled, ach_authorized_at, ach_authorized_by,
  provider_payment_method_id, provider_account_id, provider_environment, account_number_last4)
  VALUES ('${id}', true, now(), '${MEMBER}', 'pm-bank-${id.slice(0, 1)}', 'acct-${id.slice(0, 1)}', 'sandbox', '6789');
INSERT INTO public.payment_provider_accounts VALUES ('${id}', 'moov', 'sandbox', 'acct-${id.slice(0, 1)}', 'active',
  true, true, 'verified', '[]'::jsonb, now());
INSERT INTO public.payment_provider_methods (tenant_id, provider_account_id, provider_payment_method_id,
  connection_status, can_send, environment) VALUES ('${id}', 'acct-${id.slice(0, 1)}', 'pm-bank-${id.slice(0, 1)}',
  'connected', true, 'sandbox');
`;

test('PostgreSQL 16: SQL 98 stamps per-check prices; the platform owner\'s manual pull charges the previewed amount once, audited', {
  timeout: 240000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql98-fees-', 55800);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const connect = async () => {
    const c = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
    await c.connect();
    return c;
  };
  const posts = [];
  // Invoice email spy: fails for tenants in failMail (failure isolation), sinks otherwise.
  const mails = [];
  const failMail = new Set();
  const mailer = async (msg) => {
    if (failMail.has(msg.tenantId)) throw new Error('ses unavailable');
    mails.push(msg);
    return { mode: 'sink', results: [{ delivery: 'sink', status: 'sunk', messageId: `mail-${mails.length}` }] };
  };
  const deps = (extra = {}) => ({
    ignoreEnabledFlag: true,
    simulate: false,
    invoiceEmailEnabled: true,
    sendViaSesOrSink: mailer,
    postTransfer: async ({ amount, idempotencyKey, sourceMethodId, destMethodId, facilitatorAccountId }) => {
      posts.push({ amount, idempotencyKey, sourceMethodId, destMethodId, facilitatorAccountId });
      return { transferID: `tr-${posts.length}`, status: 'pending' };
    },
    resolveBillingDebitSource: async (_client, { authorization }) => ({
      ok: true, sourceMethodId: `debit-${authorization.provider_payment_method_id}`, sourceAccountId: authorization.provider_account_id,
    }),
    ...extra,
  });
  /** One withIdentityWrite-like transaction: commit only an ok result. */
  const call = async (c, user, body, extra = {}, { hold = null } = {}) => {
    await c.query('BEGIN');
    try {
      await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
      const res = await handleTenantBillingAdmin({ body: JSON.stringify(body) }, { client: c, mapping: { application_user_id: user }, ...deps(extra) });
      if (hold) await hold;
      await c.query(res.ok !== false && Number(res.statusCode || 200) < 400 ? 'COMMIT' : 'ROLLBACK');
      return res;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  };
  const count = async (sql, params = []) => Number((await admin.query(sql, params)).rows[0].n);
  const period = periodKey(new Date());
  let c1 = null;
  let c2 = null;
  try {
    await admin.connect();
    await admin.query(SCHEMA);
    await admin.query(fs.readFileSync(AUTH_UID, 'utf8'));
    await admin.query(fs.readFileSync(OWNER_HELPERS, 'utf8'));
    await admin.query(GRANTS);
    for (const [id, opts] of [[T_A, { perCheck: true, rate: 250 }], [T_B, { perCheck: false, rate: 999 }], [T_C, { perCheck: true, rate: null }]]) {
      await admin.query(seedTenant(id, opts));
    }
    const sql98 = fs.readFileSync(SQL_98, 'utf8');

    // Refuses without a prerequisite; refuses duplicate tenant periods; then applies twice.
    await admin.query('BEGIN');
    await admin.query('ALTER TABLE public.check_billing_config RENAME TO cbc_x');
    await assert.rejects(admin.query(sql98), (e) => e.code === '55000' && /sql98_prerequisite_missing/.test(e.message));
    await admin.query('ROLLBACK');
    // Without SQL 96 (its pricing setter) SQL 98 refuses too.
    await admin.query('BEGIN');
    await admin.query('DROP FUNCTION public.aws_platform_owner_set_tenant_pricing(uuid, jsonb)');
    await assert.rejects(admin.query(sql98), (e) => e.code === '55000' && /sql98_prerequisite_missing/.test(e.message));
    await admin.query('ROLLBACK');
    await admin.query('BEGIN');
    await admin.query(`INSERT INTO public.tenant_maintenance_payments (tenant_id, amount_cents, billing_period) VALUES ('${T_B}', 1, '2020-01'), ('${T_B}', 1, '2020-01')`);
    await assert.rejects(admin.query(sql98), (e) => e.code === '23505' && /sql98_duplicate_billing_periods/.test(e.message));
    await admin.query('ROLLBACK');
    assert.equal(await count('SELECT count(*) AS n FROM public.check_billing_config'), 0);
    await admin.query(sql98);
    await admin.query(sql98);
    // The one default is seeded only because the table was empty.
    assert.deepEqual((await admin.query('SELECT price_per_check_cents, active FROM public.check_billing_config')).rows, [{ price_per_check_cents: 300, active: true }]);
    await assert.rejects(admin.query(`INSERT INTO public.tenant_maintenance_payments (tenant_id, amount_cents, billing_period) VALUES ('${T_B}', 1, '2020-02'), ('${T_B}', 1, '2020-02')`), (e) => e.code === '23505');

    // A destination table that already carries other policies and grants (live names unknown):
    // SQL 98 leaves only its two platform-owner policies and checksops SELECT, INSERT, UPDATE.
    await admin.query(`CREATE POLICY legacy_open ON public.platform_billing_destination FOR ALL TO authenticated USING (true) WITH CHECK (true)`);
    await admin.query('GRANT ALL ON public.platform_billing_destination TO checksops, authenticated');
    await admin.query(sql98);
    assert.deepEqual(
      (await admin.query("SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'platform_billing_destination' ORDER BY 1")).rows.map((r) => r.policyname),
      ['aws_select_platform_billing_destination', 'aws_write_platform_billing_destination'],
    );
    for (const [role, privilege, expected] of [
      ['checksops', 'SELECT', true], ['checksops', 'INSERT', true], ['checksops', 'UPDATE', true],
      ['checksops', 'DELETE', false], ['checksops', 'TRUNCATE', false], ['authenticated', 'INSERT', false],
    ]) {
      const has = (await admin.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.platform_billing_destination', privilege])).rows[0].ok;
      assert.equal(has, expected, `${role} ${privilege}`);
    }

    c1 = await connect();
    c2 = await connect();

    // 1) Price stamping: first deposit only, tenant rate when per-check is on, else the config default.
    const deposit = async (tenantId, checkId) => {
      await c1.query('INSERT INTO public.check_intake_items VALUES ($1, $2, $3)', [checkId, tenantId, 'pending']);
      await c1.query('UPDATE public.check_intake_items SET status = $2 WHERE id = $1', [checkId, 'deposited']);
    };
    const price = async (checkId) => (await admin.query(
      "SELECT array_agg(unit_price_cents) AS p FROM public.check_billing_events WHERE check_intake_item_id = $1 AND event_type = 'check_processing'", [checkId],
    )).rows[0].p;
    const CK = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    await deposit(T_A, CK(1));
    await deposit(T_B, CK(2));
    await deposit(T_C, CK(3));
    assert.deepEqual(await price(CK(1)), [250]);
    assert.deepEqual(await price(CK(2)), [300]);
    assert.deepEqual(await price(CK(3)), [300], 'per-check on with no rate falls back to the config default, the deposit still succeeds');
    await c1.query("UPDATE public.check_intake_items SET status = 'review' WHERE id = $1", [CK(1)]);
    await c1.query("UPDATE public.check_intake_items SET status = 'deposited' WHERE id = $1", [CK(1)]);
    assert.deepEqual(await price(CK(1)), [250], 'a re-deposit does not bill twice');
    await admin.query("INSERT INTO public.check_billing_config (price_per_check_cents, created_at) VALUES (350, now() + interval '1 second')");
    await deposit(T_B, CK(4));
    assert.deepEqual(await price(CK(4)), [350], 'the newest active config row is the default');
    await admin.query('UPDATE public.check_billing_config SET active = false');
    await deposit(T_B, CK(5));
    assert.equal(await price(CK(5)), null, 'no active config: no event, and the deposit is not blocked');
    assert.equal((await admin.query('SELECT status FROM public.check_intake_items WHERE id = $1', [CK(5)])).rows[0].status, 'deposited');
    await admin.query("UPDATE public.check_billing_config SET active = true WHERE price_per_check_cents = 300");
    await admin.query("DELETE FROM public.check_billing_config WHERE price_per_check_cents = 350");

    // Owner question (b): the one switch. Answered "off means no fee", per-check-off tenants record
    // nothing while per-check-on tenants keep their rate. Rolled back: the default stays true.
    assert.equal((await admin.query('SELECT public.aws_check_billing_charges_when_per_check_off() AS v')).rows[0].v, true);
    await admin.query('BEGIN');
    await admin.query('CREATE OR REPLACE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$');
    for (const [tenantId, n] of [[T_B, 90], [T_A, 91]]) {
      await admin.query('INSERT INTO public.check_intake_items VALUES ($1, $2, $3)', [CK(n), tenantId, 'pending']);
      await admin.query("UPDATE public.check_intake_items SET status = 'deposited' WHERE id = $1", [CK(n)]);
    }
    assert.equal(await price(CK(90)), null, 'per-check off: no per-check fee');
    assert.deepEqual(await price(CK(91)), [250], 'per-check on: the tenant rate');
    await admin.query('ROLLBACK');
    assert.equal(await price(CK(90)), null);

    // 2) Destination: platform owner only, in the API and in the database.
    const memberDest = await call(c1, MEMBER, { action: 'destination-get' });
    assert.equal(memberDest.error, 'platform_owner_required');
    await c1.query('BEGIN');
    await c1.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER]);
    await assert.rejects(c1.query(`INSERT INTO public.platform_billing_destination (environment, moov_account_id, moov_payment_method_id) VALUES ('sandbox', 'x', 'y')`), /row-level security/);
    await c1.query('ROLLBACK');
    const unset = await call(c1, OWNER, { action: 'destination-get' });
    assert.equal(unset.destination.configured, false);
    // An unset destination refuses the pull.
    const preUnset = await call(c1, OWNER, { action: 'preview', tenant_id: T_A, period });
    assert.ok(preUnset.readiness.reasons.includes('destination_unresolved'));
    const noDest = await call(c1, OWNER, { action: 'pull', tenant_id: T_A, period, preview_hash: preUnset.preview_hash, confirm: true });
    assert.equal(noDest.statusCode, 503);
    assert.equal(noDest.error, 'billing_destination_unresolved');
    const wrongDest = await call(c1, OWNER, { action: 'destination-set', moov_account_id: CHECKSOPS_PLATFORM_ACCOUNT_ID, moov_payment_method_id: DEST_PM });
    assert.equal(wrongDest.error, 'billing_destination_unresolved', 'sandbox accepts only the ChecksOps sandbox merchant');
    const setDest = await call(c1, OWNER, { action: 'destination-set', moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, moov_payment_method_id: DEST_PM, label: 'ChecksOps sandbox' });
    assert.equal(setDest.ok, true);
    assert.equal(setDest.destination.configured, true);
    assert.equal(setDest.destination.source, 'table');
    const destAudit = (await admin.query("SELECT actor_id, details FROM public.platform_billing_audit WHERE event = 'destination_set'")).rows;
    assert.equal(destAudit.length, 1);
    assert.equal(destAudit[0].actor_id, OWNER);
    assert.equal(destAudit[0].details.new.moov_account_id, CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID);
    await c1.query('BEGIN');
    await c1.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER]);
    assert.equal((await c1.query('SELECT * FROM public.platform_billing_destination')).rows.length, 0, 'members never see the platform destination');
    assert.equal((await c1.query('SELECT * FROM public.platform_billing_audit')).rows.length, 0);
    await c1.query('ROLLBACK');

    // A same-day Moov deposit in the period (billed at the default same-day rate, 100).
    await admin.query(`INSERT INTO public.payment_transfers (tenant_id, provider, environment, status, speed, completed_at, amount_cents)
      VALUES ('${T_A}', 'moov', 'sandbox', 'completed', 'same_day', now(), 50000)`);

    // 3) Members never pull.
    const memberPull = await call(c1, MEMBER, { action: 'pull', tenant_id: T_A, period, preview_hash: preUnset.preview_hash, confirm: true });
    assert.equal(memberPull.error, 'platform_owner_required');

    // 4) Preview = pull amount, posted once, from the tenant bank to the ChecksOps destination.
    const preview = await call(c1, OWNER, { action: 'preview', tenant_id: T_A, period });
    assert.equal(preview.ok, true);
    assert.equal(preview.readiness.ready, true, JSON.stringify(preview.readiness));
    assert.equal(preview.amount_cents, 10000 - 1000 + 250 + 100);
    assert.equal(await count('SELECT count(*) AS n FROM public.tenant_maintenance_payments WHERE tenant_id = $1', [T_A]), 0, 'preview writes nothing');
    assert.equal(mails.length, 0, 'no preview (or refused pull so far) sends an invoice email');
    const pulled = await call(c1, OWNER, { action: 'pull', tenant_id: T_A, period, preview_hash: preview.preview_hash, confirm: true });
    assert.equal(pulled.ok, true, JSON.stringify(pulled));
    assert.equal(pulled.charged, true);
    assert.equal(pulled.amount_cents_posted, preview.amount_cents);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].amount, preview.amount_cents);
    assert.equal(posts[0].sourceMethodId, 'debit-pm-bank-1', 'ACH from the authorized bank');
    assert.equal(posts[0].destMethodId, DEST_PM);
    assert.equal(posts[0].facilitatorAccountId, CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID);
    const booked = (await admin.query('SELECT amount_cents, status, billing_period, provider_transfer_id FROM public.tenant_maintenance_payments WHERE tenant_id = $1', [T_A])).rows;
    assert.equal(booked.length, 1);
    assert.equal(booked[0].amount_cents, preview.amount_cents);
    assert.equal(booked[0].status, 'submitted');
    const audit = (await admin.query("SELECT actor_id, tenant_id, billing_period, amount_cents, provider_transfer_ids, outcome FROM public.platform_billing_audit WHERE event = 'pull' ORDER BY created_at, outcome")).rows;
    assert.deepEqual(audit.map((r) => r.outcome).sort(), ['started', 'submitted']);
    for (const row of audit) {
      assert.equal(row.actor_id, OWNER);
      assert.equal(row.tenant_id, T_A);
      assert.equal(row.billing_period, period);
      assert.equal(Number(row.amount_cents), preview.amount_cents);
    }
    assert.deepEqual(audit.find((r) => r.outcome === 'submitted').provider_transfer_ids, ['tr-1']);

    // Invoice email: once, to the member who authorized the ACH debit, keyed on the charge.
    const occA = (await admin.query('SELECT id FROM public.tenant_maintenance_payments WHERE tenant_id = $1', [T_A])).rows[0].id;
    assert.equal(pulled.pull.invoice_email.status, 'sunk', JSON.stringify(pulled.pull.invoice_email));
    assert.equal(pulled.pull.invoice_email_sent, true);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'member@example.com');
    assert.match(mails[0].text, new RegExp(`billing period ${period}`));
    assert.match(mails[0].text, /ending in 6789/);
    assert.match(mails[0].text, new RegExp(`\\$${(preview.amount_cents / 100).toFixed(2)}`));
    const mailAudit = (await admin.query("SELECT actor_id, outcome, occurrence_id, details FROM public.platform_billing_audit WHERE event = 'invoice_email'")).rows;
    assert.equal(mailAudit.length, 1);
    assert.equal(mailAudit[0].outcome, 'sunk');
    assert.equal(mailAudit[0].actor_id, OWNER);
    assert.equal(mailAudit[0].occurrence_id, occA);
    const sendLog = (await admin.query('SELECT template_name, recipient_email, status, idempotency_key FROM public.email_send_log')).rows;
    assert.deepEqual(sendLog, [{ template_name: 'tenant-fee-invoice', recipient_email: 'member@example.com', status: 'sunk', idempotency_key: `fee-invoice:${occA}` }]);
    // The database also refuses a second sent/sunk invoice for the same charge.
    await assert.rejects(admin.query(`INSERT INTO public.platform_billing_audit (event, outcome, occurrence_id) VALUES ('invoice_email', 'sent', $1)`, [occA]), (e) => e.code === '23505');

    // The fee pull itself is never billed as the tenant's next-day usage.
    await admin.query("UPDATE public.payment_transfers SET status = 'completed', completed_at = now() WHERE provider_transfer_id = 'tr-1'");
    const after = await call(c1, OWNER, { action: 'preview', tenant_id: T_A, period });
    assert.equal(after.totals.next_day_count, 0);
    assert.equal(after.already_charged, true);
    assert.equal(after.amount_cents, preview.amount_cents);

    // 5) Retry / double click: nothing is posted again.
    const again = await call(c1, OWNER, { action: 'pull', tenant_id: T_A, period, preview_hash: preview.preview_hash, confirm: true });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.charged, false);
    assert.equal(posts.length, 1);
    assert.equal(mails.length, 1, 'a duplicate pull sends no second invoice');
    // A platform-owner resend of an already-sent invoice sends nothing; members cannot resend.
    const resentA = await call(c1, OWNER, { action: 'invoice-resend', tenant_id: T_A, period, confirm: true });
    assert.equal(resentA.invoice_email.status, 'already_sent');
    assert.equal(mails.length, 1);
    const memberResend = await call(c1, MEMBER, { action: 'invoice-resend', tenant_id: T_A, period, confirm: true });
    assert.equal(memberResend.error, 'platform_owner_required');

    // Concurrent double click on another tenant: the advisory lock serializes, the second sees the booked row.
    failMail.add(T_B); // this tenant's invoice email fails: the pull must still commit.
    const pB = await call(c1, OWNER, { action: 'preview', tenant_id: T_B, period });
    assert.equal(pB.readiness.ready, true, JSON.stringify(pB.readiness));
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const first = call(c1, OWNER, { action: 'pull', tenant_id: T_B, period, preview_hash: pB.preview_hash, confirm: true }, {}, { hold });
    while (posts.length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
    const second = call(c2, OWNER, { action: 'pull', tenant_id: T_B, period, preview_hash: pB.preview_hash, confirm: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(posts.length, 2, 'the second pull waits on the lock');
    release();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.charged, true);
    assert.equal(r2.duplicate, true);
    assert.equal(posts.length, 2);
    assert.equal(await count('SELECT count(*) AS n FROM public.tenant_maintenance_payments WHERE tenant_id = $1 AND billing_period = $2', [T_B, period]), 1);
    // Failure isolation: the email failed, the charge is committed and the failure recorded.
    assert.equal(r1.pull.invoice_email.status, 'failed');
    assert.equal(r1.ok, true);
    assert.equal((await admin.query("SELECT status FROM public.tenant_maintenance_payments WHERE tenant_id = $1", [T_B])).rows[0].status, 'submitted');
    assert.deepEqual((await admin.query("SELECT outcome FROM public.platform_billing_audit WHERE event = 'invoice_email' AND tenant_id = $1", [T_B])).rows.map((r) => r.outcome), ['failed']);
    assert.equal(mails.length, 1);
    // The platform owner resends once SES is back; a second resend sends nothing.
    failMail.delete(T_B);
    const resentB = await call(c1, OWNER, { action: 'invoice-resend', tenant_id: T_B, period, confirm: true });
    assert.equal(resentB.invoice_email.status, 'sunk', JSON.stringify(resentB));
    assert.equal(mails.length, 2);
    const resentB2 = await call(c1, OWNER, { action: 'invoice-resend', tenant_id: T_B, period, confirm: true });
    assert.equal(resentB2.invoice_email.status, 'already_sent');
    assert.equal(mails.length, 2);
    const noCharge = await call(c1, OWNER, { action: 'invoice-resend', tenant_id: T_C, period, confirm: true });
    assert.equal(noCharge.error, 'not_charged');

    // 6) The invoice changed after the preview: nothing is booked or posted.
    const pC = await call(c1, OWNER, { action: 'preview', tenant_id: T_C, period });
    await deposit(T_C, CK(6));
    const mismatch = await call(c1, OWNER, { action: 'pull', tenant_id: T_C, period, preview_hash: pC.preview_hash, confirm: true });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.error, 'preview_mismatch');
    assert.equal(posts.length, 2);
    assert.equal(await count('SELECT count(*) AS n FROM public.tenant_maintenance_payments WHERE tenant_id = $1', [T_C]), 0);
    // Same amount, but the tenant re-pointed its authorized bank after the preview: refused too.
    const pFund = await call(c1, OWNER, { action: 'preview', tenant_id: T_C, period });
    await admin.query(`INSERT INTO public.payment_provider_methods (tenant_id, provider_account_id, provider_payment_method_id, connection_status, can_send, environment)
      VALUES ('${T_C}', 'acct-3', 'pm-bank-3b', 'connected', true, 'sandbox')`);
    await admin.query("UPDATE public.tenant_billing_accounts SET provider_payment_method_id = 'pm-bank-3b' WHERE tenant_id = $1", [T_C]);
    const moved = await call(c1, OWNER, { action: 'pull', tenant_id: T_C, period, preview_hash: pFund.preview_hash, confirm: true });
    assert.equal(moved.error, 'preview_mismatch');
    assert.equal(posts.length, 2);
    assert.equal(await count('SELECT count(*) AS n FROM public.tenant_maintenance_payments WHERE tenant_id = $1', [T_C]), 0);
    await admin.query("UPDATE public.tenant_billing_accounts SET provider_payment_method_id = 'pm-bank-3' WHERE tenant_id = $1", [T_C]);
    // A browser amount is refused even with a valid preview.
    const pC2 = await call(c1, OWNER, { action: 'preview', tenant_id: T_C, period });
    const withAmount = await call(c1, OWNER, { action: 'pull', tenant_id: T_C, period, preview_hash: pC2.preview_hash, confirm: true, amount_cents: 1 });
    assert.equal(withAmount.error, 'client_amount_refused');
    assert.equal(posts.length, 2);

    // $1 verification debit stays available to the platform owner, audited; same id twice posts once.
    const VERIFY = 'd0000000-0000-4000-8000-000000000001';
    const memberVerify = await call(c1, MEMBER, { action: 'verify-debit', tenant_id: T_A, verification_id: VERIFY, confirm: true }, { simulate: true });
    assert.equal(memberVerify.error, 'platform_owner_required');
    const v1 = await call(c1, OWNER, { action: 'verify-debit', tenant_id: T_A, verification_id: VERIFY, confirm: true }, { simulate: true });
    assert.equal(v1.ok, true, JSON.stringify(v1));
    assert.equal(v1.charged, true);
    assert.equal(v1.amount_cents_posted, 100);
    const v2 = await call(c1, OWNER, { action: 'verify-debit', tenant_id: T_A, verification_id: VERIFY, confirm: true }, { simulate: true });
    assert.equal(v2.duplicate, true);
    assert.equal(await count("SELECT count(*) AS n FROM public.tenant_maintenance_payments WHERE occurrence_kind = 'billing_verification'"), 1);
    const vAudit = (await admin.query("SELECT actor_id, amount_cents, outcome, provider_transfer_ids FROM public.platform_billing_audit WHERE event = 'verify_debit' ORDER BY created_at")).rows;
    assert.ok(vAudit.length >= 2);
    assert.ok(vAudit.every((r) => r.actor_id === OWNER && Number(r.amount_cents) === 100));
    assert.ok(vAudit.some((r) => r.outcome === 'submitted' && r.provider_transfer_ids.length === 1));
    assert.equal(mails.length, 2, 'refused / mismatched pulls and the $1 verification send no invoice');

    // 7) Audit writer: platform owner only; no direct writes.
    await c1.query('BEGIN');
    await c1.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER]);
    await assert.rejects(c1.query('SELECT public.aws_platform_owner_record_billing_audit($1::jsonb)', [JSON.stringify({ event: 'pull', tenant_id: T_A, outcome: 'x' })]),
      (e) => e.code === '42501');
    await c1.query('ROLLBACK');
    await c1.query('BEGIN');
    await c1.query("SELECT set_config('request.app_user_id', $1, true)", [OWNER]);
    await assert.rejects(c1.query(`INSERT INTO public.platform_billing_audit (event, outcome) VALUES ('pull', 'forged')`), /permission denied/);
    await c1.query('ROLLBACK');
    await c1.query('BEGIN');
    await c1.query("SELECT set_config('request.app_user_id', $1, true)", [OWNER]);
    await assert.rejects(c1.query("UPDATE public.platform_billing_audit SET outcome = 'x'"), /permission denied/);
    await c1.query('ROLLBACK');

    // 8) Production with the post flag off: refused before anything is booked.
    const saved = process.env.CHECKSOPS_ENV;
    process.env.CHECKSOPS_ENV = 'production-prep';
    try {
      const prodDest = await call(c1, OWNER, { action: 'destination-set', moov_account_id: CHECKSOPS_PLATFORM_ACCOUNT_ID, moov_payment_method_id: CHECKSOPS_PLATFORM_WALLET_PM_ID });
      assert.equal(prodDest.ok, true, JSON.stringify(prodDest));
      await admin.query("UPDATE public.payment_provider_accounts SET environment = 'production' WHERE tenant_id = $1", [T_C]);
      await admin.query("UPDATE public.payment_provider_methods SET environment = 'production' WHERE tenant_id = $1", [T_C]);
      const pProd = await call(c1, OWNER, { action: 'preview', tenant_id: T_C, period });
      const prod = await call(c1, OWNER, { action: 'pull', tenant_id: T_C, period, preview_hash: pProd.preview_hash, confirm: true });
      assert.equal(prod.error, 'production_billing_post_disabled', JSON.stringify(prod));
      assert.equal(posts.length, 2);
      assert.equal(await count('SELECT count(*) AS n FROM public.tenant_maintenance_payments WHERE tenant_id = $1', [T_C]), 0);
    } finally {
      if (saved === undefined) delete process.env.CHECKSOPS_ENV;
      else process.env.CHECKSOPS_ENV = saved;
    }
  } finally {
    await c1?.end().catch(() => {});
    await c2?.end().catch(() => {});
    await admin.end().catch(() => {});
    server.stop();
  }
});
