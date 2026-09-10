import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  initiateAlreadyOpenError,
  interpretRecipientBankVerification,
  kybAccountCreateUnchanged,
  liveBankVerified,
  moovInstantVerifyBody,
  normalizeRecipientVerifyCode,
  providerVerifySuccessIsNotComplete,
  recipientBankVerifyBlocked,
  recipientOnboardingCompleteFromMoov,
  rejectBrowserBankSubstitution,
  shouldInitiateInstantMicroDeposit,
  shouldResumeExistingBank,
} from '../functions/api/providers/moov-recipient-tos-policy.mjs';

const RECIPIENT_ACCOUNT = 'ee8c608e-0000-4000-8000-00000000fc5f';
const OTHER_ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const LIVE_BANK = 'bbbbbbbb-0000-4000-8000-000000001506';
const OTHER_BANK = 'cccccccc-0000-4000-8000-000000000002';

const unverifiedAccount = {
  accountID: RECIPIENT_ACCOUNT,
  verification: { status: 'unverified' },
  termsOfService: {},
};
const verifiedKycTos = {
  accountID: RECIPIENT_ACCOUNT,
  verification: { status: 'verified' },
  termsOfService: { acceptedDate: '2026-09-10T00:00:00Z' },
};
const newBank = { status: 'new', verificationStatus: 'new', lastFourAccountNumber: '1506', bankAccountID: LIVE_BANK };

test('existing new bank is resumed and selected for instant micro-deposit', () => {
  assert.equal(shouldResumeExistingBank({ banks: [newBank], replaceBank: false }), true);
  const state = interpretRecipientBankVerification({ bank: newBank, verification: null });
  assert.equal(state.method, 'instant_micro_deposit');
  assert.equal(state.verified, false);
  assert.equal(state.initiated, false);
  assert.equal(state.should_initiate, true);
  assert.equal(state.can_confirm, false);
  assert.equal(shouldInitiateInstantMicroDeposit({ bank: newBank, verification: null }), true);
});

test('does not initiate again when micro-deposits are already open', () => {
  assert.equal(shouldInitiateInstantMicroDeposit({
    bank: { status: 'pending' },
    verification: { status: 'sent-credit' },
  }), false);
  assert.equal(shouldInitiateInstantMicroDeposit({
    bank: { status: 'new' },
    verification: { status: 'new' },
  }), false);
  const open = interpretRecipientBankVerification({
    bank: { status: 'pending' },
    verification: { status: 'sent-credit' },
  });
  assert.equal(open.initiated, true);
  assert.equal(open.can_confirm, true);
  assert.equal(open.should_initiate, false);
  assert.equal(initiateAlreadyOpenError('verification already in progress'), true);
});

test('expired or max-attempt verification can be restarted, errored bank cannot', () => {
  assert.equal(shouldInitiateInstantMicroDeposit({
    bank: { status: 'verificationFailed' },
    verification: { status: 'expired' },
  }), true);
  assert.equal(shouldInitiateInstantMicroDeposit({
    bank: { status: 'errored' },
    verification: { status: 'failed' },
  }), false);
});

test('Moov verify code format is MV plus four digits', () => {
  assert.equal(normalizeRecipientVerifyCode('12-34'), '1234');
  assert.deepEqual(moovInstantVerifyBody('0001'), { code: 'MV0001' });
  assert.equal(moovInstantVerifyBody('12'), null);
  assert.equal(moovInstantVerifyBody('abcd'), null);
});

test('browser account or bank substitution is rejected', () => {
  assert.equal(rejectBrowserBankSubstitution({
    recipientAccountId: RECIPIENT_ACCOUNT,
    liveBankAccountId: LIVE_BANK,
    requestedAccountId: OTHER_ACCOUNT,
  }).error, 'bank_account_mismatch');
  assert.equal(rejectBrowserBankSubstitution({
    recipientAccountId: RECIPIENT_ACCOUNT,
    liveBankAccountId: LIVE_BANK,
    requestedBankAccountId: OTHER_BANK,
  }).error, 'bank_account_mismatch');
  assert.equal(rejectBrowserBankSubstitution({
    recipientAccountId: RECIPIENT_ACCOUNT,
    liveBankAccountId: LIVE_BANK,
    requestedAccountId: null,
    requestedBankAccountId: null,
  }), null);
});

test('KYC and ToS gate bank verification', () => {
  assert.equal(recipientBankVerifyBlocked({
    tosAccepted: false, tosOutstanding: true, identityOutstanding: [],
  }).error, 'tos_required');
  assert.equal(recipientBankVerifyBlocked({
    tosAccepted: true, tosOutstanding: false,
    identityOutstanding: ['individual.ssn'],
  }).error, 'kyc_incomplete');
  assert.equal(recipientBankVerifyBlocked({
    tosAccepted: true, tosOutstanding: false, identityOutstanding: [],
  }), null);
});

test('successful provider HTTP without live verified bank is not complete', () => {
  assert.equal(providerVerifySuccessIsNotComplete({ httpOk: true, bank: newBank }), true);
  assert.equal(liveBankVerified([newBank]), false);
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: verifiedKycTos,
    banks: [newBank],
    capabilities: [],
    capabilitiesReadOk: true,
  }), false);
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: verifiedKycTos,
    banks: [{ status: 'verified' }],
    capabilities: [],
    capabilitiesReadOk: true,
  }), true);
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: unverifiedAccount,
    banks: [{ status: 'verified' }],
    capabilities: [],
    capabilitiesReadOk: true,
  }), false);
});

test('public recipient verify implementation is provider-authoritative and scoped', () => {
  const verifySrc = readFileSync(new URL('../../supabase/functions/moov-recipient-bank-verify/index.ts', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../../supabase/functions/moov-recipient-session/index.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
  const bankAdd = readFileSync(new URL('../../supabase/functions/moov-recipient-bank-add/index.ts', import.meta.url), 'utf8');
  assert.match(verifySrc, /action !== "initiate" && action !== "confirm"/);
  assert.match(verifySrc, /token_expires_at/);
  assert.match(verifySrc, /410/);
  assert.match(verifySrc, /rejectBrowserBankSubstitution/);
  assert.match(verifySrc, /shouldInitiateInstantMicroDeposit/);
  assert.match(verifySrc, /method: "POST"/);
  assert.match(verifySrc, /method: "PUT"/);
  assert.match(verifySrc, /\/verify/);
  assert.match(verifySrc, /moovInstantVerifyBody/);
  assert.match(verifySrc, /bank_not_verified/);
  assert.match(verifySrc, /moov_bank_list_failed/);
  assert.match(verifySrc, /recipientBankVerifyBlocked/);
  assert.doesNotMatch(verifySrc, /console\.error\([^\n]*code/);
  assert.doesNotMatch(verifySrc, /transfers\.write/);
  assert.doesNotMatch(verifySrc, /\/transfers/);
  assert.match(session, /bank_micro_deposits_initiated/);
  assert.match(session, /bank_should_initiate/);
  assert.match(ui, /moov-recipient-bank-verify/);
  assert.match(ui, /action: "initiate"/);
  assert.match(ui, /action: "confirm"/);
  assert.doesNotMatch(ui, /bank_account_id:/);
  assert.match(bankAdd, /shouldResumeExistingBank/);
  assert.match(bankAdd, /moov_bank_list_failed/);
});

test('KYB remains unchanged and money transfer routes stay blocked', () => {
  const kyb = kybAccountCreateUnchanged({ accountType: 'business' });
  assert.equal(kyb.accountType, 'business');
  const createSrc = readFileSync(new URL('../../supabase/functions/moov-account-create/index.ts', import.meta.url), 'utf8');
  const onboardSrc = readFileSync(new URL('../../supabase/functions/moov-account-onboard/index.ts', import.meta.url), 'utf8');
  const verifySrc = readFileSync(new URL('../../supabase/functions/moov-recipient-bank-verify/index.ts', import.meta.url), 'utf8');
  assert.match(createSrc, /accountType: "business"/);
  assert.match(onboardSrc, /representatives/);
  assert.doesNotMatch(createSrc, /moov-recipient-bank-verify/);
  assert.doesNotMatch(onboardSrc, /moov-recipient-bank-verify/);
  assert.doesNotMatch(verifySrc, /send-funds/);
  const template = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED.*false/);
  assert.match(template, /AWS_MOOV_ENABLED.*false/);
  assert.match(template, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
});
