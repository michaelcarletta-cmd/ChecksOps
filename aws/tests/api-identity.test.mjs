import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { cognitoClaimsFromEvent, loginSessionIdFromClaims, refuseSubAsApplicationId } from '../functions/api/cognito.mjs';
import {
  LOOKUP_MAPPING_SQL,
  PROFILE_SQL,
  TENANT_MEMBERSHIP_SQL,
  USER_ROLES_SQL,
  resolveIdentitySession,
} from '../functions/api/identity.mjs';

const APP_ID = '11111111-1111-1111-1111-111111111111';
const COGNITO_SUB = '22222222-2222-2222-2222-222222222222';

test('extracts Cognito sub from HTTP API JWT authorizer claims', () => {
  const claims = cognitoClaimsFromEvent({
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: COGNITO_SUB, email: 'probe@example.com', token_use: 'id' } },
      },
    },
  });
  assert.equal(claims.sub, COGNITO_SUB);
  assert.equal(claims.email, 'probe@example.com');
});

test('login session id uses origin_jti or sub+auth_time, never Cognito MFA claims', () => {
  assert.equal(loginSessionIdFromClaims({
    sub: COGNITO_SUB,
    originJti: 'origin-1',
    authTime: '9',
  }), 'origin_jti:origin-1');
  assert.equal(loginSessionIdFromClaims({
    sub: COGNITO_SUB,
    authTime: '1000',
  }), `auth_time:${COGNITO_SUB}:1000`);
  assert.equal(loginSessionIdFromClaims({
    sub: COGNITO_SUB,
    amr: ['SOFTWARE_TOKEN_MFA'],
  }), null);
  const fromEvent = cognitoClaimsFromEvent({
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: COGNITO_SUB, auth_time: '42', token_use: 'id' } },
      },
    },
  });
  assert.equal(loginSessionIdFromClaims(fromEvent), `auth_time:${COGNITO_SUB}:42`);
});

test('refuses mapping an application UUID equal to the Cognito sub', () => {
  assert.throws(() => refuseSubAsApplicationId(COGNITO_SUB, COGNITO_SUB), /equals cognito_sub/);
});

test('GET /identity/me without a token is 401', async () => {
  const response = await handler({
    rawPath: '/identity/me',
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/identity/me' } },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error, 'missing_cognito_token');
});

const mockIdentityClient = ({ mapping = {
  application_user_id: APP_ID,
  cognito_sub: COGNITO_SUB,
  email: 'existing@example.com',
  status: 'isolated_test',
} } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql.includes('auth.uid()')) return { rows: [{ auth_uid: mapping?.application_user_id || null }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: mapping && params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql === PROFILE_SQL) {
        return { rows: [{ id: APP_ID, email: 'existing@example.com', full_name: 'Existing User', approval_status: 'approved' }] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL) {
        assert.equal(params[0], APP_ID);
        return { rows: [{ tenant_id: 'tenant-1', role: 'owner', tenant_name: 'Acme', tenant_slug: 'acme' }] };
      }
      if (sql === USER_ROLES_SQL) {
        assert.equal(params[0], APP_ID);
        return { rows: [{ role: 'admin' }, { role: 'staff' }] };
      }
      if (sql.includes('is_master_owner()')) {
        return { rows: [{ is_master_owner: false }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    end: async () => {},
  };
};

test('resolves Cognito sub to existing application UUID and looks up tenant/roles by that UUID', async () => {
  const client = mockIdentityClient();
  const result = await resolveIdentitySession({
    cognitoSub: COGNITO_SUB,
    email: 'probe@example.com',
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
      secretDatabase: 'postgres',
    }),
    createClient: () => client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, APP_ID);
  assert.equal(result.authUid, APP_ID);
  assert.equal(result.cognitoSub, COGNITO_SUB);
  assert.notEqual(result.applicationUserId, result.cognitoSub);
  assert.deepEqual(result.roles, ['admin', 'staff']);
  assert.equal(result.tenants[0].tenant_slug, 'acme');
  assert.equal(result.cognitoGroupsUsed, false);
  assert.equal(result.authorizationSource, 'user_roles_and_tenant_users');
  assert.equal(result.privileged, true);
  assert.equal(result.privilegedAuth.preferredMfaAtLogin, false);
  assert.equal(result.privilegedAuth.moneyMovementUnlocked, false);
  assert.equal(result.privilegedAuth.apiBehindCloudFrontRequiredBeforeFinancial, true);
  assert.equal(JSON.stringify(result).includes('unit-test-only-not-a-real-secret'), false);
});

test('unmapped Cognito sub is 401 and does not mint an application UUID', async () => {
  const result = await resolveIdentitySession({
    cognitoSub: COGNITO_SUB,
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => mockIdentityClient({ mapping: null }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, 'identity_not_linked');
});

test('active identity mappings resolve without using isolated_test', async () => {
  const client = mockIdentityClient({
    mapping: {
      application_user_id: APP_ID,
      cognito_sub: COGNITO_SUB,
      email: 'existing@example.com',
      status: 'active',
    },
  });
  const result = await resolveIdentitySession({
    cognitoSub: COGNITO_SUB,
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, APP_ID);
  assert.notEqual(result.applicationUserId, result.cognitoSub);
  assert.match(LOOKUP_MAPPING_SQL, /status IN \('active', 'isolated_test'\)/);
});
