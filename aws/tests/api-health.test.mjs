import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler, requestPath } from '../functions/api/index.mjs';

const invoke = (overrides = {}) =>
  handler({
    rawPath: '/health',
    requestContext: {
      stage: 'staging',
      http: { method: 'GET', path: '/health' },
    },
    ...overrides,
  });

test('strips HTTP API stage prefix from rawPath', () => {
  assert.equal(
    requestPath({
      rawPath: '/staging/health',
      requestContext: { stage: 'staging' },
    }),
    '/health',
  );
  assert.equal(
    requestPath({
      rawPath: '/health',
      requestContext: { stage: 'staging' },
    }),
    '/health',
  );
});

test('GET /health returns staging ok without a database', async () => {
  process.env.CHECKSOPS_ENV = 'staging';
  const response = await invoke();
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.service, 'checksops-api');
  assert.equal(body.environment, 'staging');
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'not-connected');
  assert.equal(body.productionSupabaseChanged, false);
});

test('GET /staging/health succeeds when API Gateway includes the stage', async () => {
  process.env.CHECKSOPS_ENV = 'staging';
  const response = await invoke({
    rawPath: '/staging/health',
    requestContext: {
      stage: 'staging',
      http: { method: 'GET', path: '/staging/health' },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).status, 'ok');
});

test('unknown routes return 404', async () => {
  const response = await invoke({
    rawPath: '/v1/tenants',
    requestContext: {
      stage: 'staging',
      http: { method: 'GET', path: '/v1/tenants' },
    },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error, 'not_found');
});
