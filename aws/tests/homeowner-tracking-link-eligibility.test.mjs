import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  evaluateHomeownerPaymentLinkEligibility,
  evaluateHomeownerTrackingLinkEligibility,
} from '../../src/lib/homeownerTrackingLink.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('tracking eligibility is claim-scoped and ignores deposit and bank verification', () => {

  const CLAIM = '11111111-1111-4111-8111-111111111111';
  const unlinked = evaluateHomeownerTrackingLinkEligibility({
    claimId: null,
    deposited: true,
    bankVerified: true,
    payoutEnabled: true,
  });
  assert.equal(unlinked.enabled, false);
  assert.equal(unlinked.reason, 'missing_claim_id');
  assert.match(unlinked.message, /claim first/i);

  const liveLinked = evaluateHomeownerTrackingLinkEligibility({
    claimId: null,
    liveCheckClaimId: CLAIM,
    deposited: false,
    bankVerified: false,
    payoutEnabled: false,
  });
  assert.equal(liveLinked.enabled, true);
  assert.equal(liveLinked.claimId, CLAIM);

  const payment = evaluateHomeownerPaymentLinkEligibility({ readOnly: false });
  assert.equal(payment.enabled, true);
  const paymentReadOnly = evaluateHomeownerPaymentLinkEligibility({ readOnly: true });
  assert.equal(paymentReadOnly.enabled, false);
});

test('Funds tracking CTA is not gated on deposit or payoutEnabled', () => {
  const tab = read('src/components/payments/FundsTab.tsx');
  const paymentIdx = tab.indexOf('Send Homeowner Payment Link');
  const trackingIdx = tab.indexOf('Send Homeowner Tracking Link');
  const payoutBtn = tab.indexOf('disabled={!payoutEnabled}');
  const trackingMount = tab.indexOf('<SendCheckTrackingLinkButton');

  assert.ok(paymentIdx > 0);
  assert.ok(trackingIdx > 0);
  assert.ok(trackingMount > 0);
  assert.ok(payoutBtn > 0);
  assert.ok(tab.includes('checkIntakeItemId={checkIntakeItemId}'));
  assert.ok(tab.includes('available before deposit'));
  assert.ok(tab.includes('does not require bank verification'));
  assert.ok(
    trackingMount < payoutBtn,
    'tracking button mounts before the deposit-gated Disburse control',
  );
  const trackingBlock = tab.slice(trackingMount, tab.indexOf('/>', trackingMount) + 2);
  assert.doesNotMatch(
    trackingBlock,
    /payoutEnabled|isDeposited|bankVerified|existingHomeownerLink/,
  );
});

test('tracking button uses live claim_id and keeps payment eligibility separate', () => {
  const button = read('src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx');
  const homeowner = read('aws/functions/api/homeowner.mjs');

  assert.match(button, /evaluateHomeownerTrackingLinkEligibility/);
  assert.match(button, /homeownerTrackingLinkQueryKey/);
  assert.match(button, /checkIntakeItemId/);
  assert.match(button, /homeowner-ledger-send/);
  assert.doesNotMatch(button, /payoutEnabled|deposited_at|homeowner_bank_link/);

  assert.match(homeowner, /export const runHomeownerLedgerSend/);
  assert.doesNotMatch(
    homeowner.slice(homeowner.indexOf('export const runHomeownerLedgerSend'), homeowner.indexOf('export const handleHomeownerLedgerSend')),
    /deposited_at|check_stage|homeowner_bank_link|payoutEnabled|bank.?verif/,
  );
});
