import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizeDbValidatorDetails,
  dbValidatorHttpResponse,
  isDbValidatorAdmin,
} from '../functions/api/db-validator-access.mjs';

test('only the admin application role may view staging validator details', () => {
  assert.equal(isDbValidatorAdmin(['admin']), true);
  assert.equal(isDbValidatorAdmin(['staff', 'admin']), true);
  assert.equal(isDbValidatorAdmin(['staff']), false);
  assert.equal(isDbValidatorAdmin(['owner', 'manager']), false);
  assert.equal(isDbValidatorAdmin([]), false);
});

test('unauthenticated callers stay on the public redaction path', async () => {
  const access = await authorizeDbValidatorDetails({
    env: 'staging',
    auth: { ok: false },
    resolveIdentity: async () => assert.fail('must not look up identity'),
  });
  assert.deepEqual(access, { ok: false, reason: 'unauthenticated' });
});

test('production authenticated callers keep resolveClaims-only access', async () => {
  const access = await authorizeDbValidatorDetails({
    env: 'production',
    auth: { ok: true, claims: { sub: 'cognito-sub' } },
    resolveIdentity: async () => assert.fail('production must not look up roles'),
  });
  assert.deepEqual(access, { ok: true, reason: 'production_authenticated' });
});

test('staging details require an admin role and fail closed otherwise', async () => {
  const admin = await authorizeDbValidatorDetails({
    env: 'staging',
    auth: { ok: true, claims: { sub: 'cognito-sub', email: 'a@example.com' } },
    resolveIdentity: async ({ cognitoSub }) => {
      assert.equal(cognitoSub, 'cognito-sub');
      return { ok: true, roles: ['admin'] };
    },
  });
  assert.deepEqual(admin, { ok: true, reason: 'staging_admin' });

  const staff = await authorizeDbValidatorDetails({
    env: 'staging',
    auth: { ok: true, claims: { sub: 'cognito-sub' } },
    resolveIdentity: async () => ({ ok: true, roles: ['staff'] }),
  });
  assert.equal(staff.ok, false);
  assert.equal(staff.statusCode, 403);
  assert.equal(staff.reason, 'not_admin');

  const missing = await authorizeDbValidatorDetails({
    env: 'staging',
    auth: { ok: true, claims: { sub: 'cognito-sub' } },
    resolveIdentity: async () => ({ ok: false, error: 'identity_not_linked', message: 'secret-row' }),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.reason, 'identity_unresolved');
  assert.equal(JSON.stringify(missing).includes('secret-row'), false);
});

test('HTTP mapping keeps public redaction and never leaks details on 403', () => {
  const validation = {
    ok: false,
    issues: [{ kind: 'trigger', severity: 'error', message: 'host=db.internal' }],
    tables: [{ table: 'claims', rowCount: 1 }],
    inspect: {
      functions: [{ identity: 'public.aws_can_write_claim(uuid)', definition: 'CREATE FUNCTION secret' }],
    },
  };
  const publicResponse = (value) => ({
    statusCode: 503,
    body: { service: 'checksops-api', status: 'unhealthy', readOnly: true, marker: value.ok },
  });
  const details = (value) => ({ statusCode: 503, body: value });

  const publicResult = dbValidatorHttpResponse({
    access: { ok: false, reason: 'unauthenticated' },
    validation,
    publicResponse,
    details,
  });
  assert.deepEqual(publicResult.body, {
    service: 'checksops-api', status: 'unhealthy', readOnly: true, marker: false,
  });

  const forbidden = dbValidatorHttpResponse({
    access: { ok: false, reason: 'not_admin', statusCode: 403 },
    validation,
    publicResponse,
    details,
  });
  assert.deepEqual(forbidden, { statusCode: 403, body: { error: 'not_authorized' } });
  assert.equal(JSON.stringify(forbidden).includes('db.internal'), false);
  assert.equal(JSON.stringify(forbidden).includes('claims'), false);
  assert.equal(JSON.stringify(forbidden).includes('CREATE FUNCTION'), false);
  assert.equal(Object.hasOwn(publicResult.body, 'inspect'), false);

  const allowed = dbValidatorHttpResponse({
    access: { ok: true, reason: 'staging_admin' },
    validation,
    publicResponse,
    details,
  });
  assert.equal(allowed.body.issues[0].kind, 'trigger');
});

test('staging without an identity resolver fails closed', async () => {
  const access = await authorizeDbValidatorDetails({
    env: 'staging',
    auth: { ok: true, claims: { sub: 'cognito-sub' } },
  });
  assert.equal(access.ok, false);
  assert.equal(access.statusCode, 403);
  assert.equal(access.reason, 'identity_lookup_failed');
});
