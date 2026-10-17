/**
 * Owner decision (2026-10-17): the platform owner (is_platform_owner(), by
 * email) sets every per-tenant price from Tenant Management; tenant members
 * never change them and only read their own rates. SQL 96 enforces it in the
 * database (PG test: sql90-users-only-tenant-roles-pg.test.mjs); these tests
 * cover the API and SPA sides.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SET_TENANT_PRICING_SQL,
  TENANT_PRICING_COLUMNS,
  canViewTenantBilling,
  saveBillingSettings,
} from '../functions/api/tenant-billing-engine.mjs';
import { handleTenantBillingAdmin } from '../functions/api/tenant-billing-handlers.mjs';
import { feeScheduleCancel, feeScheduleUpsert } from '../functions/api/providers/parity/moov-onboard.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a1000000-0000-4000-8000-000000000001';

const fakeClient = ({ owner = false, member = false, setterError = null } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/is_platform_owner\(\)/.test(text)) return { rows: [{ ok: owner, is_owner: owner }] };
      if (/FROM public\.tenant_users/.test(text)) return { rows: member ? [{ member: 1 }] : [] };
      if (text === SET_TENANT_PRICING_SQL) {
        if (setterError) throw setterError;
        return { rows: [{ result: { ok: true } }] };
      }
      if (/tenant_billing_settings|FROM public\.tenants|tenant_billing_accounts|tenant_billing/.test(text)) return { rows: [] };
      return { rows: [] };
    },
  };
};

test('pricing columns match SQL 96 exactly', () => {
  const sql = read('aws/workflows/sql/96_platform_owner_tenant_pricing.sql');
  const list = sql.match(/aws_tenant_pricing_columns\(\)\nRETURNS text\[\][\s\S]*?ARRAY\[([\s\S]*?)\]::text\[\]/)[1];
  const cols = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...cols].sort(), [...TENANT_PRICING_COLUMNS].sort());
});

test('billing admin: anyone but the platform owner is refused before any write', async () => {
  for (const member of [true, false]) {
    const client = fakeClient({ owner: false, member });
    const res = await handleTenantBillingAdmin({ body: JSON.stringify({ action: 'update', tenant_id: TENANT, monthly_rate_cents: 1 }) },
      { client, mapping: { application_user_id: USER } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.error, 'platform_owner_required');
    assert.equal(client.queries.some((q) => q.sql === SET_TENANT_PRICING_SQL || /UPDATE public\.tenants/.test(q.sql)), false);
  }
  // The check is is_platform_owner() (by email), not a global user_roles admin.
  assert.doesNotMatch(read('aws/functions/api/tenant-billing-handlers.mjs'), /user_roles|has_role|'admin'/);
});

test('saveBillingSettings sends only pricing columns to the SQL 96 setter; no direct tenants UPDATE', async () => {
  const client = fakeClient({ owner: true });
  await saveBillingSettings(client, {
    tenantId: TENANT,
    userId: USER,
    monthlyRateCents: 9900,
    referralDiscountCents: '1000',
    perCheckRateCents: 300,
    nextDayRateCents: 75,
    sameDayRateCents: 100,
    mortgageOpsInitialRateCents: 2500,
    mortgageOpsAdditionalRateCents: 1500,
    perCheckBillingEnabled: true,
    isFoundingPartner: false,
  });
  const call = client.queries.find((q) => q.sql === SET_TENANT_PRICING_SQL);
  assert.ok(call);
  assert.equal(call.params[0], TENANT);
  assert.deepEqual(JSON.parse(call.params[1]), {
    monthly_rate_cents: 9900,
    referral_discount_cents: 1000,
    per_check_rate_cents: 300,
    next_day_rate_cents: 75,
    same_day_rate_cents: 100,
    mortgage_ops_initial_rate_cents: 2500,
    mortgage_ops_additional_rate_cents: 1500,
    per_check_billing_enabled: true,
    is_founding_partner: false,
  });
  assert.equal(client.queries.some((q) => /UPDATE public\.tenants/.test(q.sql)), false);

  // Bad values never reach the database.
  for (const bad of [{ monthlyRateCents: -1 }, { perCheckRateCents: 1.5 }, { isFoundingPartner: 'yes' }]) {
    const c = fakeClient({ owner: true });
    const res = await saveBillingSettings(c, { tenantId: TENANT, userId: USER, ...bad });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(c.queries.some((q) => q.sql === SET_TENANT_PRICING_SQL), false);
  }
});

test('setter refusals map to API errors; a missing SQL 96 is reported, not silently ignored', async () => {
  const cases = [
    [Object.assign(new Error('function public.aws_platform_owner_set_tenant_pricing(uuid, jsonb) does not exist'), { code: '42883' }), 503, 'pricing_setter_missing'],
    [Object.assign(new Error('not_authorized: platform owner required'), { code: '42501' }), 403, 'platform_owner_required'],
    [Object.assign(new Error('column_not_present'), { code: '22023', detail: 'next_day_rate_cents' }), 400, 'column_not_present'],
    [Object.assign(new Error('tenant_not_found'), { code: 'P0002' }), 404, 'tenant_not_found'],
  ];
  for (const [error, statusCode, code] of cases) {
    const res = await saveBillingSettings(fakeClient({ owner: true, setterError: error }), { tenantId: TENANT, userId: USER, nextDayRateCents: 10 });
    assert.equal(res.ok, false);
    assert.equal(res.statusCode, statusCode, code);
    assert.equal(res.error, code);
  }
});

test('members read their own rates (any role value); other tenants do not', async () => {
  assert.equal(await canViewTenantBilling(fakeClient({ member: true }), USER, TENANT), true);
  assert.equal(await canViewTenantBilling(fakeClient({ member: false }), USER, TENANT), false);
  assert.equal(await canViewTenantBilling(fakeClient({ owner: true }), USER, TENANT), true);
});

test('Moov fee schedules: platform owner only; members and other tenants refused before any provider call', async () => {
  for (const handler of [feeScheduleUpsert, feeScheduleCancel]) {
    assert.equal(handler.platformOwnerOnly, true);
    const client = fakeClient();
    let fetched = false;
    const res = await handler.run({
      client, body: { amount_cents: 100, fee_code: 'platform_fees', schedule_id: 'x' },
      ctx: { tenantId: TENANT, isPlatformOwner: false }, fetchImpl: async () => { fetched = true; return {}; },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(client.queries.length, 0);
    assert.equal(fetched, false);
    const noTenant = await handler.run({ client, body: {}, ctx: { tenantId: null, isPlatformOwner: true }, fetchImpl: async () => ({}) });
    assert.equal(noTenant.statusCode, 400);
  }
  // The browser cannot set ChecksOps' payout fee.
  assert.doesNotMatch(read('aws/functions/api/providers/parity/moov-money.mjs'), /body\.platform_fee_cents/);
});

test('SPA: Tenant Management saves pricing through tenant-billing-admin; tenant screens are read-only', () => {
  const lib = read('src/lib/tenantPricing.ts');
  assert.match(lib, /tenant-billing-admin/);
  assert.match(lib, /action: "update"/);
  const admin = read('src/pages/admin/AdminTenants.tsx');
  assert.match(admin, /saveTenantPricing\(/);
  // No pricing column goes through the generic tenants update any more.
  for (const col of ['per_check_rate_cents: rate', 'updateTenant(t.id, { monthly_rate_cents', 'is_founding_partner: true, monthly_rate_cents: 7500 }']) {
    assert.equal(admin.includes(`updateTenant(t.id, { ${col}`) || admin.includes(`save({ per_check_billing_enabled: enabled, ${col}`), false, col);
  }
  const panel = read('src/components/payments/PlatformFeeSchedulePanel.tsx');
  assert.match(panel, /const canEdit = isPlatformOwner\(/);
  assert.match(panel, /\{canEdit && \(/);
});
