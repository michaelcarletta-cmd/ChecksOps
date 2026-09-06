import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corsAllowOrigin, corsHeaders, PRODUCTION_CORS_ORIGINS } from '../functions/api/cors.mjs';
import { handler } from '../functions/api/index.mjs';

test('staging CORS remains wildcard', () => {
  const event = { headers: { origin: 'https://evil.example' } };
  assert.equal(corsAllowOrigin(event, 'staging'), '*');
  assert.equal(corsHeaders(event, 'staging')['access-control-allow-origin'], '*');
});

test('production CORS allows only checksops.com and www', () => {
  assert.deepEqual(PRODUCTION_CORS_ORIGINS, [
    'https://checksops.com',
    'https://www.checksops.com',
  ]);
  assert.equal(corsAllowOrigin({ headers: { origin: 'https://checksops.com' } }, 'production-prep'), 'https://checksops.com');
  assert.equal(corsAllowOrigin({ headers: { Origin: 'https://www.checksops.com' } }, 'production-prep'), 'https://www.checksops.com');
  assert.equal(corsAllowOrigin({ headers: { origin: 'https://evil.example' } }, 'production-prep'), 'https://checksops.com');
  assert.equal(corsAllowOrigin({ headers: {} }, 'production'), 'https://checksops.com');
});

test('handler preflight uses staging wildcard and production allow-list', async () => {
  const staging = await handler({
    rawPath: '/public/endorsement',
    headers: { origin: 'https://staging.checksops.com' },
    requestContext: { stage: 'staging', http: { method: 'OPTIONS', path: '/public/endorsement' } },
  });
  assert.equal(staging.statusCode, 204);
  assert.equal(staging.headers['access-control-allow-origin'], '*');

  const previous = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'production-prep';
  try {
    const allowed = await handler({
      rawPath: '/public/signature-submit',
      headers: { origin: 'https://checksops.com' },
      requestContext: { stage: 'prep', http: { method: 'OPTIONS', path: '/public/signature-submit' } },
    });
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://checksops.com');
    const blocked = await handler({
      rawPath: '/public/endorsement',
      headers: { origin: 'https://evil.example' },
      requestContext: { stage: 'prep', http: { method: 'OPTIONS', path: '/public/endorsement' } },
    });
    assert.equal(blocked.headers['access-control-allow-origin'], 'https://checksops.com');
  } finally {
    if (previous == null) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = previous;
  }
});
