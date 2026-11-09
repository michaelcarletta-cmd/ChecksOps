/**
 * SQL 147 (aws/workflows/sql/147_external_disbursement_record.sql) on PostgreSQL 16, called through the API route's
 * own code (aws/functions/api/external-disbursement.mjs runRecordExternalDisbursement) as checksops, the API login,
 * with request.app_user_id set as withIdentity sets it. Every object is owned by the non-superuser checksops_admin
 * login (production's admin login, which applies the file). checksops holds SELECT only on the disbursement tables:
 * the record is written by the DEFINER alone, so it does not depend on table grants the API login may not hold.
 *
 * The stage triggers are the real Supabase ones (recompute_check_release_stage and the two advance_* trigger
 * functions, verbatim); SQL 90's membership helpers are verbatim. The tables carry the columns SQL 147 names; their
 * CHECK lists other than disbursement_splits_method_check (supabase/migrations/...4b1f) are not in this repository
 * and are modelled on the values the application writes.
 *
 * Proves: the record writes one completed batch and one settled external_check split (actor from the sign-in, check
 * number, memo) and moves the check to Funds Released; the amount available counts the PA fee, earlier payments
 * and Moov send legs and ignores failed ones; more than is left is refused and nothing is written; a repeat with the
 * same key records nothing new; a reused key with other payments is refused; two records racing for the same check
 * cannot overspend it; another tenant's member, a missing user and a foreign stakeholder account are refused; no
 * payment_transfers row is written; checksops cannot insert directly and a plain login cannot execute the function;
 * the file is re-runnable and refuses a login that does not own the tables.
 *
 * Run: node --test aws/tests/sql147-external-disbursement-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers
 * run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { runRecordExternalDisbursement } from '../functions/api/external-disbursement.mjs';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { SQL90_WRITE_HELPERS, sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const REPO = path.join(AWS_ROOT, '..');
const SQL147 = path.join(AWS_ROOT, 'workflows/sql/147_external_disbursement_record.sql');

const T_A = '11111111-1111-4111-8111-111111111111';
const T_B = '33333333-3333-4333-8333-333333333333';
const MEMBER_A = 'a1000000-0000-4000-8000-000000000001';
const MEMBER_B = 'a1000000-0000-4000-8000-000000000009';
const CHECK = 'c1470000-0000-4000-8000-000000000001'; // $1,000.00, PA fee $100.00
const CHECK_PCT = 'c1470000-0000-4000-8000-000000000002'; // $500.00, PA fee 10%
const CHECK_B = 'c1470000-0000-4000-8000-000000000003'; // tenant B's
const ACCT_A = 'd1470000-0000-4000-8000-000000000001';
const ACCT_B = 'd1470000-0000-4000-8000-000000000002';

const AUTH_UID = sliceFrom('aws/identity/sql/02_auth_uid_guc.sql', 'CREATE OR REPLACE FUNCTION auth.uid()', '$$;');
const AWS_IS_AUTHENTICATED = sliceFrom('aws/rls/sql/20_write_helpers.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_authenticated()', '$$;');
const RECOMPUTE = sliceFrom('supabase/migrations/20260803184659_6c94c093-9fa2-433e-83cb-7db3f0c49cb8.sql',
  'CREATE OR REPLACE FUNCTION public.recompute_check_release_stage(_check_id uuid)', '$$;');
const STAGE_TRIGGERS = [
  sliceFrom('supabase/migrations/20260730174333_193af29a-720d-45e8-a9f8-0153e381c08e.sql',
    'CREATE OR REPLACE FUNCTION public.advance_check_stage_on_batch_complete()', '$$;'),
  sliceFrom('supabase/migrations/20260730174333_193af29a-720d-45e8-a9f8-0153e381c08e.sql',
    'CREATE OR REPLACE FUNCTION public.advance_check_stage_on_disbursement()', '$$;'),
];

const SCHEMA = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE other_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE plain LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
GRANT authenticated TO checksops;
CREATE SCHEMA auth;
${AUTH_UID}
GRANT USAGE ON SCHEMA auth TO checksops_admin, other_admin, checksops, authenticated, plain;
GRANT EXECUTE ON FUNCTION auth.uid() TO checksops_admin, checksops, authenticated;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin, other_admin;
GRANT USAGE ON SCHEMA public TO checksops, authenticated, plain;
SET ROLE checksops_admin;
CREATE TYPE public.check_stage AS ENUM ('review', 'loss_draft', 'endorsing', 'ready_for_deposit', 'deposited',
  'funds_released', 'disbursed_externally', 'returned');
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
  UNIQUE (tenant_id, user_id));
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, amount numeric, pa_fee_pct numeric, pa_fee_amount numeric,
  check_stage public.check_stage, updated_at timestamptz DEFAULT now());
CREATE TABLE public.claim_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, check_stage public.check_stage,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.stakeholder_accounts (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nickname text);
CREATE TABLE public.check_stakeholders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid NOT NULL, tenant_id uuid NOT NULL,
  stakeholder_account_id uuid NOT NULL, partner_tenant_id uuid);
CREATE TABLE public.disbursement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  deposit_item_id uuid, created_by uuid NOT NULL, check_amount numeric NOT NULL, available_amount numeric NOT NULL,
  reserve_held numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'submitted', 'completed', 'failed', 'cancelled', 'partial')),
  rail text NOT NULL DEFAULT 'actum', notes text, completed_at timestamptz, approved_at timestamptz, approved_by uuid,
  approved_amount_cents bigint, delivery_speed text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.disbursement_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES public.disbursement_batches(id),
  tenant_id uuid NOT NULL, stakeholder_account_id uuid, amount numeric NOT NULL, pct_of_total numeric,
  status text NOT NULL DEFAULT 'pending', rail text NOT NULL DEFAULT 'actum',
  method text NOT NULL DEFAULT 'actum',
  external_check_number text, recipient_name text, recipient_type text, external_notes text, idempotence_key text,
  settled_at timestamptz, submitted_at timestamptz, recipient_tenant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.disbursement_splits ADD CONSTRAINT disbursement_splits_method_check CHECK (method = ANY (ARRAY['actum'::text,'plaid'::text,'external_check'::text,'wire'::text,'manual'::text]));
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_id uuid, leg_role text,
  status text NOT NULL, amount_cents bigint NOT NULL, provider text DEFAULT 'moov');
${AWS_IS_AUTHENTICATED}
${SQL90_WRITE_HELPERS}
${RECOMPUTE}
${STAGE_TRIGGERS.join('\n')}
CREATE TRIGGER trg_advance_stage_on_batch_complete AFTER INSERT OR UPDATE OF status ON public.disbursement_batches
  FOR EACH ROW EXECUTE FUNCTION public.advance_check_stage_on_batch_complete();
CREATE TRIGGER trg_advance_stage_on_disbursement AFTER INSERT OR UPDATE ON public.disbursement_splits
  FOR EACH ROW EXECUTE FUNCTION public.advance_check_stage_on_disbursement();
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_users', 'check_intake_items', 'claim_checks', 'stakeholder_accounts',
    'check_stakeholders', 'disbursement_batches', 'disbursement_splits', 'payment_transfers'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO checksops, authenticated, other_admin', t);
  END LOOP;
END
$rls$;
CREATE POLICY member_read ON public.disbursement_batches FOR SELECT TO authenticated USING (public.aws_can_write_tenant(tenant_id));
CREATE POLICY member_read ON public.disbursement_splits FOR SELECT TO authenticated USING (public.aws_can_write_tenant(tenant_id));
CREATE POLICY member_read ON public.check_intake_items FOR SELECT TO authenticated USING (public.aws_can_write_tenant(tenant_id));
CREATE POLICY member_read ON public.payment_transfers FOR SELECT TO authenticated USING (public.aws_can_write_tenant(tenant_id));
INSERT INTO public.tenants VALUES ('${T_A}', 'A'), ('${T_B}', 'B');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${T_A}', '${MEMBER_A}', 'admin'), ('${T_B}', '${MEMBER_B}', 'admin');
INSERT INTO public.check_intake_items (id, tenant_id, amount, pa_fee_amount, check_stage) VALUES
  ('${CHECK}', '${T_A}', 1000.00, 100.00, 'deposited');
INSERT INTO public.check_intake_items (id, tenant_id, amount, pa_fee_pct, check_stage) VALUES
  ('${CHECK_PCT}', '${T_A}', 500.00, 10, 'deposited'), ('${CHECK_B}', '${T_B}', 800.00, NULL, 'deposited');
INSERT INTO public.claim_checks (check_intake_item_id, check_stage) VALUES ('${CHECK}', 'deposited');
INSERT INTO public.stakeholder_accounts VALUES ('${ACCT_A}', '${T_A}', 'Acme Roofing'), ('${ACCT_B}', '${T_B}', 'B Vendor');
-- Already out of the check: a $100.00 settled payment, a failed $70.00 one (ignored), a completed $200.00 Moov send
-- leg and a failed $50.00 leg (ignored). Available: 1000 - 100 fee - 100 - 200 = 600.00.
INSERT INTO public.disbursement_batches (id, tenant_id, check_intake_item_id, created_by, check_amount, available_amount, status)
  VALUES ('b1470000-0000-4000-8000-000000000001', '${T_A}', '${CHECK}', '${MEMBER_A}', 1000, 900, 'completed');
INSERT INTO public.disbursement_splits (batch_id, tenant_id, amount, status, method) VALUES
  ('b1470000-0000-4000-8000-000000000001', '${T_A}', 100.00, 'settled', 'actum'),
  ('b1470000-0000-4000-8000-000000000001', '${T_A}', 70.00, 'failed', 'actum');
INSERT INTO public.payment_transfers (tenant_id, check_id, leg_role, status, amount_cents) VALUES
  ('${T_A}', '${CHECK}', 'send_wallet', 'completed', 20000),
  ('${T_A}', '${CHECK}', 'send_bank', 'failed', 5000);
RESET ROLE;
`;

const payment = (cents, extra = {}) => ({
  amount_cents: cents, recipient_name: 'ABC Roofing', recipient_type: 'subcontractor',
  external_check_number: '10045', memo: 'Paid by paper check', ...extra,
});

test('SQL 147: an outside payment is recorded like a sent payment, within what is left on the check (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('sql147-', 54700);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  const clients = [admin];
  try {
    await admin.query(SCHEMA);
    const owner = await connect('checksops_admin');
    clients.push(owner);
    const fileText = fs.readFileSync(SQL147, 'utf8');

    // A login that does not own the tables cannot install the DEFINER.
    const other = await connect('other_admin');
    clients.push(other);
    await assert.rejects(other.query(fileText), /sql147_definer_cannot_write/);

    await owner.query(fileText);
    await owner.query(fileText); // re-runnable

    const api = await connect('checksops');
    const api2 = await connect('checksops');
    clients.push(api, api2);

    /** One API request: the route's code in its own transaction, as withIdentity runs it. */
    const record = async (client, user, body) => {
      await client.query('BEGIN');
      if (user) await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
      let result;
      try {
        result = await runRecordExternalDisbursement({ client, body, spoof: {} });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    };
    const counts = async () => (await admin.query(`SELECT
      (SELECT count(*)::int FROM public.disbursement_batches) AS batches,
      (SELECT count(*)::int FROM public.disbursement_splits) AS splits,
      (SELECT count(*)::int FROM public.payment_transfers) AS transfers`)).rows[0];
    const body = (key, payments, extra = {}) => ({ tenant_id: T_A, check_intake_item_id: CHECK, idempotency_key: key, payments, ...extra });
    const before = await counts();

    // Recorded: $400.00 of the $600.00 left.
    const first = await record(api, MEMBER_A, body('key-first-0001', [payment(40000)]));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.duplicate, false);
    assert.equal(first.total_cents, 40000);
    assert.equal(first.remaining_cents, 20000);
    assert.equal(first.fully_disbursed, false);
    assert.equal(first.moneyMoved, false);
    const batch = (await admin.query('SELECT * FROM public.disbursement_batches WHERE id = $1', [first.batch_id])).rows[0];
    assert.equal(batch.tenant_id, T_A);
    assert.equal(batch.check_intake_item_id, CHECK);
    assert.equal(batch.status, 'completed');
    assert.equal(batch.created_by, MEMBER_A);
    assert.equal(batch.approved_by, MEMBER_A);
    assert.equal(Number(batch.approved_amount_cents), 40000);
    assert.ok(batch.completed_at && batch.approved_at);
    assert.match(batch.notes, /^Recorded outside ChecksOps \(no money moved by ChecksOps\): check #10045 to ABC Roofing$/);
    const split = (await admin.query('SELECT * FROM public.disbursement_splits WHERE batch_id = $1', [first.batch_id])).rows;
    assert.equal(split.length, 1);
    assert.equal(Number(split[0].amount), 400);
    assert.equal(split[0].status, 'settled');
    assert.equal(split[0].method, 'external_check');
    assert.equal(split[0].external_check_number, '10045');
    assert.equal(split[0].recipient_name, 'ABC Roofing');
    assert.equal(split[0].recipient_type, 'subcontractor');
    assert.equal(split[0].external_notes, 'Paid by paper check');
    assert.equal(split[0].idempotence_key, 'external:key-first-0001:00');
    assert.ok(split[0].settled_at);
    assert.deepEqual(first.split_ids, [split[0].id]);
    // The database's own rule for settled payouts moves the check (and its claim row) to Funds Released.
    assert.equal((await admin.query('SELECT check_stage FROM public.check_intake_items WHERE id = $1', [CHECK])).rows[0].check_stage, 'funds_released');
    assert.equal((await admin.query('SELECT check_stage FROM public.claim_checks WHERE check_intake_item_id = $1', [CHECK])).rows[0].check_stage, 'funds_released');
    // No provider transfer row: nothing moved at Moov.
    assert.equal((await counts()).transfers, before.transfers);

    // The same click again (same key, same payment): nothing new.
    const again = await record(api, MEMBER_A, body('key-first-0001', [payment(40000)]));
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.batch_id, first.batch_id);
    assert.deepEqual(again.split_ids, first.split_ids);
    assert.deepEqual(await counts(), { ...before, batches: before.batches + 1, splits: before.splits + 1 });

    // The key with another payment is refused.
    const reused = await record(api, MEMBER_A, body('key-first-0001', [payment(30000)]));
    assert.equal(reused.statusCode, 409);
    assert.equal(reused.error, 'idempotency_key_reused');

    // More than is left ($200.00) is refused and nothing is written.
    const over = await record(api, MEMBER_A, body('key-over-0001', [payment(20001)]));
    assert.equal(over.statusCode, 409);
    assert.equal(over.error, 'amount_exceeds_available');
    assert.equal(over.available_cents, 20000);
    assert.match(over.message, /\$200\.00 available/);
    assert.deepEqual(await counts(), { ...before, batches: before.batches + 1, splits: before.splits + 1 });

    // Two records racing for the same check: the check lock lets only what fits through.
    await api.query('BEGIN');
    await api.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
    const held = await runRecordExternalDisbursement({ client: api, body: body('key-race-0001', [payment(15000)]), spoof: {} });
    assert.equal(held.ok, true);
    const racing = record(api2, MEMBER_A, body('key-race-0002', [payment(15000)]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await api.query('COMMIT');
    const raced = await racing;
    assert.equal(raced.statusCode, 409);
    assert.equal(raced.error, 'amount_exceeds_available');
    assert.equal(raced.available_cents, 5000);

    // The rest, to a stakeholder account of the tenant (its nickname is the recipient): fully disbursed.
    const last = await record(api, MEMBER_A, body('key-last-0001', [{ amount_cents: 5000, stakeholder_account_id: ACCT_A, external_check_number: '10046' }]));
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.equal(last.remaining_cents, 0);
    assert.equal(last.fully_disbursed, true);
    const lastSplit = (await admin.query('SELECT * FROM public.disbursement_splits WHERE batch_id = $1', [last.batch_id])).rows[0];
    assert.equal(lastSplit.stakeholder_account_id, ACCT_A);
    assert.equal(lastSplit.recipient_name, 'Acme Roofing');
    const zero = await record(api, MEMBER_A, body('key-zero-0001', [payment(1)]));
    assert.equal(zero.error, 'amount_exceeds_available');
    assert.equal(zero.available_cents, 0);

    // A percentage PA fee: $500.00 less 10% leaves $450.00.
    const pct = await record(api, MEMBER_A, { ...body('key-pct-0001', [payment(45001)]), check_intake_item_id: CHECK_PCT });
    assert.equal(pct.error, 'amount_exceeds_available');
    assert.equal(pct.available_cents, 45000);

    // Tenant isolation and the verified sign-in.
    const snapshot = await counts();
    const otherTenantsCheck = await record(api, MEMBER_A, { ...body('key-iso-0001', [payment(100)]), check_intake_item_id: CHECK_B });
    assert.equal(otherTenantsCheck.statusCode, 404);
    assert.equal(otherTenantsCheck.error, 'check_not_found');
    const asOtherTenant = await record(api, MEMBER_B, { ...body('key-iso-0002', [payment(100)]), tenant_id: T_B });
    assert.equal(asOtherTenant.statusCode, 404, 'B names its own tenant on A\'s check');
    const claimsOtherTenant = await record(api, MEMBER_B, body('key-iso-0003', [payment(100)]));
    assert.equal(claimsOtherTenant.statusCode, 403, 'B names tenant A');
    assert.equal(claimsOtherTenant.error, 'cross_tenant_denied');
    const noUser = await record(api, null, body('key-iso-0004', [payment(100)]));
    assert.equal(noUser.statusCode, 403);
    const foreignAccount = await record(api, MEMBER_A, { ...body('key-iso-0005', [{ amount_cents: 100, stakeholder_account_id: ACCT_B }]), check_intake_item_id: CHECK_PCT });
    assert.equal(foreignAccount.statusCode, 400);
    assert.match(foreignAccount.message, /stakeholder_account_id/);
    assert.deepEqual(await counts(), snapshot);

    // The tables stay closed to the API login; only checksops may execute the function.
    await api.query("SELECT set_config('request.app_user_id', $1, false)", [MEMBER_A]);
    await assert.rejects(
      api.query(`INSERT INTO public.disbursement_batches (tenant_id, check_intake_item_id, created_by, check_amount, available_amount)
                 VALUES ($1, $2, $3, 1, 1)`, [T_A, CHECK, MEMBER_A]),
      /permission denied for table disbursement_batches/,
    );
    const plain = await connect('plain');
    clients.push(plain);
    await assert.rejects(
      plain.query("SELECT public.aws_record_external_disbursement($1, $2, '[]'::jsonb, 'key-plain-0001')", [T_A, CHECK]),
      /permission denied for function aws_record_external_disbursement/,
    );
    const acl = (await admin.query(`SELECT r.rolname FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE p.oid = 'public.aws_record_external_disbursement(uuid, uuid, jsonb, text)'::regprocedure ORDER BY 1`)).rows.map((r) => r.rolname);
    assert.deepEqual(acl, ['checksops', 'checksops_admin']);
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    server.stop();
  }
});
