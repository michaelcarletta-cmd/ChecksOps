/**
 * Owner decisions (2026-10-22): when another company uses a tenant's referral code,
 * that tenant gets $5.00 off its monthly maintenance for that referral, every month,
 * at most $25.00 a month; the credit is added to the discount the platform owner sets
 * by hand; the total never exceeds the monthly rate, so maintenance never goes below
 * $0.00 and usage fees are never reduced. SQL 111 computes the credit
 * (aws_tenant_referral_credit_cents, PG test sql111-tenant-referral-codes-pg.test.mjs);
 * these tests cover the billing engine that applies it (ops/production-sql-111-apply.md
 * has the worked table this mirrors).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assembleInvoiceTotals,
  evaluateBillingReadiness,
  invoiceSummaryLines,
  loadTenantBillingContext,
  maintenanceDiscountCents,
  netFeeCents,
} from '../functions/api/tenant-billing-engine.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CREDIT_SQL = 'SELECT public.aws_tenant_referral_credit_cents($1::uuid) AS referral_credit_cents';
const creditFor = (referrals) => Math.min(2500, 500 * referrals);

test('maintenance discount: referral credit plus the hand-set discount, never above the monthly rate (the runbook table)', () => {
  // [referrals, hand-set, rate, discount, maintenance charged]
  const rows = [
    [0, 0, 9900, 0, 9900],
    [1, 0, 9900, 500, 9400],
    [3, 0, 9900, 1500, 8400],
    [5, 0, 9900, 2500, 7400],
    [8, 0, 9900, 2500, 7400],
    [2, 1000, 9900, 2000, 7900],
    [5, 1000, 9900, 3500, 6400],
    [5, 0, 2000, 2000, 0],
  ];
  for (const [referrals, handSet, rate, discount, charged] of rows) {
    const tenant = { monthly_rate_cents: rate, referral_discount_cents: handSet, referral_credit_cents: creditFor(referrals) };
    assert.equal(maintenanceDiscountCents(tenant), discount, JSON.stringify(tenant));
    assert.equal(netFeeCents(rate, maintenanceDiscountCents(tenant)), charged, JSON.stringify(tenant));
  }
  // Missing or negative inputs never raise the charge above the rate or the discount above it.
  assert.equal(maintenanceDiscountCents({ monthly_rate_cents: 9900 }), 0);
  assert.equal(maintenanceDiscountCents({ monthly_rate_cents: 9900, referral_discount_cents: -500, referral_credit_cents: 1000 }), 1000);
  assert.equal(maintenanceDiscountCents({ monthly_rate_cents: null, referral_discount_cents: 1000, referral_credit_cents: 500 }), 0);
  assert.equal(maintenanceDiscountCents(null), 0);
});

test('the invoice takes the combined discount off maintenance only; usage fees are never reduced', () => {
  const tenant = { monthly_rate_cents: 2000, referral_discount_cents: 1000, referral_credit_cents: 2500 };
  const checks = [{ unit_price_cents: 300 }, { unit_price_cents: 300 }];
  const nextDay = [{ unit_price_cents: 75 }];
  const totals = assembleInvoiceTotals({ tenant, period: '2026-11', checks, nextDay, sameDay: [] });
  assert.equal(totals.maintenance_rate_cents, 2000);
  assert.equal(totals.discount_cents, 2000);
  assert.equal(totals.maintenance_net_cents, 0);
  assert.equal(totals.usage_total_cents, 675);
  assert.equal(totals.amount_cents, 675);
  const discountLine = invoiceSummaryLines({ ok: true, ...totals }).find((line) => line.key === 'referral_discount');
  assert.deepEqual([discountLine.count, discountLine.amount_cents], [1, -2000]);

  const plain = assembleInvoiceTotals({ tenant: { monthly_rate_cents: 9900, referral_discount_cents: 0, referral_credit_cents: 1500 }, period: '2026-11', checks: [], nextDay: [], sameDay: [] });
  assert.deepEqual([plain.discount_cents, plain.maintenance_net_cents, plain.amount_cents], [1500, 8400, 8400]);
});

function fakeClient({ tenant, credit = null, creditError = null } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /.test(sql)) return { rows: [] };
      if (/FROM public\.tenants WHERE id = \$1::uuid/.test(sql)) return { rows: [{ id: TENANT, subscription_status: 'active', ...tenant }] };
      if (sql === CREDIT_SQL) {
        if (creditError) throw creditError;
        return { rows: credit === null ? [] : [{ referral_credit_cents: credit }] };
      }
      return { rows: [] };
    },
  };
}

test('the billing context reads the SQL 111 credit inside a savepoint; a missing or refusing function leaves the hand-set discount alone', async () => {
  const base = { monthly_rate_cents: 9900, referral_discount_cents: 1000 };

  const live = fakeClient({ tenant: base, credit: 1500 });
  const ctx = await loadTenantBillingContext(live, TENANT);
  assert.equal(ctx.ok, true);
  assert.equal(ctx.tenant.referral_credit_cents, 1500);
  assert.equal(maintenanceDiscountCents(ctx.tenant), 2500);
  const call = live.queries.findIndex((q) => q.sql === CREDIT_SQL);
  assert.ok(call > 0);
  assert.deepEqual(live.queries[call].params, [TENANT]);
  assert.equal(live.queries[call - 1].sql, 'SAVEPOINT tenant_referral_credit_read');

  for (const creditError of [
    Object.assign(new Error('function public.aws_tenant_referral_credit_cents(uuid) does not exist'), { code: '42883' }),
    Object.assign(new Error('not_authorized'), { code: '42501' }),
  ]) {
    const client = fakeClient({ tenant: base, creditError });
    const res = await loadTenantBillingContext(client, TENANT);
    assert.equal(res.ok, true, creditError.code);
    assert.equal(res.tenant.referral_credit_cents, 0);
    assert.equal(maintenanceDiscountCents(res.tenant), 1000);
    assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT tenant_referral_credit_read'), creditError.code);
  }
});

test('readiness charges maintenance net of the combined discount and reports both parts', async () => {
  const client = fakeClient({ tenant: { monthly_rate_cents: 9900, referral_discount_cents: 1000 }, credit: 2500 });
  const readiness = await evaluateBillingReadiness(client, { tenantId: TENANT, period: '2026-11', destination: { ok: true }, environment: 'sandbox' });
  assert.equal(readiness.rateCents, 9900);
  assert.equal(readiness.discountCents, 3500);
  assert.equal(readiness.referralCreditCents, 2500);
  assert.equal(readiness.amountCents, 6400);
  assert.equal(readiness.maintenanceNetCents, 6400);
});
