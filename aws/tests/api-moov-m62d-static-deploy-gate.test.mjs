import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  recipientOnboardingCompleteFromMoov,
  resumeExistingMoovAccount,
  shouldResumeExistingBank,
} from '../functions/api/providers/moov-recipient-tos-policy.mjs';

const ui = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
const session = readFileSync(new URL('../../supabase/functions/moov-recipient-session/index.ts', import.meta.url), 'utf8');
const kyc = readFileSync(new URL('../../supabase/functions/moov-recipient-kyc-update/index.ts', import.meta.url), 'utf8');
const tos = readFileSync(new URL('../../supabase/functions/moov-recipient-tos-accept/index.ts', import.meta.url), 'utf8');
const verify = readFileSync(new URL('../../supabase/functions/moov-recipient-bank-verify/index.ts', import.meta.url), 'utf8');
const template = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
const RECIPIENT_ACCOUNT = 'ee8c608e-0000-4000-8000-00000000fc5f';

test('page load and refresh only invoke the session reader, never mutation functions', () => {
  assert.match(ui, /useEffect\(\(\) => \{ void load\(\); \}, \[token\]\)/);
  assert.match(ui, /loadRecipientSession\(token/);
  const loadBlock = ui.slice(ui.indexOf('async function load()'), ui.indexOf('useEffect(() => { void load(); }'));
  assert.match(loadBlock, /loadRecipientSession/);
  assert.doesNotMatch(loadBlock, /invoke\(/);
  assert.doesNotMatch(loadBlock, /moov-recipient-kyc-update/);
  assert.doesNotMatch(loadBlock, /moov-recipient-tos-accept/);
  assert.doesNotMatch(loadBlock, /moov-recipient-bank-add/);
  assert.doesNotMatch(loadBlock, /moov-recipient-bank-verify/);
  assert.doesNotMatch(ui, /setInterval/);
  assert.doesNotMatch(ui, /setTimeout/);
});

test('session handler performs no Moov resource mutations', () => {
  assert.doesNotMatch(session, /method:\s*"POST"/);
  assert.doesNotMatch(session, /method:\s*"PUT"/);
  assert.doesNotMatch(session, /method:\s*"PATCH"/);
  assert.doesNotMatch(session, /method:\s*"DELETE"/);
  assert.match(session, /scopes\.accountRead/);
  assert.match(session, /scopes\.capabilitiesRead/);
  assert.match(session, /scopes\.bankAccountsRead/);
  assert.match(session, /bankAccountsRead\(accountId\)/);
  assert.doesNotMatch(session, /bankAccountsWrite/);
  assert.doesNotMatch(session, /accountWrite/);
  assert.doesNotMatch(session, /\/verify",\s*\{\s*method:\s*"POST"/);
  assert.doesNotMatch(session, /\.update\(/);
  assert.doesNotMatch(session, /\.insert\(/);
});

test('KYC PATCH is only reachable from explicit identity form submit', () => {
  assert.match(ui, /async function submitIdentity\(e: React\.FormEvent\)/);
  assert.match(ui, /<form onSubmit=\{submitIdentity\}/);
  assert.match(ui, /submitRecipientKyc\(token/);
  const kycInvokeIdx = ui.indexOf('submitRecipientKyc(token');
  const submitIdx = ui.indexOf('async function submitIdentity');
  const nextFn = ui.indexOf('async function submitTerms');
  assert.ok(kycInvokeIdx > submitIdx && kycInvokeIdx < nextFn);
  assert.match(kyc, /method:\s*"PATCH"/);
  assert.match(kyc, /buildIndividualKycPatch/);
});

test('ToS Drop render does not accept terms; server PATCH requires Drop token and explicit click', () => {
  assert.match(ui, /createElement\("moov-terms-of-service"/);
  assert.match(ui, /onClick=\{\(\) => void submitTerms\(\)\}/);
  assert.match(ui, /disabled=\{!tosDropToken \|\| saving\}/);
  assert.doesNotMatch(ui, /accepted:\s*true/);
  assert.doesNotMatch(ui, /accepted=\{true\}/);
  assert.doesNotMatch(ui, /<Checkbox/);
  assert.match(tos, /rejectForgedRecipientTos/);
  assert.match(tos, /dropTokenFromBody/);
  assert.match(ui, /submitRecipientTos\(token \|\| "", tosDropToken\)/);
  assert.match(tos, /method:\s*"PATCH"/);
  assert.match(tos, /termsOfService: \{ token: dropToken \}/);
  const tosInvokeIdx = ui.indexOf('submitRecipientTos(token');
  const submitTermsIdx = ui.indexOf('async function submitTerms');
  const bankHeldIdx = ui.indexOf('Bank verification is not available yet');
  assert.ok(tosInvokeIdx > submitTermsIdx && tosInvokeIdx < bankHeldIdx);
});

test('micro-deposit POST /verify stays unavailable on the public pay-setup page this phase', () => {
  assert.match(ui, /Send verification deposit/);
  assert.match(ui, /initiateBankVerify/);
  assert.match(ui, /bank_verify_available === true/);
  assert.doesNotMatch(loadBlockSafe(ui), /initiateRecipientBankVerify/);
  assert.doesNotMatch(loadBlockSafe(ui), /moov-recipient-bank-verify/);
  assert.match(ui, /Bank verification is not available yet/);
  assert.match(verify, /method: "POST"/);
  assert.match(verify, /\/bank-accounts\/\$\{liveBankId\}\/verify/);
  assert.match(verify, /shouldInitiateInstantMicroDeposit/);
});

test('MV code PUT /verify is not reachable from the public pay-setup page this phase', () => {
  assert.match(ui, /submitBankVerifyCode/);
  assert.doesNotMatch(loadBlockSafe(ui), /confirmRecipientBankVerify/);
  assert.doesNotMatch(ui, /action: "confirm"/);
  assert.match(verify, /method: "PUT"/);
  assert.match(verify, /moovInstantVerifyBody/);
});

test('existing recipient account and bank are resumed, not recreated, on the public link', () => {
  const resumed = resumeExistingMoovAccount({
    existingRecipient: { provider_account_id: RECIPIENT_ACCOUNT, environment: 'production' },
    createRequested: true,
  });
  assert.equal(resumed.create, false);
  assert.equal(resumed.account_id, RECIPIENT_ACCOUNT);
  assert.equal(shouldResumeExistingBank({
    banks: [{ status: 'new', lastFourAccountNumber: '1506' }],
    replaceBank: false,
  }), true);
  assert.doesNotMatch(ui, /moov-recipient-create/);
  assert.doesNotMatch(session, /\/accounts",/);
});

test('READY requires live KYC + ToS + verified bank', () => {
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: { verification: { status: 'verified' }, termsOfService: { acceptedDate: '2026-09-10T00:00:00Z' } },
    banks: [{ status: 'new' }],
    capabilities: [],
    capabilitiesReadOk: true,
  }), false);
  assert.equal(recipientOnboardingCompleteFromMoov({
    account: { verification: { status: 'verified' }, termsOfService: { acceptedDate: '2026-09-10T00:00:00Z' } },
    banks: [{ status: 'verified' }],
    capabilities: [],
    capabilitiesReadOk: true,
  }), true);
  assert.match(ui, /onboarding\?\.complete === true/);
});

test('money flags, SQL72, and webhook config are not changed by this PR surface', () => {
  assert.match(template, /AWS_MOOV_ENABLED: "false"/);
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(template, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.doesNotMatch(ui, /SQL72/);
  assert.doesNotMatch(session, /webhook/);
  assert.doesNotMatch(verify, /transfers\.write/);
});

function loadBlockSafe(source) {
  return source.slice(source.indexOf('async function load()'), source.indexOf('useEffect(() => { void load(); }'));
}
