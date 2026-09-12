import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  interpretRecipientBankVerification,
  kycStatusFromMoov,
  liveTosAccepted,
  recipientOnboardingCompleteFromMoov,
  tosBoundToRecipientAccount,
  tosConfirmedByMoov,
} from '../functions/api/providers/moov-recipient-tos-policy.mjs';

const RECIPIENT_ID = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const ACCOUNT_ID = 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f';
const BANK_ID = '72eb66c1-d9a9-4f85-ab50-8871db9ceeea';
const UI = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
const KYC = readFileSync(new URL('../functions/api/public-moov-recipient-kyc-tos.mjs', import.meta.url), 'utf8');
const TEMPLATE = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
const DOC = readFileSync(new URL('../financial/M64C_VERIFY_KYC_TOS.md', import.meta.url), 'utf8');

const liveAccount = {
  accountID: ACCOUNT_ID,
  accountType: 'individual',
  mode: 'production',
  verification: { status: 'verified' },
  termsOfService: { acceptedDate: '2026-09-12T17:37:31.697535Z' },
};
const liveBank = {
  bankAccountID: BANK_ID,
  bankName: 'JPMORGAN CHASE BANK, NA',
  lastFourAccountNumber: '1506',
  status: 'new',
};
const liveCaps = [
  { capability: 'send-funds', status: 'enabled', requirements: [] },
  { capability: 'transfers', status: 'enabled', requirements: [] },
  { capability: 'wallet', status: 'enabled', requirements: [] },
];

test('live KYC+ToS snapshot is verified and bound to the existing account', () => {
  assert.equal(kycStatusFromMoov(liveAccount), 'verified');
  assert.equal(liveTosAccepted(liveAccount), true);
  assert.equal(tosConfirmedByMoov({
    account: liveAccount,
    capabilities: liveCaps,
    capabilitiesReadOk: true,
  }), true);
  const bound = tosBoundToRecipientAccount({
    recipientAccountId: ACCOUNT_ID,
    requestedAccountId: ACCOUNT_ID,
    environment: 'production',
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.account_id, ACCOUNT_ID);
  assert.match(DOC, /62a858ff-ee6a-49d7-9898-1c8e4a44227b/);
  assert.match(DOC, /ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f/);
  assert.match(DOC, /72eb66c1-d9a9-4f85-ab50-8871db9ceeea/);
});

test('existing Chase 1506 is unverified and eligible for micro-deposit, not already initiated', () => {
  const state = interpretRecipientBankVerification({ bank: liveBank, verification: null });
  assert.equal(state.bank_status, 'new');
  assert.equal(state.verified, false);
  assert.equal(state.initiated, false);
  assert.equal(state.should_initiate, true);
  assert.equal(state.can_confirm, false);
  assert.equal(state.method, 'instant_micro_deposit');
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: liveAccount,
    banks: [liveBank],
    capabilities: liveCaps,
    capabilitiesReadOk: true,
  }), false);
});

test('M6.4C does not expose or route bank-verify mutations', () => {
  assert.match(UI, /Bank verification is not available yet/);
  assert.doesNotMatch(UI, /invoke\("moov-recipient-bank-verify"/);
  assert.doesNotMatch(KYC, /\/verify/);
  assert.doesNotMatch(KYC, /bank-accounts\.write/);
  assert.doesNotMatch(KYC, /initiateMicroDeposits/);
  assert.match(DOC, /Do not initiate micro-deposits/);
  assert.match(DOC, /MICRODEPOSIT ALREADY INITIATED: NO/);
  assert.match(TEMPLATE, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(TEMPLATE, /AWS_MOOV_ENABLED: "false"/);
  assert.match(TEMPLATE, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
});
