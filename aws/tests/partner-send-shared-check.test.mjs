/**
 * Owner 2026-11-12: "a partner paid from a shared check sends onward from it, and that payment is the
 * partner's own Funds Released". The send route (moov-send.mjs, #1844) accepts a check its owner shares
 * with the sender right now. The website now shows a partner Send on the shared check's Funds tab,
 * capped at what the partner received on that check and has not sent yet, to the partner's own payees.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  completedIncomingCents,
  dollarsInputToCents,
  isPayableStakeholder,
  ownSentCents,
  partnerPayeeOptions,
  partnerSendAvailableCents,
  partnerSendRecipient,
} from '../../src/lib/payments/partnerSend.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const ME = 'aaaaaaaa-1111-4222-8333-444455556666';
const FREEDOM = '9b1f3c55-1111-4222-8333-444455556666';
const OTHER = 'cccccccc-1111-4222-8333-444455556666';
const CHECK = 'c0000000-1111-4222-8333-444455556666';

test('received on the check: completed incoming sends only, this check only', () => {
  const rows = [
    { id: '1', check_id: CHECK, status: 'completed', amount_cents: 100000 },
    { id: '2', check_id: CHECK, status: 'COMPLETED', amount_cents: '2500' },
    { id: '3', check_id: CHECK, status: 'pending', amount_cents: 99999 },
    { id: '4', check_id: CHECK, status: 'returned', amount_cents: 99999 },
    { id: '5', check_id: 'another', status: 'completed', amount_cents: 99999 },
    null,
  ];
  assert.equal(completedIncomingCents(rows, CHECK), 102500);
  assert.equal(completedIncomingCents(null, CHECK), 0);
});

test('own sends on the check: send legs that did not fail, cancel or come back', () => {
  const legs = [
    { leg_role: 'send_wallet', status: 'completed', amount_cents: 30000 },
    { leg_role: 'send_bank', status: 'ready', amount_cents: 1000 },
    { leg_role: 'send_wallet', status: 'failed', amount_cents: 5000 },
    { leg_role: 'send_wallet', status: 'canceled', amount_cents: 5000 },
    { leg_role: 'send_wallet', status: 'returned', amount_cents: 5000 },
    { leg_role: 'fund_wallet', status: 'completed', amount_cents: 5000 },
  ];
  assert.equal(ownSentCents(legs), 31000);
});

test('available = received (sends + settled recorded payments) minus own sends, never below zero', () => {
  const incoming = [{ id: '1', check_id: CHECK, status: 'completed', amount_cents: 100000 }];
  const ownLegs = [{ leg_role: 'send_wallet', status: 'completed', amount_cents: 40000 }];
  assert.equal(partnerSendAvailableCents({ incoming, checkId: CHECK, ownLegs }), 60000);
  assert.equal(partnerSendAvailableCents({ incoming, checkId: CHECK, settledRecordedCents: 5000, ownLegs }), 65000);
  assert.equal(partnerSendAvailableCents({ incoming: [], checkId: CHECK, ownLegs }), 0);
  // Nothing received yet (still in transit): nothing to send.
  assert.equal(partnerSendAvailableCents({ incoming: [{ id: '1', check_id: CHECK, status: 'pending', amount_cents: 100000 }], checkId: CHECK, ownLegs: [] }), 0);
});

test('payable stakeholders follow the send route: active, payable origin, verified, Moov account and bank', () => {
  const ok = { id: 's1', is_active: true, origin: 'tenant_owned', verification_status: 'verified', provider: 'moov', provider_account_id: 'a', provider_bank_account_id: 'b' };
  assert.equal(isPayableStakeholder(ok), true);
  assert.equal(isPayableStakeholder({ ...ok, origin: 'provider_recipient', verification_status: 'admin_override' }), true);
  assert.equal(isPayableStakeholder({ ...ok, origin: null }), true);
  for (const bad of [
    { ...ok, is_active: false },
    { ...ok, origin: 'homeowner' },
    { ...ok, is_partner_payout: true },
    { ...ok, verification_status: 'pending' },
    { ...ok, provider: 'stripe' },
    { ...ok, provider_bank_account_id: null },
  ]) assert.equal(isPayableStakeholder(bad), false);
  // The send route's list of payable origins is the one mirrored here.
  assert.match(read('aws/functions/api/providers/production/moov-send.mjs'), /PAYABLE_STAKEHOLDER_ORIGINS = Object\.freeze\(new Set\(\['tenant_owned', 'provider_recipient'\]\)\)/);
});

test('payees: active partners (the sharing organization too), payable stakeholders, active vendors; never itself', () => {
  const payees = partnerPayeeOptions({
    tenantId: ME,
    partnerships: [
      { inviter_tenant_id: FREEDOM, invitee_tenant_id: ME, status: 'active' },
      { inviter_tenant_id: ME, invitee_tenant_id: OTHER, status: 'revoked' },
      { inviter_tenant_id: ME, invitee_tenant_id: FREEDOM, status: 'active' },
    ],
    partnerNames: new Map([[FREEDOM, 'Freedom']]),
    stakeholders: [
      { id: 's2', nickname: 'Zed Roofing', is_active: true, verification_status: 'verified', provider: 'moov', provider_account_id: 'a', provider_bank_account_id: 'b', provider_bank_name: 'Chase', provider_last_four: '1234' },
      { id: 's3', nickname: 'Unverified', is_active: true, verification_status: 'pending', provider: 'moov', provider_account_id: 'a', provider_bank_account_id: 'b' },
    ],
    vendors: [
      { vendor_tenant_id: OTHER, vendor_name: 'Supply Co', vendor_active: true },
      { vendor_tenant_id: ME, vendor_name: 'Me', vendor_active: true },
      { vendor_tenant_id: 'dddddddd-1111-4222-8333-444455556666', vendor_name: 'Gone', vendor_active: false },
    ],
    showVendors: true,
  });
  assert.deepEqual(payees.map((p) => [p.kind, p.id, p.name]), [
    ['partner', FREEDOM, 'Freedom'],
    ['stakeholder', 's2', 'Zed Roofing'],
    ['vendor', OTHER, 'Supply Co'],
  ]);
  assert.equal(payees[1].detail, 'Chase ••1234');
  // Vendors are left out when vendor payments are switched off.
  assert.equal(partnerPayeeOptions({ tenantId: ME, vendors: [{ vendor_tenant_id: OTHER, vendor_active: true }], showVendors: false }).length, 0);
});

test('recipients in the send route shape, and typed dollars to cents', () => {
  assert.deepEqual(partnerSendRecipient({ kind: 'partner', id: FREEDOM }, 500), { kind: 'partner', partner_tenant_id: FREEDOM, amount_cents: 500 });
  assert.deepEqual(partnerSendRecipient({ kind: 'vendor', id: OTHER }, 500), { kind: 'vendor', vendor_tenant_id: OTHER, amount_cents: 500 });
  assert.deepEqual(partnerSendRecipient({ kind: 'stakeholder', id: 's2' }, 500), { kind: 'stakeholder', stakeholder_account_id: 's2', amount_cents: 500 });
  assert.equal(dollarsInputToCents('1,234.56'), 123456);
  assert.equal(dollarsInputToCents('$10'), 1000);
  assert.equal(dollarsInputToCents('10.5'), 1050);
  for (const bad of ['', '.', 'abc', '-5', '1.234', null]) assert.equal(dollarsInputToCents(bad), 0);
});

test('wiring: the partner Funds tab shows the panel; the panel sends through the send route; Funds Released lists the send', () => {
  const funds = read('src/components/payments/FundsTab.tsx');
  assert.match(funds, /\{readOnly && \(\s*<InlineErrorBoundary label="Send from this check">\s*<PartnerSendPanel/);
  const panel = read('src/components/payments/PartnerSendPanel.tsx');
  assert.match(panel, /sendPayment\(\{ tenantId, checkId: checkIntakeItemId, speed, recipients, idempotencyKey \}\)/);
  assert.match(panel, /error\.code !== "totp_required"/);
  assert.match(panel, /if \(!moovEnabled \|\| availableCents <= 0\) return null;/);
  // The owner's Funds tab is unchanged: the partner view is the only one rendered readOnly.
  const ccc = read('src/pages/CheckCommandCenter.tsx');
  assert.equal((ccc.match(/<IncomingFundsTab[\s\S]*?\/>/g) || []).filter((t) => /\breadOnly\b/.test(t)).length, 1);
  assert.match(ccc, /sentReleasedRows\(checkSends\.legs, \[\.\.\.checkSends\.checks, \.\.\.\(sharedChecks as any\[\]\)\]\)/);
});
