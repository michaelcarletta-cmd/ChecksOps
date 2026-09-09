import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  handleMfaAssociate,
  handleMfaSetPreference,
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

test('verify calls VerifySoftwareToken and does not set preferred MFA', async () => {
  const { result, calls } = await withCognito(handleMfaVerify, [{
    body: { Status: 'SUCCESS' },
  }], () => handleMfaVerify(eventOf({
    accessToken: 'cognito-access-token',
    code: '123456',
  })));
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.enrollment, true);
  assert.equal(result.preferredMfaEnabled, false);
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.VerifySoftwareToken');
  assert.equal(calls[0].hasAccessToken, true);
  const preference = await handleMfaSetPreference();
  assert.equal(preference.ok, false);
  assert.equal(preference.statusCode, 403);
  assert.equal(preference.error, 'cognito_preferred_mfa_disabled');
});

test('enroll path does not log or persist SecretCode', () => {
  const files = [
    'aws/functions/api/auth-mfa.mjs',
    'src/lib/awsMfa.ts',
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
