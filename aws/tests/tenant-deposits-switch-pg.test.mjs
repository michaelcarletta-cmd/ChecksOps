/**
 * The per-tenant deposits switch (owner decision 2026-10-17, option 2) against
 * PostgreSQL 16 with the real SQL 29 / 30, SQL 90, SQL 93, SQL 96 and SQL 98
 * files on the release fixture (helpers/release-sql-pg.mjs: production-shaped
 * ownership, checksops as the API login in role authenticated):
 *   - tenants.deposits_enabled NOT NULL DEFAULT true: existing and new tenants on;
 *   - a member, a partner (another tenant's member) and a direct UPDATE by the
 *     platform owner cannot change it; only the platform owner's setter can,
 *     and every change is audited in tenant_pricing_audit (old, new, actor);
 *   - SQL 96 pricing still works for the platform owner, branding for members;
 *   - deposit_action prepare_deposit / assign_provider / mark_manual_deposit
 *     and the provider deposit gate refuse with deposits_disabled when off,
 *     with no side effects, fail closed when the flag cannot be read, and
 *     behave as before when on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CHECK_A, MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture,
} from './helpers/release-sql-pg.mjs';
import { AWS_ROOT } from './helpers/stakeholder-policies-pg.mjs';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import { DEPOSITS_DISABLED, DEPOSITS_DISABLED_MESSAGE, gateProviderDeposit } from '../functions/api/tenant-deposits-gate.mjs';

const sql = (name) => fs.readFileSync(path.join(AWS_ROOT, 'workflows/sql', name), 'utf8');
const CHECK_A2 = '55555555-5555-4555-8555-555555555556';
const ITEM_A = '77777777-7777-4777-8777-777777777771';

/** What SQL 98's other sections need, plus the deposit pipeline columns deposit_action writes. */
const EXTRA = `
ALTER TABLE public.tenants ADD COLUMN per_check_billing_enabled boolean DEFAULT false,
  ADD COLUMN per_check_rate_cents integer DEFAULT 0, ADD COLUMN monthly_rate_cents integer;
CREATE TABLE public.check_billing_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price_per_check_cents integer NOT NULL DEFAULT 300,
  currency text NOT NULL DEFAULT 'usd', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid, payment_transfer_id uuid,
  event_type text NOT NULL DEFAULT 'check_processing', unit_price_cents integer NOT NULL, currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'recorded', billed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.tenant_maintenance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, amount_cents integer NOT NULL, billing_period text);
ALTER TABLE public.check_intake_items ADD COLUMN amount numeric, ADD COLUMN check_number text, ADD COLUMN carrier_name text,
  ADD COLUMN check_stage text, ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE public.deposit_items ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ADD COLUMN check_number text, ADD COLUMN carrier_name text, ADD COLUMN claim_id uuid, ADD COLUMN provider public.deposit_provider,
  ADD COLUMN cleared_at timestamptz, ADD COLUMN deposit_slip_number text, ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE public.deposit_batches ADD COLUMN cleared_amount numeric NOT NULL DEFAULT 0;
CREATE TABLE public.deposit_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deposit_item_id uuid, batch_id uuid, action text, actor_id uuid,
  amount numeric, notes text, new_values jsonb, created_at timestamptz DEFAULT now());
-- Stand-ins for the live member write policies on the deposit pipeline (not under test here).
CREATE POLICY test_member_update_checks ON public.check_intake_items FOR UPDATE TO authenticated
  USING (public.aws_is_tenant_member(tenant_id)) WITH CHECK (public.aws_is_tenant_member(tenant_id));
GRANT SELECT, UPDATE ON public.check_intake_items TO checksops;
GRANT SELECT, INSERT, UPDATE ON public.deposit_items, public.deposit_audit_log, public.deposit_batches TO checksops;
GRANT SELECT ON public.deposit_provider_config TO checksops;
INSERT INTO public.deposit_provider_config (provider, display_name, is_active) VALUES ('checkalt', 'Check Alt', true);
`;

const OWN_NEW = `
DO $own$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS o FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO checksops_admin', r.o);
  END LOOP;
END $own$;`;

test('PostgreSQL 16: the deposits switch is platform-owner only, audited, and refuses every deposit_action path when off', {
  timeout: 240000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const fx = await releaseFixture(pg, 'pg-deposits-switch-', 58950);
  let api = null;
  try {
    const { admin, connectAs, applyPredecessors } = fx;
    await applyPredecessors();
    const owner = await connectAs('checksops_admin');
    try {
      for (const file of ['90_users_only_tenant_roles.sql', '93_tenant_company_info.sql', '96_platform_owner_tenant_pricing.sql']) {
        await owner.query(sql(file));
      }
    } finally {
      await owner.end();
    }
    await admin.query(EXTRA);
    await admin.query(OWN_NEW);
    const owner98 = await connectAs('checksops_admin');
    try {
      await owner98.query(sql('98_tenant_fee_collection.sql'));
      await owner98.query(sql('98_tenant_fee_collection.sql'));
    } finally {
      await owner98.end();
    }

    // 1) Existing tenants are on (ADD COLUMN ... NOT NULL DEFAULT true, no backfill); new tenants default on.
    assert.deepEqual((await admin.query('SELECT id, deposits_enabled FROM public.tenants ORDER BY id')).rows,
      [{ id: TENANT_A, deposits_enabled: true }, { id: TENANT_B, deposits_enabled: true }]);
    const col = (await admin.query(`SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'deposits_enabled'`)).rows[0];
    assert.deepEqual(col, { is_nullable: 'NO', column_default: 'true' });
    await admin.query("INSERT INTO public.tenants (id, name) VALUES ('99999999-9999-4999-8999-999999999999', 'New')");
    assert.equal((await admin.query("SELECT deposits_enabled FROM public.tenants WHERE id = '99999999-9999-4999-8999-999999999999'")).rows[0].deposits_enabled, true);
    await admin.query("DELETE FROM public.tenants WHERE id = '99999999-9999-4999-8999-999999999999'");
    // per_check_billing_enabled is untouched (still its own default false).
    assert.equal((await admin.query('SELECT per_check_billing_enabled FROM public.tenants WHERE id = $1', [TENANT_A])).rows[0].per_check_billing_enabled, false);

    api = await connectAs('checksops');
    const as = async (user, fn) => {
      await api.query('BEGIN');
      try {
        await api.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await api.query('COMMIT');
        return out;
      } catch (error) {
        await api.query('ROLLBACK');
        throw error;
      }
    };
    const flag = async () => (await admin.query('SELECT deposits_enabled FROM public.tenants WHERE id = $1', [TENANT_A])).rows[0].deposits_enabled;

    // 2) Member of the tenant: a direct write is refused by the column guard; the setter refuses too.
    await assert.rejects(as(MEMBER_A, () => api.query('UPDATE public.tenants SET deposits_enabled = false WHERE id = $1', [TENANT_A])),
      (e) => e.code === '42501' && /tenant_column_not_member_writable: deposits_enabled/.test(e.message));
    await assert.rejects(as(MEMBER_A, () => api.query('SELECT public.aws_platform_owner_set_tenant_deposits_enabled($1, false)', [TENANT_A])),
      (e) => e.code === '42501');
    // ... while the member's own branding writes still work.
    await as(MEMBER_A, () => api.query("UPDATE public.tenants SET name = 'A renamed' WHERE id = $1", [TENANT_A]));
    // 3) Partner (a member of another tenant): no row to update, and the setter refuses.
    const partner = await as(MEMBER_B, () => api.query('UPDATE public.tenants SET deposits_enabled = false WHERE id = $1', [TENANT_A]));
    assert.equal(partner.rowCount, 0);
    await assert.rejects(as(MEMBER_B, () => api.query('SELECT public.aws_platform_owner_set_tenant_deposits_enabled($1, false)', [TENANT_A])),
      (e) => e.code === '42501');
    // 4) The platform owner's direct UPDATE matches no row (SQL 90); only the setter writes.
    const direct = await as(PLATFORM_OWNER, () => api.query('UPDATE public.tenants SET deposits_enabled = false WHERE id = $1', [TENANT_A]));
    assert.equal(direct.rowCount, 0);
    assert.equal(await flag(), true);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM public.tenant_pricing_audit WHERE field = 'deposits_enabled'")).rows[0].n, 0);
    const set = await as(PLATFORM_OWNER, () => api.query('SELECT public.aws_platform_owner_set_tenant_deposits_enabled($1, false) AS r', [TENANT_A]));
    assert.deepEqual(set.rows[0].r, { ok: true, tenant_id: TENANT_A, deposits_enabled: false });
    assert.equal(await flag(), false);
    const audit = (await admin.query("SELECT tenant_id, actor_id, old_value, new_value FROM public.tenant_pricing_audit WHERE field = 'deposits_enabled'")).rows;
    assert.deepEqual(audit, [{ tenant_id: TENANT_A, actor_id: PLATFORM_OWNER, old_value: true, new_value: false }]);
    await assert.rejects(as(PLATFORM_OWNER, () => api.query("SELECT public.aws_platform_owner_set_tenant_deposits_enabled('99999999-9999-4999-8999-999999999999', true)")),
      (e) => e.code === 'P0002');
    // SQL 96 pricing still works for the platform owner after SQL 98's guard replacement.
    await as(PLATFORM_OWNER, () => api.query(`SELECT public.aws_platform_owner_set_tenant_pricing($1, '{"monthly_rate_cents": 9900}'::jsonb)`, [TENANT_A]));
    assert.equal((await admin.query('SELECT monthly_rate_cents FROM public.tenants WHERE id = $1', [TENANT_A])).rows[0].monthly_rate_cents, 9900);
    // The SQL 96 pricing setter does not take the switch (it is not a pricing column).
    await assert.rejects(as(PLATFORM_OWNER, () => api.query(`SELECT public.aws_platform_owner_set_tenant_pricing($1, '{"deposits_enabled": true}'::jsonb)`, [TENANT_A])),
      (e) => e.code === '22023' && /invalid_field/.test(e.message));
    // The reader every deposit path uses: the flag, or NULL for no such tenant.
    assert.equal((await as(MEMBER_A, () => api.query('SELECT public.aws_tenant_deposits_enabled($1) AS v', [TENANT_A]))).rows[0].v, false);
    assert.equal((await as(MEMBER_A, () => api.query("SELECT public.aws_tenant_deposits_enabled('99999999-9999-4999-8999-999999999999') AS v"))).rows[0].v, null);

    // 5) deposit_action with deposits off: every action refused, nothing written.
    await admin.query(`UPDATE public.check_intake_items SET status = 'approved_for_deposit', amount = 125.00 WHERE id = $1`, [CHECK_A]);
    await admin.query(`INSERT INTO public.check_intake_items (id, tenant_id, status, amount) VALUES ($1, $2, 'approved_for_deposit', 50.00)`, [CHECK_A2, TENANT_A]);
    await admin.query(`INSERT INTO public.deposit_items (id, check_id, amount, status) VALUES ($1, $2, 50.00, 'pending_assignment')`, [ITEM_A, CHECK_A2]);
    const rpc = (user, args) => as(user, () => executeSafeWriteRpc({ client: api, mapping: { application_user_id: user }, name: 'deposit_action', args }));
    const snapshot = async () => (await admin.query(`SELECT
      (SELECT count(*)::int FROM public.deposit_items) AS items,
      (SELECT count(*)::int FROM public.deposit_audit_log) AS audit,
      (SELECT count(*)::int FROM public.deposit_batches) AS batches,
      (SELECT string_agg(id::text || ':' || coalesce(status, ''), ',' ORDER BY id) FROM public.check_intake_items) AS checks,
      (SELECT string_agg(id::text || ':' || coalesce(status, '') || ':' || coalesce(provider::text, ''), ',' ORDER BY id) FROM public.deposit_items) AS item_states`)).rows[0];
    const before = await snapshot();
    for (const args of [
      { p_action: 'prepare_deposit', p_check_id: CHECK_A },
      { p_action: 'assign_provider', p_deposit_item_id: ITEM_A, p_provider: 'checkalt' },
      { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_A },
    ]) {
      const res = await rpc(MEMBER_A, args);
      assert.equal(res.error, DEPOSITS_DISABLED, `${args.p_action}: ${JSON.stringify(res)}`);
      assert.equal(res.message, DEPOSITS_DISABLED_MESSAGE, args.p_action);
    }
    assert.deepEqual(await snapshot(), before, 'no deposit item, audit row, batch or status change');

    // The provider deposit gate (providers.mjs) refuses the same tenant's Check Alt submit, before any handler.
    const gate = (body) => as(MEMBER_A, () => gateProviderDeposit('checkalt-submit-deposit', body, (fn) => fn({ client: api })));
    const refusedSubmit = await gate({ check_intake_item_id: CHECK_A });
    assert.equal(refusedSubmit.error, DEPOSITS_DISABLED);
    assert.equal(refusedSubmit.liveProviderCalled, false);
    // A partner cannot even resolve the check (RLS), so the handler's own refusal applies.
    assert.equal(await as(MEMBER_B, () => gateProviderDeposit('checkalt-submit-deposit', { check_intake_item_id: CHECK_A }, (fn) => fn({ client: api }))), null);

    // 6) A failed read fails closed (here: the reader is gone), with no side effects.
    await api.query('BEGIN');
    await api.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
    await admin.query('ALTER FUNCTION public.aws_tenant_deposits_enabled(uuid) RENAME TO aws_tenant_deposits_enabled_gone');
    try {
      const unreadable = await executeSafeWriteRpc({ client: api, mapping: { application_user_id: MEMBER_A }, name: 'deposit_action', args: { p_action: 'prepare_deposit', p_check_id: CHECK_A } });
      assert.equal(unreadable.error, 'deposits_status_unavailable');
      assert.equal(unreadable.statusCode, 503);
      const unreadableGate = await gateProviderDeposit('checkalt-submit-deposit', { check_intake_item_id: CHECK_A }, (fn) => fn({ client: api }));
      assert.equal(unreadableGate.error, 'deposits_status_unavailable');
    } finally {
      await api.query('ROLLBACK');
      await admin.query('ALTER FUNCTION public.aws_tenant_deposits_enabled_gone(uuid) RENAME TO aws_tenant_deposits_enabled');
    }
    assert.deepEqual(await snapshot(), before);

    // 7) Back on: the same actions behave exactly as before the switch existed.
    await as(PLATFORM_OWNER, () => api.query('SELECT public.aws_platform_owner_set_tenant_deposits_enabled($1, true)', [TENANT_A]));
    assert.deepEqual((await admin.query("SELECT old_value, new_value FROM public.tenant_pricing_audit WHERE field = 'deposits_enabled' ORDER BY created_at")).rows,
      [{ old_value: true, new_value: false }, { old_value: false, new_value: true }]);
    const prepared = await rpc(MEMBER_A, { p_action: 'prepare_deposit', p_check_id: CHECK_A });
    assert.equal(prepared.data?.success, true, JSON.stringify(prepared));
    const manual = await rpc(MEMBER_A, { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_A });
    assert.equal(manual.data?.success, true, JSON.stringify(manual));
    assert.equal((await admin.query('SELECT status FROM public.check_intake_items WHERE id = $1', [CHECK_A2])).rows[0].status, 'deposited');
    assert.equal(await as(MEMBER_A, () => gateProviderDeposit('checkalt-submit-deposit', { check_intake_item_id: CHECK_A }, (fn) => fn({ client: api }))), null);
  } finally {
    await api?.end().catch(() => {});
    await fx.close();
  }
});
