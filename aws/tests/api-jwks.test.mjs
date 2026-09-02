import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { fetchCognitoJwks, cognitoJwksUrl } from '../functions/api/jwks.mjs';

test('JWKS URL is the regional Cognito IdP well-known document', () => {
  assert.equal(
    cognitoJwksUrl('us-east-1_example'),
    'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example/.well-known/jwks.json',
  );
});

test('GET /authorization/jwks-check without a token still attempts JWKS fetch', async () => {
  const original = process.env.COGNITO_USER_POOL_ID;
  process.env.COGNITO_USER_POOL_ID = 'us-east-1_example';
  const response = await handler({
    rawPath: '/authorization/jwks-check',
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/authorization/jwks-check' } },
  });
  process.env.COGNITO_USER_POOL_ID = original;
  const body = JSON.parse(response.body);
  assert.ok([200, 503].includes(response.statusCode));
  assert.equal(body.tokenCheck.attempted, false);
  assert.ok(body.jwks.url.includes('cognito-idp.us-east-1.amazonaws.com'));
});

test('fetchCognitoJwks records key count from a successful response', async () => {
  const result = await fetchCognitoJwks({
    poolId: 'us-east-1_example',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [{ kid: 'a' }, { kid: 'b' }] }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.keyCount, 2);
  assert.equal(result.status, 200);
});
