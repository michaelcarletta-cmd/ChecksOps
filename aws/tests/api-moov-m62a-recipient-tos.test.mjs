import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  cannotFalselyMarkComplete,
  dropTokenFromBody,
  identityRequirementsOutstanding,
  kycStatusFromMoov,
  kybAccountCreateUnchanged,
  liveTosAccepted,
  recipientOnboardingCompleteFromMoov,
  recipientTosDropScopes,
  rejectForgedRecipientTos,
  resumeExistingMoovAccount,
  tosBoundToRecipientAccount,
  tosConfirmedByMoov,
  tosRequirementOutstanding,
} from '../functions/api/providers/moov-recipient-tos-policy.mjs';

const RECIPIENT_ACCOUNT = 'ee8c608e-0000-4000-8000-00000000fc5f';
const PLATFORM_ACCOUNT = '41cb5d67-0000-4000-8000-000000002208';

const liveTarget = {
  account: {
    accountID: RECIPIENT_ACCOUNT,
    accountType: 'individual',
    mode: 'production',
    verification: { status: 'unverified' },
    termsOfService: {},
    disabled: false,
    restricted: false,
  },
  banks: [{ status: 'new', verificationStatus: 'new', lastFourAccountNumber: '1506' }],
  capabilities: [
    { capability: 'send-funds', status: 'pending', requirements: { currentlyDue: ['account.tos-acceptance', 'individual.address', 'individual.birthdate', 'individual.ssn'] } },
    { capability: 'transfers', status: 'enabled', requirements: [] },
  ],
};

test('individual ToS Drop scopes bind the recipient account, not the platform', () => {
  const scopes = recipientTosDropScopes(RECIPIENT_ACCOUNT);
  assert.deepEqual(scopes, [
    `/accounts/${RECIPIENT_ACCOUNT}/profile.write`,
    `/accounts/${RECIPIENT_ACCOUNT}/profile.read`,
    '/ping.read',
  ]);
  assert.equal(scopes.some((scope) => scope.includes(PLATFORM_ACCOUNT)), false);
  assert.equal(scopes.includes('/accounts.write'), false);
  assert.equal(scopes.some((scope) => scope.includes('transfers.write')), false);
});

test('browser accepted=true without a Drop token is forged', () => {
  const forged = rejectForgedRecipientTos({ accepted: true });
  assert.equal(forged.error, 'tos_acceptance_forged');
  assert.equal(rejectForgedRecipientTos({ accepted: true, terms_of_service_token: 'drop-token-xx' }), null);
  assert.equal(dropTokenFromBody({ tos_token: 'drop-token-xx' }), 'drop-token-xx');
});

test('ToS stays bound to the existing production recipient account', () => {
  const bound = tosBoundToRecipientAccount({
    recipientAccountId: RECIPIENT_ACCOUNT,
    requestedAccountId: RECIPIENT_ACCOUNT,
    environment: 'production',
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.account_id, RECIPIENT_ACCOUNT);
  assert.equal(bound.production, true);
  const mismatch = tosBoundToRecipientAccount({
    recipientAccountId: RECIPIENT_ACCOUNT,
    requestedAccountId: PLATFORM_ACCOUNT,
    environment: 'production',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, 'tos_account_mismatch');
});

test('KYC and ToS are read from Moov, not local RDS', () => {
  assert.equal(kycStatusFromMoov(liveTarget.account), 'unverified');
  assert.equal(liveTosAccepted(liveTarget.account), false);
  assert.equal(tosRequirementOutstanding(liveTarget.capabilities), true);
  assert.deepEqual(
    identityRequirementsOutstanding(liveTarget.capabilities),
    ['individual.address', 'individual.birthdate', 'individual.ssn'],
  );
});

test('UI cannot mark onboarding complete from last4 or local awaiting_bank', () => {
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: liveTarget.account,
    banks: liveTarget.banks,
    capabilities: liveTarget.capabilities,
    capabilitiesReadOk: true,
  }), false);
  assert.equal(cannotFalselyMarkComplete({
    account: liveTarget.account,
    banks: liveTarget.banks,
    capabilities: liveTarget.capabilities,
    capabilitiesReadOk: true,
  }), true);
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: {
      ...liveTarget.account,
      verification: { status: 'verified' },
      termsOfService: { acceptedDate: '2026-09-10T00:00:00Z' },
    },
    banks: [{ status: 'verified' }],
    capabilities: [{ capability: 'transfers', status: 'enabled', requirements: [] }],
    capabilitiesReadOk: true,
  }), true);
});

test('retry resumes the existing Moov account and does not create a duplicate', () => {
  const resumed = resumeExistingMoovAccount({
    existingRecipient: { provider_account_id: RECIPIENT_ACCOUNT, environment: 'production' },
    createRequested: true,
  });
  assert.equal(resumed.create, false);
  assert.equal(resumed.duplicate, false);
  assert.equal(resumed.account_id, RECIPIENT_ACCOUNT);
  assert.equal(resumed.environment, 'production');
});

test('ToS is confirmed only after Moov records it', () => {
  assert.equal(tosConfirmedByMoov({
    account: liveTarget.account,
    capabilities: liveTarget.capabilities,
    capabilitiesReadOk: true,
  }), false);
  assert.equal(tosConfirmedByMoov({
    account: { termsOfService: { acceptedDate: '2026-09-10T00:00:00Z' } },
    capabilities: [{ capability: 'send-funds', status: 'pending', requirements: {} }],
    capabilitiesReadOk: true,
  }), true);
  assert.equal(tosConfirmedByMoov({
    account: { termsOfService: {} },
    capabilities: [{ capability: 'send-funds', status: 'pending', requirements: {} }],
    capabilitiesReadOk: true,
    tosOutstandingBefore: true,
  }), true);
});

test('KYB business create path remains distinct from individual KYC', () => {
  const kyb = kybAccountCreateUnchanged({ accountType: 'business' });
  assert.equal(kyb.accountType, 'business');
  assert.equal(kyb.requests_representatives, true);
  assert.equal(kyb.not_recipient_individual, true);
  const createSrc = readFileSync(new URL('../../supabase/functions/moov-account-create/index.ts', import.meta.url), 'utf8');
  const onboardSrc = readFileSync(new URL('../../supabase/functions/moov-account-onboard/index.ts', import.meta.url), 'utf8');
  assert.match(createSrc, /accountType: "business"/);
  assert.match(onboardSrc, /representatives/);
  assert.doesNotMatch(createSrc, /accepted === true/);
});

test('money path is not enabled by this recipient ToS fix', () => {
  const policy = readFileSync(new URL('../functions/api/providers/moov-recipient-tos-policy.mjs', import.meta.url), 'utf8');
  const tosAccept = readFileSync(new URL('../../supabase/functions/moov-recipient-tos-accept/index.ts', import.meta.url), 'utf8');
  const bankAdd = readFileSync(new URL('../../supabase/functions/moov-recipient-bank-add/index.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(policy, /transfers\.write/);
  assert.doesNotMatch(tosAccept, /send-funds/);
  assert.doesNotMatch(tosAccept, /accepted !== true/);
  assert.match(tosAccept, /tos_acceptance_forged|rejectForgedRecipientTos/);
  assert.match(bankAdd, /tos_required/);
  assert.match(ui, /moov-terms-of-service/);
  assert.match(ui, /onboarding\?\.complete === true/);
  const template = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED.*false/);
  assert.match(template, /AWS_MOOV_ENABLED.*false/);
});
