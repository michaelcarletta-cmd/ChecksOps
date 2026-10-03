import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildIndividualKycPatch,
  cannotFalselyMarkComplete,
  dropTokenFromBody,
  identityRequirementsOutstanding,
  kycStatusFromMoov,
  kybAccountCreateUnchanged,
  liveAccountReadFailed,
  liveBankVerified,
  liveTosAccepted,
  recipientOnboardingCompleteFromMoov,
  recipientTosDropScopes,
  rejectForgedRecipientTos,
  resumeExistingMoovAccount,
  shouldResumeExistingBank,
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

const kycInput = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  phone: '5125550100',
  address_line1: '101 Congress Ave',
  city: 'Austin',
  state: 'tx',
  postal_code: '78701',
  birth_date: '1815-12-10',
  ssn: '123-45-6789',
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
  const client = readFileSync(new URL('../functions/api/providers/parity/moov-client.mjs', import.meta.url), 'utf8');
  const edge = readFileSync(new URL('../../supabase/functions/_shared/moovClient.ts', import.meta.url), 'utf8');
  assert.match(client, /dropTos: \(id\) => \[/);
  assert.match(edge, /dropTos: \(id: string\) => \[/);
  assert.match(client, /`\/accounts\/\$\{id\}\/profile\.write`/);
  assert.match(edge, /`\/accounts\/\$\{id\}\/profile\.write`/);
});

test('browser accepted=true without a Drop token is forged', () => {
  const forged = rejectForgedRecipientTos({ accepted: true });
  assert.equal(forged.error, 'tos_acceptance_forged');
  assert.equal(rejectForgedRecipientTos({ accepted: true, terms_of_service_token: 'drop-token-xx' }), null);
  assert.equal(dropTokenFromBody({ tos_token: 'drop-token-xx' }), 'drop-token-xx');
  assert.equal(rejectForgedRecipientTos({}).error, 'tos_drop_token_required');
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
  const omitted = tosBoundToRecipientAccount({
    recipientAccountId: RECIPIENT_ACCOUNT,
    requestedAccountId: null,
    environment: 'production',
  });
  assert.equal(omitted.ok, true);
  assert.equal(omitted.account_id, RECIPIENT_ACCOUNT);
  assert.equal(omitted.production, true);
});

test('KYC fields are submitted, not merely read', () => {
  assert.equal(kycStatusFromMoov(liveTarget.account), 'unverified');
  assert.equal(liveTosAccepted(liveTarget.account), false);
  assert.equal(tosRequirementOutstanding(liveTarget.capabilities), true);
  assert.deepEqual(
    identityRequirementsOutstanding(liveTarget.capabilities),
    ['individual.address', 'individual.birthdate', 'individual.ssn'],
  );
  const incomplete = buildIndividualKycPatch({ first_name: 'Ada' });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error, 'kyc_fields_incomplete');
  assert.ok(incomplete.missing.includes('address'));
  assert.ok(incomplete.missing.includes('birthdate'));
  assert.ok(incomplete.missing.includes('ssn'));
  const patch = buildIndividualKycPatch(kycInput);
  assert.equal(patch.ok, true);
  const individual = patch.body.profile.individual;
  assert.equal(individual.address.addressLine1, '101 Congress Ave');
  assert.equal(individual.address.city, 'Austin');
  assert.equal(individual.address.stateOrProvince, 'TX');
  assert.equal(individual.address.postalCode, '78701');
  assert.deepEqual(individual.birthDate, { year: 1815, month: 12, day: 10 });
  assert.deepEqual(individual.governmentID, { ssn: { full: '123456789' } });
  const kycSrc = readFileSync(new URL('../../supabase/functions/moov-recipient-kyc-update/index.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
  assert.match(kycSrc, /buildIndividualKycPatch/);
  assert.match(kycSrc, /method: "PATCH"/);
  assert.match(ui, /submitRecipientKyc/);
  assert.match(ui, /birth_date/);
  assert.match(ui, /ssn/);
  assert.match(ui, /address_line1/);
  assert.doesNotMatch(kycSrc, /ssn: ssn/);
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
  assert.equal(liveBankVerified([{ status: 'new', lastFourAccountNumber: '1506' }]), false);
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: {
      ...liveTarget.account,
      verification: { status: 'verified' },
      termsOfService: { acceptedDate: '2026-09-10T00:00:00Z' },
    },
    banks: [{ status: 'new', lastFourAccountNumber: '1506' }],
    capabilities: [{ capability: 'transfers', status: 'enabled', requirements: [] }],
    capabilitiesReadOk: true,
  }), false);
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

test('existing production bank is resumed and not duplicated', () => {
  assert.equal(shouldResumeExistingBank({ banks: liveTarget.banks, replaceBank: false }), true);
  assert.equal(shouldResumeExistingBank({ banks: liveTarget.banks, replaceBank: true }), false);
  assert.equal(shouldResumeExistingBank({ banks: [], replaceBank: false }), false);
  const bankAdd = readFileSync(new URL('../../supabase/functions/moov-recipient-bank-add/index.ts', import.meta.url), 'utf8');
  const parity = readFileSync(new URL('../functions/api/providers/parity/moov-onboard.mjs', import.meta.url), 'utf8');
  assert.match(bankAdd, /shouldResumeExistingBank/);
  assert.match(bankAdd, /moov_bank_list_failed/);
  assert.match(parity, /shouldResumeExistingBank/);
  assert.match(parity, /moov_bank_list_failed/);
  const resumeIdx = bankAdd.indexOf('shouldResumeExistingBank');
  const routingIdx = bankAdd.indexOf('routing_number');
  assert.ok(resumeIdx > 0 && routingIdx > resumeIdx);
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

test('provider read failure fails closed', () => {
  assert.equal(liveAccountReadFailed(null), true);
  assert.equal(liveAccountReadFailed(liveTarget.account), false);
  assert.equal(tosConfirmedByMoov({
    account: { termsOfService: {} },
    capabilities: [],
    capabilitiesReadOk: false,
  }), false);
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: null,
    banks: liveTarget.banks,
    capabilities: liveTarget.capabilities,
    capabilitiesReadOk: false,
  }), false);
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: liveTarget.account,
    banks: liveTarget.banks,
    capabilities: liveTarget.capabilities,
    capabilitiesReadOk: false,
  }), false);
  const session = readFileSync(new URL('../../supabase/functions/moov-recipient-session/index.ts', import.meta.url), 'utf8');
  const tosAccept = readFileSync(new URL('../../supabase/functions/moov-recipient-tos-accept/index.ts', import.meta.url), 'utf8');
  assert.match(session, /moov_account_get_failed/);
  assert.match(tosAccept, /tos_not_recorded/);
  assert.match(tosAccept, /tosConfirmedByMoov/);
});

test('KYB business create path remains distinct from individual KYC', () => {
  const kyb = kybAccountCreateUnchanged({ accountType: 'business' });
  assert.equal(kyb.accountType, 'business');
  assert.equal(kyb.requests_representatives, true);
  assert.equal(kyb.not_recipient_individual, true);
  const createSrc = readFileSync(new URL('../../supabase/functions/moov-account-create/index.ts', import.meta.url), 'utf8');
  const onboardSrc = readFileSync(new URL('../../supabase/functions/moov-account-onboard/index.ts', import.meta.url), 'utf8');
  const tenantTos = readFileSync(new URL('../../supabase/functions/moov-tos-token/index.ts', import.meta.url), 'utf8');
  assert.match(createSrc, /accountType: "business"/);
  assert.match(onboardSrc, /representatives/);
  assert.doesNotMatch(createSrc, /accepted === true/);
  assert.match(tenantTos, /profile\.write/);
  assert.doesNotMatch(createSrc, /dropTos/);
  assert.doesNotMatch(onboardSrc, /dropTos/);
});

test('money path is not enabled by this recipient ToS fix', () => {
  const policy = readFileSync(new URL('../functions/api/providers/moov-recipient-tos-policy.mjs', import.meta.url), 'utf8');
  const tosAccept = readFileSync(new URL('../../supabase/functions/moov-recipient-tos-accept/index.ts', import.meta.url), 'utf8');
  const bankAdd = readFileSync(new URL('../../supabase/functions/moov-recipient-bank-add/index.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../../supabase/functions/moov-recipient-session/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(policy, /transfers\.write/);
  assert.doesNotMatch(tosAccept, /send-funds/);
  assert.doesNotMatch(tosAccept, /accepted !== true/);
  assert.match(tosAccept, /tos_acceptance_forged|rejectForgedRecipientTos/);
  assert.match(tosAccept, /termsOfService: \{ token: dropToken \}/);
  assert.match(bankAdd, /tos_required/);
  assert.match(ui, /moov-terms-of-service/);
  assert.match(ui, /onboarding\?\.complete === true/);
  assert.match(ui, /oauthToken = oauthToken/);
  assert.match(ui, /el\.token = oauthToken/);
  assert.match(ui, /el\.accountID = accountId/);
  assert.doesNotMatch(ui, /account_id: session/);
  assert.match(session, /scopes\.dropTos\(accountId\)/);
  assert.match(session, /bindMoovEnvironment/);
  const template = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED.*false/);
  assert.match(template, /AWS_MOOV_ENABLED.*false/);
  assert.match(template, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
});
