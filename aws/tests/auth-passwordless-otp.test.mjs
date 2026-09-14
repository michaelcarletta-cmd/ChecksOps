import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleAuthPasswordlessStart,
  handleAuthPasswordlessVerify,
} from '../functions/api/auth-cognito.mjs';

const jsonEvent = (body) => ({
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST' } },
});

const mockCognito = (handler) => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const target = init.headers['x-amz-target'];
    const payload = JSON.parse(init.body);
    return handler({ target, payload, url, init });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = previous; },
  };
};

const cognitoResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

test('passwordless start requires email and does not call Cognito', async () => {
  const fetchMock = mockCognito(() => cognitoResponse(200, {}));
  try {
    const result = await handleAuthPasswordlessStart(jsonEvent({}));
    assert.equal(result.error, 'missing_email');
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('passwordless start rejects a non-EMAIL_OTP challenge without sending a second request', async () => {
  const fetchMock = mockCognito(() => cognitoResponse(200, {
    ChallengeName: 'PASSWORD',
    AvailableChallenges: ['PASSWORD'],
    Session: 'sess-1',
  }));
  try {
    const result = await handleAuthPasswordlessStart(jsonEvent({ email: 'claims@freedomadj.com' }));
    assert.equal(result.error, 'email_otp_unavailable');
    assert.equal(result.challenge, 'PASSWORD');
    assert.equal(result.ok, false);
  } finally {
    fetchMock.restore();
  }
});

test('passwordless verify rejects missing fields and wrong OTP', async () => {
  const missing = await handleAuthPasswordlessVerify(jsonEvent({ email: 'claims@freedomadj.com' }));
  assert.equal(missing.error, 'missing_passwordless_fields');

  const fetchMock = mockCognito(() => cognitoResponse(400, {
    __type: 'CodeMismatchException',
    message: 'Invalid verification code provided, please try again.',
  }));
  try {
    const result = await handleAuthPasswordlessVerify(jsonEvent({
      email: 'claims@freedomadj.com',
      session: 'sess-expired',
      code: '000000',
    }));
    assert.equal(result.error, 'passwordless_verify_failed');
    assert.match(result.message, /Invalid verification code|CodeMismatch/i);
  } finally {
    fetchMock.restore();
  }
});

test('passwordless verify maps expired session and does not mint tokens', async () => {
  const fetchMock = mockCognito(() => cognitoResponse(400, {
    __type: 'NotAuthorizedException',
    message: 'Invalid session for the user.',
  }));
  try {
    const result = await handleAuthPasswordlessVerify(jsonEvent({
      email: 'claims@freedomadj.com',
      session: 'expired-session',
      code: '123456',
    }));
    assert.equal(result.ok, false);
    assert.equal(result.authentication, undefined);
    assert.equal(result.error, 'passwordless_verify_failed');
  } finally {
    fetchMock.restore();
  }
});

test('passwordless verify success returns Cognito tokens only after EMAIL_OTP', async () => {
  const fetchMock = mockCognito(() => cognitoResponse(200, {
    AuthenticationResult: {
      IdToken: 'id.jwt',
      AccessToken: 'access.jwt',
      RefreshToken: 'refresh.jwt',
      ExpiresIn: 3600,
      TokenType: 'Bearer',
    },
  }));
  try {
    const result = await handleAuthPasswordlessVerify(jsonEvent({
      email: 'claims@freedomadj.com',
      session: 'sess-ok',
      code: '654321',
    }));
    assert.equal(result.ok, true);
    assert.equal(result.passwordUsed, false);
    assert.equal(result.authentication.idToken, 'id.jwt');
    const body = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(body.ChallengeName, 'EMAIL_OTP');
    assert.equal(body.ChallengeResponses.EMAIL_OTP_CODE, '654321');
  } finally {
    fetchMock.restore();
  }
});
