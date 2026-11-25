/**
 * Owner 2026-11-25: "build the friendlier message". Since #2068 checkalt-submit answers
 * 503 { error: 'checkalt_auth_unavailable', message: '... Nothing was sent ...' } when the CheckAlt
 * sign-in fails before the deposit is claimed. The website built its error from body.error first, so
 * the deposit screen showed the raw code. It now shows a plain sentence.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHECKALT_AUTH_UNAVAILABLE_USER_ERROR,
  CHECKALT_PROVIDER_UNAVAILABLE,
  checkAltProviderUserMessage,
  invokeAwsCheckAltProviderFunction,
} from '../../src/lib/awsCheckAltMoneyPath.ts';

const SERVER_BODY = {
  ok: false,
  statusCode: 503,
  error: 'checkalt_auth_unavailable',
  stage: 'sign_in',
  retryable: true,
  depositPosted: false,
  message: 'Check Alt sign-in is unavailable right now. Nothing was sent to Check Alt for this deposit. Press Deposit again in a minute.',
};

test('the raw checkalt_auth_unavailable code becomes a plain sentence that says nothing was sent', () => {
  const msg = checkAltProviderUserMessage(new Error('checkalt_auth_unavailable'));
  assert.equal(msg, CHECKALT_AUTH_UNAVAILABLE_USER_ERROR);
  assert.match(msg, /Nothing was sent/);
  assert.match(msg, /Press Deposit again/);
  assert.doesNotMatch(msg, /checkalt_auth_unavailable/);
});

test('end to end: the 503 answer from checkalt-submit reaches the user as the plain sentence', async () => {
  const fetchImpl = async () => new Response(JSON.stringify(SERVER_BODY), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  const result = await invokeAwsCheckAltProviderFunction('checkalt-submit-deposit', { body: { checkId: 'x' } }, {
    authProvider: 'cognito',
    apiBaseUrl: 'https://api.example.test',
    idToken: 'token',
    fetchImpl,
  });
  assert.ok(result.error, JSON.stringify(result));
  assert.equal(result.error.message, 'checkalt_auth_unavailable');
  assert.equal(checkAltProviderUserMessage(result.error), CHECKALT_AUTH_UNAVAILABLE_USER_ERROR);
});

test('other answers keep their existing messages', () => {
  assert.equal(checkAltProviderUserMessage(new Error('provider_disabled')), CHECKALT_PROVIDER_UNAVAILABLE);
  assert.equal(checkAltProviderUserMessage(new Error('reconciliation_required')), 'reconciliation_required');
});
