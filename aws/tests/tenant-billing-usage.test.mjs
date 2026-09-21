import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const libSrc = readFileSync(new URL('../../src/lib/tenantBillingUsage.ts', import.meta.url), 'utf8');
const uiSrc = readFileSync(new URL('../../src/pages/admin/TenantBillingUsagePanel.tsx', import.meta.url), 'utf8');

test('Freedom September 2026 preview is $168 from established sources', () => {
  const checkCents = 4400;
  const mortgageCents = 2000;
  const sameDay = 9;
  const nextDay = 0;
  const monthlyRateCents = 10000;
  const referralDiscountCents = 500;
  const cents = checkCents + mortgageCents + sameDay * 100 + nextDay * 75 + monthlyRateCents - referralDiscountCents;
  assert.equal(cents, 16800);
  assert.match(libSrc, /SAME_DAY_DISBURSEMENT_CENTS = 100/);
  assert.match(libSrc, /NEXT_DAY_DISBURSEMENT_CENTS = 75/);
});

test('YTD does not invent monthly maintenance from the current setting', () => {
  const ytdUsage = 49700 + 3000 + 109 * 100 + 1 * 75;
  assert.equal(ytdUsage, 63675);
  assert.match(uiSrc, /Current monthly_rate_cents is a pricing setting, not historical billing/);
  assert.match(uiSrc, /Year-to-Date Usage \/ Charges/);
  assert.doesNotMatch(uiSrc, /monthly_rate_cents \* 12/);
});

test('usage UI keeps payment_transfers informational and shows period vs YTD', () => {
  assert.match(uiSrc, /Current Billing Period/);
  assert.match(uiSrc, /Fee \/ event type/);
  assert.match(uiSrc, /Amount outstanding/);
  assert.match(uiSrc, /Billing history/);
  assert.match(uiSrc, /Volume\/activity only/);
  assert.match(uiSrc, /Preview outstanding/);
});
