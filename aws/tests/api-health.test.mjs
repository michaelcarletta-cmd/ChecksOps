import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler, requestPath } from '../functions/api/index.mjs';
import {
  loadDatabaseCredentials,
  parseDatabaseSecretString,
  publicCredentialFields,
} from '../functions/api/secrets.mjs';

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

test('GET /health returns staging ok without a database password', async () => {
  process.env.CHECKSOPS_ENV = 'staging';
  process.env.DATABASE_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/example';
  const response = await invoke();
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.service, 'checksops-api');
  assert.equal(body.environment, 'staging');
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'not-connected');
  assert.equal(body.databaseSecretConfigured, true);
  assert.equal(body.productionSupabaseChanged, false);
  assert.equal(Object.hasOwn(body, 'password'), false);
  assert.doesNotMatch(response.body, /password/i);
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

test('parses application database secret JSON without exposing it in public fields', () => {
  const credentials = parseDatabaseSecretString(JSON.stringify({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
    port: 5432,
    dbname: 'checksops',
  }));
  const published = publicCredentialFields(credentials);
  assert.equal(published.username, 'checksops');
  assert.equal(published.host, 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com');
  assert.equal(published.port, 5432);
  assert.equal(Object.hasOwn(published, 'password'), false);
});

test('refuses the checksops_admin secret ARN', async () => {
  process.env.DATABASE_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/example';
  await assert.rejects(
    () => loadDatabaseCredentials(async () => '{"username":"checksops_admin","password":"nope"}'),
    /checksops_admin/,
  );
});
