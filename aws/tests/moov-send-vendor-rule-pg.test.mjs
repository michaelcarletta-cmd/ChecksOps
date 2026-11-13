/**
 * The production send handler's vendor rule and its payroll_runs insert, run verbatim against PostgreSQL 16 (the fake
 * DB in moov-production-send.test.mjs mirrors them by hand). On the release fixture with the real SQL 141 and SQL 165
 * applied by the non-superuser owner, as the API login (checksops) for a member of the paying tenant:
 *
 *   - moov-send.mjs's VENDOR_PAYEES_SQL lists the sender's live link with payable true; after the platform owner
 *     unmarks the vendor, after the vendor organization lapses, or after the link is removed, the handler's own rule
 *     (resolveVendorDestination: a listed link with payable true) refuses it;
 *   - the handler's payroll_runs INSERT text (taken from moov-send.mjs) writes a vendor run (stakeholder NULL,
 *     vendor_tenant_id set) and a stakeholder run, under request.financial_execution, inside the paying tenant.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VENDOR_PAYEES_SQL } from '../functions/api/providers/production/moov-send.mjs';
import { MEMBER_A, PLATFORM_OWNER, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { policyBlock } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SQL141 = read('aws/workflows/sql/141_permanent_vendor_payees.sql');
const SQL165 = read('aws/workflows/sql/165_vendor_payee_lookup_and_payroll_vendor.sql');
const SEND = read('aws/functions/api/providers/production/moov-send.mjs');
const PAYROLL_INSERT = (() => {
  const start = SEND.indexOf('INSERT INTO public.payroll_runs');
  const end = SEND.indexOf('`', start);
  assert.ok(start > 0 && end > start, 'payroll_runs insert not found in moov-send.mjs');
  return SEND.slice(start, end);
})();

const VENDOR = '16600000-0000-4000-8000-000000000001';
const STAKEHOLDER_A = '16600000-0000-4000-8000-0000000000a1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS public.tenant_partner_code_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_partner_code_aliases ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  stakeholder_account_id uuid NOT NULL REFERENCES public.stakeholder_accounts(id),
  disbursement_batch_id uuid,
  amount numeric NOT NULL CHECK (amount > 0),
  speed text NOT NULL DEFAULT 'next_day',
  memo text,
  initiated_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payroll_runs TO checksops;
${policyBlock('12_final_select_policies.sql', 'aws_select_payroll_runs')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_payroll_runs')}
INSERT INTO public.tenants (id, name, partner_code, subscription_status) VALUES ('${VENDOR}', 'Acme Supply', 'VEND166', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_A}', 'staff');
INSERT INTO public.stakeholder_accounts (id, tenant_id, name) VALUES ('${STAKEHOLDER_A}', '${TENANT_A}', 'Pat');`;

/** One statement as the API login for an application user (financial: the send's money-write GUC). */
async function asApi(connectAs, user, run, { financial = false } = {}) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    if (financial) await c.query("SELECT set_config('request.financial_execution', '1', true)");
    const value = await run(c);
    await c.query('COMMIT');
    return { value, error: null };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { value: null, error };
  } finally {
    await c.end();
  }
}
const one = (sql, params) => async (c) => (await c.query(sql, params)).rows[0]?.result;
/** The handler's rule: a listed link to this vendor with payable true. */
const payable = (lookup, vendorId) => lookup?.ok === true
  && (lookup.payees || []).some((p) => p.vendor_tenant_id === vendorId && p.payable === true);

test('PostgreSQL 16: the send\'s vendor rule and its payroll_runs insert, verbatim', { timeout: 600000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, 'pg-send-vendor-', 63166, { extra: [SCHEMA] });
  const { connectAs, admin } = fx;
  try {
    const owner = await connectAs('checksops_admin');
    await owner.query(SQL141);
    await owner.query(SQL165);
    await owner.end();
    const lookup = async () => (await asApi(connectAs, MEMBER_A, one(VENDOR_PAYEES_SQL, [TENANT_A]))).value;

    assert.equal(payable(await lookup(), VENDOR), false, 'no link yet');
    assert.equal((await asApi(connectAs, PLATFORM_OWNER, one('SELECT public.aws_platform_owner_set_tenant_vendor($1::uuid, true) AS result', [VENDOR]))).value.ok, true);
    assert.equal((await asApi(connectAs, MEMBER_A, one('SELECT public.aws_vendor_payee_add($1::uuid, $2) AS result', [TENANT_A, 'VEND166']))).value.ok, true);
    assert.equal(payable(await lookup(), VENDOR), true);

    // The payroll_runs insert, as the handler runs it.
    const insert = (stakeholder, vendor) => asApi(connectAs, MEMBER_A, async (c) => (await c.query(`${PAYROLL_INSERT}`, [
      TENANT_A, stakeholder, vendor, '1500.00', 'next_day', 'Payroll', MEMBER_A,
    ])).rows[0].id, { financial: true });
    const vendorRun = await insert(null, VENDOR);
    assert.equal(vendorRun.error, null, String(vendorRun.error));
    const stakeholderRun = await insert(STAKEHOLDER_A, null);
    assert.equal(stakeholderRun.error, null, String(stakeholderRun.error));
    const rows = (await admin.query('SELECT id, stakeholder_account_id, vendor_tenant_id, amount::text, status FROM public.payroll_runs ORDER BY created_at')).rows;
    assert.deepEqual(rows.map((r) => [r.id, r.stakeholder_account_id, r.vendor_tenant_id, r.amount, r.status]), [
      [vendorRun.value, null, VENDOR, '1500.00', 'pending'],
      [stakeholderRun.value, STAKEHOLDER_A, null, '1500.00', 'pending'],
    ]);

    // Unmarked, then lapsed, then removed: refused at once.
    assert.equal((await asApi(connectAs, PLATFORM_OWNER, one('SELECT public.aws_platform_owner_set_tenant_vendor($1::uuid, false) AS result', [VENDOR]))).value.ok, true);
    assert.equal(payable(await lookup(), VENDOR), false, 'no longer a vendor');
    assert.equal((await asApi(connectAs, PLATFORM_OWNER, one('SELECT public.aws_platform_owner_set_tenant_vendor($1::uuid, true) AS result', [VENDOR]))).value.ok, true);
    assert.equal(payable(await lookup(), VENDOR), true);
    await admin.query("UPDATE public.tenants SET subscription_status = 'past_due' WHERE id = $1", [VENDOR]);
    assert.equal(payable(await lookup(), VENDOR), false, 'not active');
    await admin.query("UPDATE public.tenants SET subscription_status = 'active' WHERE id = $1", [VENDOR]);
    assert.equal((await asApi(connectAs, MEMBER_A, one('SELECT public.aws_vendor_payee_remove($1::uuid, $2::uuid) AS result', [TENANT_A, VENDOR]))).value.ok, true);
    assert.equal(payable(await lookup(), VENDOR), false, 'link removed');
  } finally {
    await fx.close();
  }
});
