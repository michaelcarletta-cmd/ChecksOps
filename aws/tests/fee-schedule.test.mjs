/**
 * Usage settings page: "Fees you may be charged" lists the tenant's own rates (defaults when blank)
 * and never names a payment or deposit provider. Fixtures only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkProcessingCents, feeScheduleRows } from '../../src/lib/billing/feeSchedule.ts';
import {
  DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS,
  DEFAULT_MORTGAGE_INITIAL_RATE_CENTS,
  DEFAULT_NEXT_DAY_RATE_CENTS,
  DEFAULT_SAME_DAY_RATE_CENTS,
} from '../functions/api/tenant-billing-engine.mjs';

const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.amount_cents]));

test('1 blank rates show the billing engine defaults; the defaults match the engine', () => {
  const rows = byKey(feeScheduleRows({}));
  assert.equal(rows.next_day, DEFAULT_NEXT_DAY_RATE_CENTS);
  assert.equal(rows.same_day, DEFAULT_SAME_DAY_RATE_CENTS);
  assert.equal(rows.mortgage_initial, DEFAULT_MORTGAGE_INITIAL_RATE_CENTS);
  assert.equal(rows.mortgage_additional, DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS);
  assert.equal(rows.check_processing, null);
  assert.equal('monthly' in rows, false);
});

test('2 the tenant\'s own rates win; an explicit 0 is free, not the default', () => {
  const rows = byKey(feeScheduleRows({
    monthly_rate_cents: 10000, referral_discount_cents: 2500, per_check_billing_enabled: true, per_check_rate_cents: 400,
    next_day_rate_cents: 0, same_day_rate_cents: 150, mortgage_ops_initial_rate_cents: 0, mortgage_ops_additional_rate_cents: 300,
  }));
  assert.deepEqual(rows, { monthly: 7500, check_processing: 400, next_day: 0, same_day: 150, mortgage_initial: 0, mortgage_additional: 300 });
});

test('3 per-check billing off: the price on the latest charge, else "set by your plan"', () => {
  assert.equal(checkProcessingCents({ per_check_billing_enabled: false, per_check_rate_cents: 400 }, 300), 300);
  assert.equal(checkProcessingCents({ per_check_billing_enabled: false }, null), null);
  assert.equal(checkProcessingCents({ per_check_billing_enabled: true, per_check_rate_cents: null }, 300), 300);
});

test('4 no provider names on the page; the card is on the usage page', () => {
  for (const row of feeScheduleRows({ monthly_rate_cents: 100 })) {
    assert.doesNotMatch(`${row.fee} ${row.when}`, /moov|check ?alt|actum/i, row.key);
  }
  const card = readFileSync(new URL('../../src/components/billing/FeeScheduleCard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(card, /moov|check ?alt|actum/i);
  assert.match(card, /Fees you may be charged/);
  const page = readFileSync(new URL('../../src/components/billing/TenantUsageTracker.tsx', import.meta.url), 'utf8');
  assert.match(page, /<FeeScheduleCard tenantId=\{tenant\?\.id\} chargedCheckCents=\{chargedCheckCents\} \/>/);
});
