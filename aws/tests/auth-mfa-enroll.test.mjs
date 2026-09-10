import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  evaluateCognitoTotpEnrollment,
  handleMfaAssociate,
  handleMfaSetPreference,
  handleMfaStatus,
  handleMfaStepUp,
  handleMfaVerify,
  MFA_AUTH_ROUTES,
} from '../functions/api/auth-mfa.mjs';
import { AUTH_ROUTES } from '../functions/api/auth-cognito.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_SECRET = 'MFRGGZDFMZTWQ2LK';

const eventOf = (body, headers = {}) => ({
  headers,
  body: body ? JSON.stringify(body) : undefined,
});

const withCognito = async (handler, replies, run) => {
  const calls = [];
  const prev = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    const target = headers['x-amz-target'] || headers['X-Amz-Target'] || '';
    const parsed = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), target, hasAccessToken: Boolean(parsed.AccessToken), keys: Object.keys(parsed) });
    const reply = replies[index] || replies[replies.length - 1];
    index += 1;
    return {
      ok: reply.ok !== false,
      status: reply.status || (reply.ok === false ? 400 : 200),
      text: async () => JSON.stringify(reply.body || {}),
    };
  };
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = prev;
  }
};

test('MFA enroll and verify routes are wired for POST /auth/mfa/*', () => {
  assert.equal(AUTH_ROUTES['/auth/mfa/associate'], MFA_AUTH_ROUTES['/auth/mfa/associate']);
  assert.equal(AUTH_ROUTES['/auth/mfa/verify'], MFA_AUTH_ROUTES['/auth/mfa/verify']);
  assert.equal(AUTH_ROUTES['/auth/mfa/set-preference'], MFA_AUTH_ROUTES['/auth/mfa/set-preference']);
});

test('associate fails closed without an access token', async () => {
  const result = await handleMfaAssociate(eventOf({ email: 'mcarletta@freedomadj.com' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_access_token');
  assert.equal(result.cognitoMfaPreferred, false);
});

test('associate calls AssociateSoftwareToken and returns otpauth_uri without a server QR', async () => {
  const { result, calls } = await withCognito(handleMfaAssociate, [{
    body: { SecretCode: TEST_SECRET },
  }], () => handleMfaAssociate(eventOf({
    accessToken: 'cognito-access-token',
    email: 'tester@example.com',
  })));
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.AssociateSoftwareToken');
  assert.equal(calls[0].hasAccessToken, true);
  assert.equal(result.totp.qr_code, null);
  assert.match(String(result.totp.otpauth_uri), /^otpauth:\/\/totp\//);
  assert.equal(result.cognitoMfaPreferred, false);
  assert.equal(result.financialPermissionsActivated, false);
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /SecretCode/);
});

test('verify calls VerifySoftwareToken then enables SOFTWARE_TOKEN_MFA without preferring it', async () => {
  const { result, calls } = await withCognito(handleMfaVerify, [
    { body: { Status: 'SUCCESS' } },
    { body: {} },
    { body: { UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] } },
  ], () => handleMfaVerify(eventOf({
    accessToken: 'cognito-access-token',
    code: '123456',
  })));
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.enrollment, true);
  assert.equal(result.preferredMfaEnabled, false);
  assert.equal(result.preferredMfa, null);
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.VerifySoftwareToken');
  assert.equal(calls[0].hasAccessToken, true);
  assert.equal(calls[1].target, 'AWSCognitoIdentityProviderService.SetUserMFAPreference');
  assert.deepEqual(calls[1].keys, ['AccessToken', 'SoftwareTokenMfaSettings']);
  const preference = await handleMfaSetPreference();
  assert.equal(preference.ok, false);
  assert.equal(preference.statusCode, 403);
  assert.equal(preference.error, 'cognito_preferred_mfa_disabled');
});

test('verify enable-without-prefer sends Enabled true and PreferredMfa false', async () => {
  const payloads = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const headers = init.headers || {};
    const target = headers['x-amz-target'] || '';
    const parsed = init.body ? JSON.parse(init.body) : {};
    payloads.push({ target, parsed });
    if (String(target).endsWith('VerifySoftwareToken')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ Status: 'SUCCESS' }) };
    }
    if (String(target).endsWith('SetUserMFAPreference')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }),
    };
  };
  try {
    const result = await handleMfaVerify(eventOf({ accessToken: 'cognito-access-token', code: '123456' }));
    assert.equal(result.ok, true);
    const enable = payloads.find((row) => String(row.target).endsWith('SetUserMFAPreference'));
    assert.equal(enable.parsed.SoftwareTokenMfaSettings.Enabled, true);
    assert.equal(enable.parsed.SoftwareTokenMfaSettings.PreferredMfa, false);
    assert.equal(Object.prototype.hasOwnProperty.call(enable.parsed, 'SMSMfaSettings'), false);
  } finally {
    globalThis.fetch = prev;
  }
});

test('status treats UserMFASettingList as enrollment and ignores PreferredMfaSetting', async () => {
  const cases = [
    { list: ['SOFTWARE_TOKEN_MFA'], preferred: null, enrolled: true },
    { list: ['SOFTWARE_TOKEN_MFA'], preferred: 'SOFTWARE_TOKEN_MFA', enrolled: true },
    { list: [], preferred: null, enrolled: false },
    { list: [], preferred: 'SOFTWARE_TOKEN_MFA', enrolled: false },
  ];
  for (const row of cases) {
    const { result } = await withCognito(handleMfaStatus, [
      { body: { UserMFASettingList: row.list, PreferredMfaSetting: row.preferred } },
      { body: { Credentials: [] } },
    ], () => handleMfaStatus(eventOf({ accessToken: 'cognito-access-token' })));
    assert.equal(result.ok, true, JSON.stringify(row));
    assert.equal(result.totpEnrolled, row.enrolled, JSON.stringify(row));
    assert.equal(result.preferredMfa, row.preferred);
    assert.equal(result.cognitoMfaPreferred, false);
  }
});

test('financial step-up recognizes SOFTWARE_TOKEN_MFA without preferred MFA', async () => {
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

  const unenrolled = await withCognito(handleMfaStepUp, [{
    body: { UserMFASettingList: [], PreferredMfaSetting: null },
  }], () => handleMfaStepUp(eventOf({
    accessToken: 'cognito-access-token',
    code: '123456',
  })));
  assert.equal(unenrolled.result.ok, false);
  assert.equal(unenrolled.result.error, 'totp_not_enrolled');
  assert.equal(unenrolled.calls.length, 1);
  assert.equal(unenrolled.calls[0].target, 'AWSCognitoIdentityProviderService.GetUser');

  const recognized = await withCognito(handleMfaStepUp, [
    { body: { UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] } },
    { body: { Status: 'SUCCESS' } },
  ], () => handleMfaStepUp(eventOf({
    accessToken: 'cognito-access-token',
    code: '654321',
    check_intake_item_id: 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6',
  })));
  assert.notEqual(recognized.result.error, 'totp_not_enrolled');
  assert.equal(recognized.calls[0].target, 'AWSCognitoIdentityProviderService.GetUser');
  assert.equal(recognized.calls[1].target, 'AWSCognitoIdentityProviderService.VerifySoftwareToken');
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

test('leading-zero TOTP string is forwarded to VerifySoftwareToken as UserCode', async () => {
  const captured = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    const target = headers['x-amz-target'] || headers['X-Amz-Target'] || '';
    const parsed = init.body ? JSON.parse(init.body) : {};
    captured.push({ target, userCode: parsed.UserCode, userCodeType: typeof parsed.UserCode });
    if (target.endsWith('GetUser')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ Status: 'SUCCESS' }) };
  };
  try {
    await handleMfaStepUp(eventOf({
      accessToken: 'cognito-access-token',
      code: '012345',
      check_intake_item_id: 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6',
    }));
  } finally {
    globalThis.fetch = prev;
  }
  const verify = captured.find((row) => row.target.endsWith('VerifySoftwareToken'));
  assert.equal(verify.userCodeType, 'string');
  assert.equal(verify.userCode, '012345');
});

test('Cognito code mismatch returns a safe wait-for-new-code message', async () => {
  const { result } = await withCognito(handleMfaStepUp, [
    { body: { UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] } },
    {
      ok: false,
      status: 400,
      body: { __type: 'CodeMismatchException', message: 'Unable to verify secret code.' },
    },
  ], () => handleMfaStepUp(eventOf({
    accessToken: 'cognito-access-token',
    code: '111111',
  })));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'mfa_step_up_failed');
  assert.match(result.message, /Wait for a new code in your authenticator app/i);
  assert.doesNotMatch(result.message, /CodeMismatch|VerifySoftwareToken|Cognito/i);
});

test('enroll path does not log or persist SecretCode', () => {
  const files = [
    'aws/functions/api/auth-mfa.mjs',
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
