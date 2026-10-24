/**
 * Website side of the SQL 113 payee API (aws/functions/api/providers/payees/handlers.mjs):
 * the public /pay-setup/:token step flow, the Settings stakeholder add/resend/disconnect,
 * the per-check "Add someone new" dialog and the homeowner bank-link button.
 *
 * Static checks on the SPA source plus behaviour of src/lib/payeeSetup.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PAYEE_BUSINESS_TYPES,
  PAYEE_LINK_ERRORS,
  PAYEE_MAX_REPRESENTATIVES,
  PAYEE_ROW_COLUMNS,
  PayeeError,
  payeeErrorFrom,
  payeeStatus,
  payeeStepFromSession,
  payeeVerifyMode,
  unwrapPayeeInvoke,
  usPhoneDigits,
} from '../../src/lib/payeeSetup.ts';
import { BUSINESS_TYPES, MAX_REPRESENTATIVES } from '../functions/api/providers/onboarding/store.mjs';
import { moovInstantVerifyBody } from '../functions/api/providers/moov-recipient-tos-policy.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const page = read('src/pages/RecipientPaymentSetup.tsx');
const lib = read('src/lib/payeeSetup.ts');
const settings = read('src/components/disbursement/StakeholderAccountSettings.tsx');
const addExternal = read('src/components/disbursement/AddExternalStakeholderDialog.tsx');
const homeowner = read('src/components/disbursement/SendHomeownerBankLinkDialog.tsx');
const app = read('src/App.tsx');
const spaFiles = { page, lib, settings, addExternal, homeowner };

const session = (onboarding = {}, recipient = {}) => ({
  recipient: { id: 'r1', name: 'Hannah Owner', status: 'invited', recipient_type: 'individual', bank_linked: false, ...recipient },
  onboarding: { terms_accepted: false, identity_submitted: false, bank_verified: false, complete: false, ...onboarding },
  payer: { name: 'Freedom Adjusting', logo_url: null },
  environment: 'sandbox',
});

test('/pay-setup/:token is the public RecipientPaymentSetup route', () => {
  assert.match(app, /path="\/pay-setup\/:token" element=\{<Suspense fallback=\{<PageLoader \/>\}><RecipientPaymentSetup \/><\/Suspense>\}/);
});

test('/pay-setup loads no provider script or hosted component and holds no provider token', () => {
  assert.doesNotMatch(page, /js\.moov\.io/);
  assert.doesNotMatch(page, /moov-terms-of-service/);
  assert.doesNotMatch(page, /customElements/);
  assert.doesNotMatch(page, /document\.createElement\("script"\)/);
  assert.doesNotMatch(page, /oauthToken|accountID|account_id/);
  assert.doesNotMatch(page, /applyMoovTheme|moovTheme/);
  assert.doesNotMatch(page, /terms_of_service_token/);
});

test('/pay-setup calls each public payee function by name with the link token', () => {
  assert.match(page, /invoke\("moov-recipient-session", \{ token \}\)/);
  assert.match(page, /invoke\("moov-recipient-tos-accept", \{ token, accepted: true \}\)/);
  assert.match(page, /invoke\("moov-recipient-kyc-update", payload\)/);
  assert.match(page, /invoke\("moov-recipient-bank-add", payload\)/);
  assert.match(page, /invoke\("moov-recipient-bank-verify", \{ token, action: "initiate" \}\)/);
  assert.match(page, /invoke\("moov-recipient-bank-verify", \{ token, action: "confirm", code: verifyCode \}\)/);
  assert.match(page, /supabase\.functions\.invoke\(fn, \{ body \}\)/);
  // Tenant-side names never appear on the public page.
  assert.doesNotMatch(page, /moov-recipient-create|moov-recipient-link-resend|moov-recipient-disconnect|homeowner-bank-link-send/);
});

test('/pay-setup sends the identity and bank fields the server validators read', () => {
  for (const field of ['first_name', 'last_name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'birth_date', 'ssn']) {
    assert.match(page, new RegExp(`\\b${field}:`), `individual ${field}`);
  }
  for (const field of ['legal_name', 'type', 'ein', 'phone', 'website', 'description', 'address']) {
    assert.match(page, new RegExp(`\\b${field}:`), `business ${field}`);
  }
  assert.match(page, /representatives: reps\.map/);
  for (const field of ['first_name', 'last_name', 'dob', 'ssn', 'title', 'ownership_pct', 'is_owner', 'is_controller', 'address']) {
    assert.match(page, new RegExp(`\\b${field}:`), `representative ${field}`);
  }
  for (const field of ['holder_name', 'holder_type', 'bank_account_type', 'routing_number', 'account_number', 'replace_bank']) {
    assert.match(page, new RegExp(`\\b${field}:`), `bank ${field}`);
  }
  assert.match(page, /account_number_confirm/);
  assert.match(page, /account !== confirm/);
  // Business types and the representative limit match the server's.
  assert.deepEqual(PAYEE_BUSINESS_TYPES.map((t) => t.value).sort(), [...BUSINESS_TYPES].sort());
  assert.equal(PAYEE_MAX_REPRESENTATIVES, MAX_REPRESENTATIVES);
});

test('SSN, EIN, dates of birth and bank numbers are masked, never in state or storage, and cleared after submit', () => {
  for (const [name, src] of Object.entries(spaFiles)) {
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/, `${name} uses browser storage`);
    assert.doesNotMatch(src, /console\.(log|info|warn|error|debug)/, `${name} logs`);
  }
  // Sensitive inputs are uncontrolled: no value= binding, read from the form on submit.
  for (const name of ['ssn', 'business-ein', 'routing_number', 'account_number', 'account_number_confirm', 'birth_date']) {
    const tag = page.match(new RegExp(`<Input id="${name}" name="${name}"[\\s\\S]*?/>`));
    assert.ok(tag, `input ${name}`);
    assert.doesNotMatch(tag[0], /value=/, `${name} is not bound to state`);
    assert.match(tag[0], /\{\.\.\.SENSITIVE_PROPS\}/, `${name} is marked sensitive`);
  }
  for (const name of ['ssn', 'business-ein', 'account_number', 'account_number_confirm']) {
    const tag = page.match(new RegExp(`<Input id="${name}" name="${name}"[\\s\\S]*?/>`))[0];
    assert.match(tag, /type="password"/, `${name} is masked`);
  }
  assert.match(page, /name=\{`\$\{r\.key\}-ssn`\} type="password"/);
  assert.doesNotMatch(page, /useState\([^)]*\b(ssn|ein|account_number|routing_number)\b/);
  assert.doesNotMatch(page, /\b(ssn|ein|account_number|routing_number|birth_date):\s*""/, 'no state slot for a sensitive field');
  assert.match(page, /ssn: readDigits\(form, "ssn", 9\)/);
  assert.match(page, /ein: readDigits\(form, "business-ein", 9\)/);
  assert.match(page, /const account = readDigits\(form, "account_number", 17\)/);
  // Cleared from the form right after it is read, before the call.
  const identityFn = page.slice(page.indexOf('async function submitIdentity'), page.indexOf('async function submitBank'));
  assert.ok(identityFn.indexOf('clearSensitive(form)') < identityFn.indexOf('invoke("moov-recipient-kyc-update"'));
  const bankFn = page.slice(page.indexOf('async function submitBank'), page.indexOf('async function initiateBankVerify'));
  assert.ok(bankFn.indexOf('clearSensitive(form)') < bankFn.indexOf('invoke("moov-recipient-bank-add"'));
  assert.match(page, /querySelectorAll<HTMLInputElement>\("input\[data-sensitive\]"\)\.forEach\(\(el\) => \{ el\.value = ""; \}\)/);
});

test('user-facing text never names the payment provider', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/"(moov-recipient-[a-z-]+)"/g, '""');
  for (const [name, src] of Object.entries(spaFiles)) {
    const body = strip(src);
    assert.doesNotMatch(body, /moov/i, `${name} names the provider outside a function name`);
  }
  // The verification code prefix is the deposit description, not a vendor name.
  assert.match(page, /<span className="font-mono text-sm px-2 py-2 rounded-md border bg-muted">MV<\/span>/);
  assert.deepEqual(moovInstantVerifyBody('1234'), { code: 'MV1234' });
});

test('step flow resumes from the session state', () => {
  assert.equal(payeeStepFromSession(session()), 'terms');
  assert.equal(payeeStepFromSession(session({ terms_accepted: true })), 'identity');
  assert.equal(payeeStepFromSession(session({ terms_accepted: true, identity_submitted: true })), 'bank');
  assert.equal(payeeStepFromSession(session({ terms_accepted: true, identity_submitted: true }, { bank_linked: true })), 'verify');
  assert.equal(payeeStepFromSession(session({ terms_accepted: true, identity_submitted: true }, { bank_linked: true }), { replaceBank: true }), 'bank');
  assert.equal(payeeStepFromSession(session({ terms_accepted: true, identity_submitted: true, bank_verified: true }, { bank_linked: true })), 'done');
  assert.equal(payeeStepFromSession(session({ complete: true })), 'done');
  assert.equal(payeeVerifyMode(session({ bank_should_initiate: true })), 'initiate');
  assert.equal(payeeVerifyMode(session({ bank_micro_deposits_initiated: true })), 'confirm');
  assert.equal(payeeVerifyMode(session({ bank_can_confirm: true, bank_should_initiate: true })), 'confirm');
  assert.equal(payeeVerifyMode(session({})), 'wait');
  // Page load only reads the session.
  const loadBlock = page.slice(page.indexOf('async function load()'), page.indexOf('useEffect(() => { void load(); }'));
  assert.match(loadBlock, /moov-recipient-session/);
  assert.doesNotMatch(loadBlock, /tos-accept|kyc-update|bank-add|bank-verify/);
});

test('link and field errors map to clear messages without values', async () => {
  for (const code of ['link_invalid', 'link_expired', 'link_closed', 'rate_limited']) {
    assert.ok(PAYEE_LINK_ERRORS[code]?.title, code);
    const err = payeeErrorFrom({ error: code, message: 'server text' }, 410);
    assert.equal(err.code, code);
    assert.equal(err.message, PAYEE_LINK_ERRORS[code].message);
    assert.doesNotMatch(err.message, /moov/i);
  }
  const missing = payeeErrorFrom({ error: 'identity_fields_incomplete', missing: ['ssn', 'birthdate'], message: 'Complete every field to continue.' }, 400);
  assert.equal(missing.message, 'Complete every field to continue. Check: Social Security number, date of birth.');
  const rejected = payeeErrorFrom({ error: 'provider_rejected', rejected_fields: ['individual.ssn'], message: 'The payment provider did not accept these details. Check them and try again.' }, 422);
  assert.match(rejected.message, /Check: Social Security number\.$/);
  const field = payeeErrorFrom({ error: 'validation_failed', field: 'business.ein', message: 'Provide a valid 9-digit EIN.' }, 400);
  assert.equal(field.field, 'business.ein');
  assert.equal(field.message, 'Provide a valid 9-digit EIN.');

  // AWS adapter shape (data + context.body) and Supabase shape (context Response).
  await assert.rejects(
    unwrapPayeeInvoke({ data: { error: 'link_expired' }, error: { name: 'FunctionsHttpError', context: { status: 410, body: { error: 'link_expired' } } } }),
    (e) => e instanceof PayeeError && e.code === 'link_expired' && e.status === 410,
  );
  await assert.rejects(
    unwrapPayeeInvoke({ data: null, error: { context: { status: 429, clone: () => ({ json: async () => ({ error: 'rate_limited' }) }) } } }),
    (e) => e instanceof PayeeError && e.code === 'rate_limited' && e.status === 429,
  );
  assert.deepEqual(await unwrapPayeeInvoke({ data: { success: true, recipient_id: 'r1' }, error: null }), { success: true, recipient_id: 'r1' });
  assert.match(page, /if \(isPayeeLinkError\(e\.code\)\) \{ setLinkError\(e\.code\); return; \}/);
});

test('phone is sent as 10 digits (the server keeps the first 10)', () => {
  assert.equal(usPhoneDigits('+1 (512) 555-0100'), '5125550100');
  assert.equal(usPhoneDigits('512.555.0100'), '5125550100');
  assert.match(page, /phone: usPhoneDigits\(person\.phone\)/);
  assert.match(page, /phone: usPhoneDigits\(business\.phone\)/);
});

test('Settings stakeholders: created through moov-recipient-create, never a direct stakeholder insert', () => {
  assert.match(settings, /supabase\.functions\.invoke\("moov-recipient-create", \{/);
  assert.match(settings, /recipient_type: values\.recipient_type/);
  assert.match(settings, /relationship: values\.account_type/);
  assert.match(settings, /email: values\.email\.trim\(\)\.toLowerCase\(\)/);
  assert.match(settings, /request_id: requestId/);
  assert.doesNotMatch(settings, /from\("stakeholder_accounts"\)\s*\.insert/);
  assert.doesNotMatch(settings, /chk_aba|stakeholder-resend-verification|send_method/);
  assert.match(settings, /\{t === "individual" \? "Individual" : "Business"\}/);
});

test('Settings stakeholders: status from the payee row, Resend link and Disconnect actions', () => {
  assert.match(settings, /from\("external_payment_recipients"\)\s*\.select\(PAYEE_ROW_COLUMNS\)/);
  assert.doesNotMatch(PAYEE_ROW_COLUMNS, /secure_token/, 'the link token is never read');
  for (const col of ['tos_accepted_at', 'identity_submitted_at', 'bank_verified_at', 'verified_at', 'disconnected_at', 'provider_last_four', 'provider_bank_name', 'stakeholder_account_id']) {
    assert.match(PAYEE_ROW_COLUMNS, new RegExp(`\\b${col}\\b`), col);
  }
  assert.match(settings, /supabase\.functions\.invoke\("moov-recipient-link-resend", \{\s*body: \{ recipient_id: payee\.id \}/);
  assert.match(settings, /supabase\.functions\.invoke\("moov-recipient-disconnect", \{\s*body: \{ recipient_id: payee\.id \}/);
  assert.match(settings, /Resend link/);
  assert.match(settings, /Disconnect/);
  const row = { id: 'r', stakeholder_account_id: 's', display_name: 'A', email: 'a@x.test', recipient_type: 'individual', relationship: 'vendor',
    onboarding_status: 'invited', token_expires_at: '2999-01-01T00:00:00Z', tos_accepted_at: null, identity_submitted_at: null,
    bank_linked_at: null, bank_verified_at: null, verified_at: null, disconnected_at: null, provider_bank_name: null, provider_last_four: null };
  assert.equal(payeeStatus(row), 'link_sent');
  assert.equal(payeeStatus({ ...row, tos_accepted_at: 'x' }), 'in_progress');
  assert.equal(payeeStatus({ ...row, onboarding_status: 'pending_review' }), 'in_review');
  assert.equal(payeeStatus({ ...row, onboarding_status: 'failed' }), 'failed');
  assert.equal(payeeStatus({ ...row, verified_at: 'x' }), 'verified');
  assert.equal(payeeStatus({ ...row, verified_at: 'x', disconnected_at: 'y' }), 'disconnected');
  assert.equal(payeeStatus({ ...row, token_expires_at: '2000-01-01T00:00:00Z' }), 'link_expired');
});

test('per-check Add someone new: moov-recipient-create then only the check link; no link shown or emailed by the browser', () => {
  assert.match(addExternal, /supabase\.functions\.invoke\("moov-recipient-create", \{/);
  assert.match(addExternal, /recipient_type: recipientType/);
  assert.match(addExternal, /relationship,/);
  assert.match(addExternal, /check_id: checkIntakeItemId/);
  assert.doesNotMatch(addExternal, /from\("stakeholder_accounts"\)/);
  assert.doesNotMatch(addExternal, /send-transactional-email|secure_link|clipboard/);
  assert.match(addExternal, /from\("check_stakeholders"\)\.insert\(\{[\s\S]*stakeholder_account_id: created\.stakeholder_account_id/);
  assert.match(addExternal, /Setup link emailed to/);
});

test('homeowner button: homeowner-bank-link-send body stays compatible; shows "setup link emailed", never a URL', () => {
  assert.match(homeowner, /supabase\.functions\.invoke\("homeowner-bank-link-send", \{ body \}\)/);
  for (const field of ['tenant_id', 'scope', 'homeowner_name', 'homeowner_email', 'request_id']) {
    assert.match(homeowner, new RegExp(`\\b${field}[:,]`), field);
  }
  assert.match(homeowner, /body\.check_intake_item_id = checkIntakeItemId/);
  assert.match(homeowner, /body\.claim_id = claimId/);
  assert.doesNotMatch(homeowner, /payout_url|clipboard|window\.open/);
  assert.match(homeowner, /Setup link emailed/);
  assert.match(homeowner, /queriesInvalidatedAfterBankLinkSend/);
});
