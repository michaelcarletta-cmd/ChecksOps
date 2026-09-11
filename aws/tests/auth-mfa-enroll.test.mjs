import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  evaluateCognitoTotpEnrollment,
  handleMfaAssociate,
  handleMfaSetPreference,
  handleMfaStepUp,
  handleMfaVerify,
  MFA_AUTH_ROUTES,
} from '../functions/api/auth-mfa.mjs';
import { AUTH_ROUTES } from '../functions/api/auth-cognito.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const eventOf = (body, headers = {}) => ({
  headers,
  body: body ? JSON.stringify(body) : undefined,
});

test('MFA enroll and verify routes are wired for POST /auth/mfa/*', () => {
  assert.equal(AUTH_ROUTES['/auth/mfa/associate'], MFA_AUTH_ROUTES['/auth/mfa/associate']);
  assert.equal(AUTH_ROUTES['/auth/mfa/verify'], MFA_AUTH_ROUTES['/auth/mfa/verify']);
  assert.equal(AUTH_ROUTES['/auth/mfa/set-preference'], MFA_AUTH_ROUTES['/auth/mfa/set-preference']);
});

test('financial TOTP enrollment requires an application identity, not a Cognito access token', async () => {
  const result = await handleMfaAssociate(eventOf({ email: 'mcarletta@freedomadj.com' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_cognito_token');
});

test('auth-mfa delegates to application financial TOTP and does not call Cognito software-token APIs', () => {
  const mfa = sourceOf('aws/functions/api/auth-mfa.mjs');
  const financial = sourceOf('aws/functions/api/auth-financial-totp.mjs');
  assert.match(mfa, /from '\.\/auth-financial-totp\.mjs'/);
  assert.doesNotMatch(mfa, /AssociateSoftwareToken|VerifySoftwareToken|SetUserMFAPreference/);
  assert.doesNotMatch(financial, /AssociateSoftwareToken|VerifySoftwareToken|SetUserMFAPreference/);
  assert.match(financial, /financial_totp_upsert_enrollment/);
  assert.match(financial, /INSERT INTO public\.financial_stepup_log/);
});

test('Cognito preferred MFA remains disabled', async () => {
  const preference = await handleMfaSetPreference();
  assert.equal(preference.ok, false);
  assert.equal(preference.statusCode, 403);
  assert.equal(preference.error, 'cognito_preferred_mfa_disabled');
});

test('evaluateCognitoTotpEnrollment is diagnostic only and ignores preferred MFA', () => {
  const missing = evaluateCognitoTotpEnrollment({ UserMFASettingList: [], PreferredMfaSetting: null });
  assert.equal(missing.totpEnrolled, false);
  const enrolledUnset = evaluateCognitoTotpEnrollment({
    UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
    PreferredMfaSetting: null,
  });
  assert.equal(enrolledUnset.totpEnrolled, true);
  assert.equal(enrolledUnset.preferredMfa, null);
  const enrolledPreferred = evaluateCognitoTotpEnrollment({
    UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
    PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
  });
  assert.equal(enrolledPreferred.totpEnrolled, true);
});

test('financial step-up requires identity and does not call Cognito GetUser', async () => {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    calls.push(headers['x-amz-target'] || headers['X-Amz-Target'] || String(url));
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    const unenrolled = await handleMfaStepUp(eventOf({
      accessToken: 'cognito-access-token',
      code: '123456',
    }));
    assert.equal(unenrolled.ok, false);
    assert.equal(unenrolled.error, 'missing_cognito_token');
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = prev;
  }
});

test('step-up keeps TOTP as a 6-digit string and rejects numeric coercion', async () => {
  const numeric = await handleMfaStepUp(eventOf({
    accessToken: 'cognito-access-token',
    code: 123456,
  }));
  assert.equal(numeric.ok, false);
  assert.equal(numeric.error, 'totp_must_be_string');

  const verifyNumeric = await handleMfaVerify(eventOf({
    accessToken: 'cognito-access-token',
    code: 654321,
  }));
  assert.equal(verifyNumeric.ok, false);
  assert.equal(verifyNumeric.error, 'totp_must_be_string');
});

test('enroll path does not log or persist SecretCode', () => {
  const files = [
    'aws/functions/api/auth-mfa.mjs',
    'aws/functions/api/auth-financial-totp.mjs',
    'aws/functions/api/financial-totp.mjs',
    'aws/functions/api/auth-totp-code.mjs',
    'src/lib/awsMfa.ts',
    'src/lib/totpCode.ts',
    'src/lib/totpEnrollment.ts',
    'src/lib/totpQr.ts',
    'src/components/auth/TotpManagerCard.tsx',
    'src/components/auth/StepUpDialog.tsx',
    'src/components/auth/TotpQrDisplay.tsx',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /console\.(log|info|debug|warn|error)\([^)]*(secret|SecretCode|otpauth)/i);
    assert.doesNotMatch(text, /INSERT[\s\S]{0,200}SecretCode/i);
    assert.doesNotMatch(text, /localStorage\.setItem\([^)]*(secret|otpauth)/i);
    assert.doesNotMatch(text, /sessionStorage\.setItem\([^)]*(secret|otpauth)/i);
  }
});
