import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  availableChallengesOf,
  emailOtpIsListed,
  handleAuthPasswordlessStart,
  handleAuthPasswordlessVerify,
  selectEmailOtpChallengeRequest,
} from '../functions/api/auth-cognito.mjs';
import {
  evaluateCognitoTotpEnrollment,
  handleMfaSetPreference,
  handleMfaStepUp,
} from '../functions/api/auth-mfa.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EMAIL = 'mcarletta@freedomadj.com';
const CLIENT = 'test-client-id';

process.env.COGNITO_CLIENT_ID = CLIENT;

const eventOf = (body) => ({ body: JSON.stringify(body) });

const withCognito = async (replies, run) => {
  const calls = [];
  const prev = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    const target = headers['x-amz-target'] || headers['X-Amz-Target'] || '';
    const parsed = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), target, parsed });
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

test('availableChallenges helper lists EMAIL_OTP without treating SOFTWARE_TOKEN_MFA as email OTP', () => {
  const totpFirst = {
    ChallengeName: 'SOFTWARE_TOKEN_MFA',
    AvailableChallenges: ['EMAIL_OTP', 'WEB_AUTHN'],
  };
  assert.equal(emailOtpIsListed(totpFirst), true);
  assert.deepEqual(availableChallengesOf(totpFirst), ['EMAIL_OTP', 'WEB_AUTHN']);
  assert.equal(emailOtpIsListed({ ChallengeName: 'SOFTWARE_TOKEN_MFA', AvailableChallenges: ['WEB_AUTHN'] }), false);
  const payload = selectEmailOtpChallengeRequest(EMAIL, 'session-1', CLIENT);
  assert.equal(payload.ChallengeName, 'SELECT_CHALLENGE');
  assert.equal(payload.ChallengeResponses.ANSWER, 'EMAIL_OTP');
  assert.equal(payload.ChallengeResponses.USERNAME, EMAIL);
  assert.equal(payload.Session, 'session-1');
});

test('passwordless start returns EMAIL_OTP immediately when Cognito issues it', async () => {
  const { result, calls } = await withCognito([{
    body: {
      ChallengeName: 'EMAIL_OTP',
      Session: 'email-otp-session',
      ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'm***@f***' },
    },
  }], () => handleAuthPasswordlessStart(eventOf({ email: EMAIL })));

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.challenge, 'EMAIL_OTP');
  assert.equal(result.session, 'email-otp-session');
  assert.equal(result.passwordUsed, false);
  assert.equal(result.delivery.deliveryMedium, 'EMAIL');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.InitiateAuth');
  assert.equal(calls[0].parsed.AuthFlow, 'USER_AUTH');
  assert.equal(calls[0].parsed.AuthParameters.PREFERRED_CHALLENGE, 'EMAIL_OTP');
});

test('SOFTWARE_TOKEN_MFA with EMAIL_OTP available selects EMAIL_OTP via SELECT_CHALLENGE', async () => {
  const { result, calls } = await withCognito([
    {
      body: {
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: 'totp-session',
        AvailableChallenges: ['EMAIL_OTP', 'WEB_AUTHN'],
      },
    },
    {
      body: {
        ChallengeName: 'EMAIL_OTP',
        Session: 'email-otp-after-select',
        ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'm***@f***' },
      },
    },
  ], () => handleAuthPasswordlessStart(eventOf({ email: EMAIL })));

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.challenge, 'EMAIL_OTP');
  assert.equal(result.session, 'email-otp-after-select');
  assert.equal(result.passwordUsed, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.InitiateAuth');
  assert.equal(calls[0].parsed.AuthParameters.PREFERRED_CHALLENGE, 'EMAIL_OTP');
  assert.equal(calls[1].target, 'AWSCognitoIdentityProviderService.RespondToAuthChallenge');
  assert.equal(calls[1].parsed.ChallengeName, 'SELECT_CHALLENGE');
  assert.equal(calls[1].parsed.Session, 'totp-session');
  assert.equal(calls[1].parsed.ChallengeResponses.ANSWER, 'EMAIL_OTP');
  assert.equal(calls[1].parsed.ChallengeResponses.USERNAME, EMAIL);
  assert.equal(calls[1].parsed.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE, undefined);
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /SetUserMFAPreference|AdminSetUserMFAPreference|PreferredMfa|AdminSetUserPassword/);
});

test('SELECT_CHALLENGE with EMAIL_OTP available selects EMAIL_OTP without a second InitiateAuth', async () => {
  const { result, calls } = await withCognito([
    {
      body: {
        ChallengeName: 'SELECT_CHALLENGE',
        Session: 'choice-session',
        AvailableChallenges: ['EMAIL_OTP', 'PASSWORD', 'WEB_AUTHN'],
      },
    },
    {
      body: {
        ChallengeName: 'EMAIL_OTP',
        Session: 'email-otp-session',
        ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'm***@f***' },
      },
    },
  ], () => handleAuthPasswordlessStart(eventOf({ email: EMAIL })));

  assert.equal(result.ok, true);
  assert.equal(result.challenge, 'EMAIL_OTP');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].parsed.ChallengeName, 'SELECT_CHALLENGE');
  assert.equal(calls[1].parsed.Session, 'choice-session');
});

test('SOFTWARE_TOKEN_MFA without EMAIL_OTP fails closed and does not select a challenge', async () => {
  const { result, calls } = await withCognito([{
    body: {
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      Session: 'totp-only-session',
      AvailableChallenges: ['WEB_AUTHN'],
    },
  }], () => handleAuthPasswordlessStart(eventOf({ email: EMAIL })));

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'email_otp_unavailable');
  assert.equal(result.challenge, 'SOFTWARE_TOKEN_MFA');
  assert.deepEqual(result.availableChallenges, ['WEB_AUTHN']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.InitiateAuth');
});

test('SELECT_CHALLENGE that does not yield EMAIL_OTP after selection fails closed', async () => {
  const { result, calls } = await withCognito([
    {
      body: {
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: 'totp-session',
        AvailableChallenges: ['EMAIL_OTP', 'WEB_AUTHN'],
      },
    },
    {
      body: {
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: 'still-totp-session',
        AvailableChallenges: ['WEB_AUTHN'],
      },
    },
  ], () => handleAuthPasswordlessStart(eventOf({ email: EMAIL })));

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'email_otp_unavailable');
  assert.equal(result.challenge, 'SOFTWARE_TOKEN_MFA');
  assert.deepEqual(result.availableChallenges, ['WEB_AUTHN']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].parsed.ChallengeName, 'SELECT_CHALLENGE');
  assert.equal(calls[1].parsed.ChallengeResponses.ANSWER, 'EMAIL_OTP');
});

test('SELECT_CHALLENGE with only password factors fails closed without selecting EMAIL_OTP', async () => {
  const { result, calls } = await withCognito([{
    body: {
      ChallengeName: 'SELECT_CHALLENGE',
      Session: 'password-only-session',
      AvailableChallenges: ['PASSWORD', 'PASSWORD_SRP'],
    },
  }], () => handleAuthPasswordlessStart(eventOf({ email: EMAIL })));

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'email_otp_unavailable');
  assert.equal(result.challenge, 'SELECT_CHALLENGE');
  assert.deepEqual(result.availableChallenges, ['PASSWORD', 'PASSWORD_SRP']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.InitiateAuth');
});

test('invalid or expired email OTP code fails closed without issuing tokens', async () => {
  const mismatch = await withCognito([{
    ok: false,
    status: 400,
    body: { __type: 'CodeMismatchException', message: 'Invalid verification code provided, please try again.' },
  }], () => handleAuthPasswordlessVerify(eventOf({
    email: EMAIL,
    session: 'email-otp-session',
    code: '000000',
  })));
  assert.equal(mismatch.result.ok, false);
  assert.equal(mismatch.result.error, 'passwordless_verify_failed');
  assert.equal(mismatch.result.authentication, undefined);
  assert.equal(mismatch.calls[0].parsed.ChallengeName, 'EMAIL_OTP');
  assert.equal(mismatch.calls[0].parsed.ChallengeResponses.EMAIL_OTP_CODE, '000000');

  const expired = await withCognito([{
    ok: false,
    status: 400,
    body: { __type: 'ExpiredCodeException', message: 'Invalid code provided, please request a code again.' },
  }], () => handleAuthPasswordlessVerify(eventOf({
    email: EMAIL,
    session: 'stale-session',
    code: '123456',
  })));
  assert.equal(expired.result.ok, false);
  assert.equal(expired.result.error, 'passwordless_verify_failed');
  assert.equal(expired.result.authentication, undefined);
});

test('financial TOTP step-up remains enrolled without preferred MFA and passwordless does not change it', async () => {
  const enrolled = evaluateCognitoTotpEnrollment({
    UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
    PreferredMfaSetting: null,
  });
  assert.equal(enrolled.totpEnrolled, true);
  assert.equal(enrolled.preferredMfa, null);

  const preference = await handleMfaSetPreference();
  assert.equal(preference.ok, false);
  assert.equal(preference.statusCode, 403);
  assert.equal(preference.error, 'cognito_preferred_mfa_disabled');

  const stepUp = await withCognito([
    { body: { UserMFASettingList: ['SOFTWARE_TOKEN_MFA'], PreferredMfaSetting: null } },
    { body: { Status: 'SUCCESS' } },
  ], () => handleMfaStepUp(eventOf({
    accessToken: 'cognito-access-token',
    code: '654321',
    check_intake_item_id: 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6',
  })));
  assert.notEqual(stepUp.result.error, 'totp_not_enrolled');
  assert.equal(stepUp.calls[0].target, 'AWSCognitoIdentityProviderService.GetUser');
  assert.equal(stepUp.calls[1].target, 'AWSCognitoIdentityProviderService.VerifySoftwareToken');
  assert.equal(stepUp.calls[1].parsed.UserCode, '654321');

  const source = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-cognito.mjs'), 'utf8');
  assert.doesNotMatch(source, /SetUserMFAPreference|AdminSetUserMFAPreference|AdminSetUserPassword/);
  assert.match(source, /SELECT_CHALLENGE/);
  assert.match(source, /ANSWER: EMAIL_OTP/);
});
