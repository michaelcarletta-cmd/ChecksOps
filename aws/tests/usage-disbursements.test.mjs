/**
 * Usage page: disbursement fees name their check, insured and payee, and the card shows the
 * amount sent (not funds received). Fixtures only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  disbursementDetails,
  disbursementVolumeCents,
  filterUsageEvents,
  isSendFeeEvent,
  usageCategory,
  usageEventLabel,
} from '../../src/lib/billing/usageDisbursements.ts';

const CHECK = 'c0000000-0000-4000-8000-000000000001';
const CLAIM = '66666666-6666-4666-8666-666666666666';
const leg = (id, amount, status, hash, index, name = 'Pat Payee') => ({
  id, amount_cents: amount, status, check_id: CHECK,
  provider_metadata: { request_hash: hash, recipient_index: index, recipient_name: name },
});

test('1 labels never name a provider', () => {
  assert.equal(usageEventLabel('moov_next_day'), 'Next-day payment');
  assert.equal(usageEventLabel('moov_same_day'), 'Same-day payment');
  assert.equal(usageEventLabel('check_processing'), 'Check processing');
  assert.equal(usageEventLabel('mortgage_handling'), 'Mortgage handling');
  assert.equal(usageEventLabel('moov_something_new'), 'Something new');
  assert.equal(usageEventLabel(null), 'Processing');
  for (const type of ['moov_next_day', 'moov_same_day', 'moov_instant', 'moov_x', 'checkalt_x']) {
    assert.doesNotMatch(usageEventLabel(type), /moov|check ?alt/i, type);
  }
  assert.equal(isSendFeeEvent('moov_same_day'), true);
  assert.equal(isSendFeeEvent('check_processing'), false);
});

test('2 a fee shows its check, claim, insured, payee and the amount sent to that recipient', () => {
  const legs = [
    leg('w0', 4000, 'completed', 'h1', 0),
    leg('b0', 6000, 'pending', 'h1', 0),
    leg('w1', 2500, 'completed', 'h1', 1, 'Lee Lender'),
    leg('x0', 9900, 'failed', 'h1', 0),
  ];
  const events = [
    { id: 'e0', event_type: 'moov_next_day', payment_transfer_id: 'w0', claim_id: CLAIM, status: 'recorded' },
    { id: 'e1', event_type: 'moov_same_day', payment_transfer_id: 'w1', claim_id: null, status: 'recorded' },
    { id: 'e2', event_type: 'check_processing', payment_transfer_id: null, status: 'recorded' },
  ];
  const checks = [{ id: CHECK, check_number: '1234', payee_line: 'JANE INSURED AND BANK', claim_id: CLAIM }];
  const claims = [{ id: CLAIM, claim_number: 'CLM-9', policyholder_name: 'Jane Insured' }];
  const details = disbursementDetails(events, legs, checks, claims);
  assert.deepEqual(details.get('e0'), {
    amount_cents: 10000, check_id: CHECK, check_number: '1234', insured_name: 'Jane Insured',
    claim_number: 'CLM-9', payee_name: 'Pat Payee',
  });
  // Falls back to the check's claim when the event has none.
  assert.equal(details.get('e1').claim_number, 'CLM-9');
  assert.equal(details.get('e1').amount_cents, 2500);
  assert.equal(details.get('e1').payee_name, 'Lee Lender');
  assert.equal(details.has('e2'), false);
  assert.equal(disbursementVolumeCents(details), 12500);
});

test('3 voided fees and failed legs add no volume; a leg without a send hash stands alone', () => {
  const legs = [{ id: 'solo', amount_cents: 700, status: 'submitted', check_id: null, provider_metadata: {} }];
  const events = [
    { id: 'v', event_type: 'moov_next_day', payment_transfer_id: 'solo', status: 'voided' },
    { id: 's', event_type: 'moov_next_day', payment_transfer_id: 'solo', status: 'recorded' },
    { id: 'm', event_type: 'moov_same_day', payment_transfer_id: 'missing', status: 'recorded' },
  ];
  const details = disbursementDetails(events, legs, [], []);
  assert.equal(details.has('v'), false);
  assert.equal(details.get('s').amount_cents, 700);
  assert.equal(details.get('s').check_number, null);
  assert.equal(details.get('m').amount_cents, 0);
  assert.equal(disbursementVolumeCents(details), 700);
});

test('4 the usage tracker shows the fees charged and the amount sent, friendly labels, not funds received or raw types', () => {
  const page = readFileSync(new URL('../../src/components/billing/TenantUsageTracker.tsx', import.meta.url), 'utf8');
  // The card shows the fees charged (what is billed) and, separately labeled, the amount sent.
  assert.match(page, /Estimated fees: <span className="font-semibold text-foreground">\{formatCurrency\(disbursementFees\)\}/);
  assert.match(page, /Amount sent: <span className="font-semibold text-foreground">\{formatCurrency\(disbursementVolume\)\}/);
  assert.match(page, /isSendFeeEvent\(e\.event_type\)\)\s*\.reduce\([^;]*unit_price_cents/);
  assert.doesNotMatch(page, /Total volume:/);
  assert.doesNotMatch(page, /claim_check_payments|totalReceived/);
  assert.match(page, /\{usageEventLabel\(row\.event_type\)\}/);
  assert.doesNotMatch(page, /event_type\?\.replace\(/);
  assert.match(page, /Insured: \$\{displayCase\(sent\.insured_name\)\}/);
  assert.match(page, /Paid to: \$\{displayCase\(sent\.payee_name\)\}/);
  assert.match(page, /\.from\("check_billing_events"\)\s*\.select\("id, event_type, payment_transfer_id, claim_id, status"\)/);
});

test('5 clicking a usage card filters the log to its charges; the fee table sits at the bottom', () => {
  assert.equal(usageCategory('check_processing'), 'check_processing');
  assert.equal(usageCategory('moov_next_day'), 'payments');
  assert.equal(usageCategory('moov_same_day'), 'payments');
  assert.equal(usageCategory('mortgage_ops_initial'), 'mortgage');
  assert.equal(usageCategory('mortgage_handling'), 'mortgage');
  assert.equal(usageCategory('something_else'), 'other');
  const events = [
    { id: 'a', event_type: 'check_processing' },
    { id: 'b', event_type: 'moov_next_day' },
    { id: 'c', event_type: 'mortgage_ops_initial' },
  ];
  assert.deepEqual(filterUsageEvents(events, 'all').map((e) => e.id), ['a', 'b', 'c']);
  assert.deepEqual(filterUsageEvents(events, 'payments').map((e) => e.id), ['b']);
  assert.deepEqual(filterUsageEvents(null, 'mortgage'), []);
  const page = readFileSync(new URL('../../src/components/billing/TenantUsageTracker.tsx', import.meta.url), 'utf8');
  for (const cat of ['check_processing', 'mortgage', 'payments']) {
    assert.match(page, new RegExp(`onClick=\\{\\(\\) => toggleCategory\\("${cat}"\\)\\}`), cat);
    assert.match(page, new RegExp(`aria-pressed=\\{category === "${cat}"\\}`), cat);
  }
  assert.match(page, /current === next \? "all" : next/);
  assert.match(page, /shownEvents\.map\(\(row: any\)/);
  // No separate type dropdown; the month picker stays.
  assert.doesNotMatch(page, /aria-label="Filter by type"/);
  assert.match(page, /<Select value=\{month\} onValueChange=\{setMonth\}>/);
  // The fee table is the last thing on the page, after the usage log.
  assert.ok(page.indexOf('<FeeScheduleCard') > page.indexOf('Usage & Processing Log'));
});
