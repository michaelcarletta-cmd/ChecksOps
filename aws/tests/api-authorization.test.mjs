import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { ignoredSpoofFields, PROBE_ITEMS_SQL, CLAIMS_VISIBLE_SQL, CHECKS_BY_TENANT_SQL, runAuthorizationProbe } from '../functions/api/authorization.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = '2418c458-c011-70b7-07ac-6b9da2d9415d';
const OTHER_UUID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';

test('GET /authorization/probe without a token is 401', async () => {
  const response = await handler({
    rawPath: '/authorization/probe',
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/authorization/probe' } },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error, 'missing_cognito_token');
});

test('spoof query, headers, and body are recorded as ignored', () => {
  const spoof = ignoredSpoofFields({
    queryStringParameters: { user_id: OTHER_UUID, tenant_id: C1C, sub: OTHER_UUID },
    headers: {
      'X-User-Id': OTHER_UUID,
      'X-Tenant-Id': C1C,
      'X-Cognito-Sub': OTHER_UUID,
    },
    body: JSON.stringify({ user_id: OTHER_UUID, tenant_id: C1C, sub: OTHER_UUID }),
  });
  assert.equal(spoof.ignored, true);
  assert.equal(spoof.queryUserId, OTHER_UUID);
  assert.equal(spoof.queryTenantId, C1C);
  assert.equal(spoof.headerUserId, OTHER_UUID);
  assert.equal(spoof.headerTenantId, C1C);
  assert.equal(spoof.bodyUserId, OTHER_UUID);
  assert.equal(spoof.bodyTenantId, C1C);
});

const mockProbeClient = () => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql.includes('auth.uid()') && sql.includes('has_role')) {
        return { rows: [{ has_staff: true, has_admin: false }] };
      }
      if (sql.includes('auth.uid()')) return { rows: [{ auth_uid: APP_ID }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        assert.equal(params[0], COGNITO_SUB);
        return { rows: [{
          application_user_id: APP_ID,
          cognito_sub: COGNITO_SUB,
          email: 'checksops-tester@freedomadj.com',
          status: 'isolated_test',
        }] };
      }
      if (sql === PROBE_ITEMS_SQL) {
        return { rows: [{ label: 'freedom-probe-visible', tenant_id: FREEDOM }] };
      }
      if (sql.includes('aws_user_tenant_ids')) {
        return { rows: [{ tenant_id: FREEDOM }] };
      }
      if (sql === USER_ROLES_SQL) {
        assert.equal(params[0], APP_ID);
        return { rows: [{ role: 'staff' }] };
      }
      if (sql === CLAIMS_VISIBLE_SQL) {
        return { rows: [{ n: 83, freedom: 83, org_null: 0 }] };
      }
      if (sql === CHECKS_BY_TENANT_SQL) {
        return { rows: [{ freedom: 10, c1c: 0 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    end: async () => {},
  };
};

test('authorization probe uses mapped application UUID and ignores spoofed ids', async () => {
  const client = mockProbeClient();
  const result = await runAuthorizationProbe({
    cognitoSub: COGNITO_SUB,
    cognitoEmail: 'staging-identity-probe-c48b@checksops.invalid',
    spoof: ignoredSpoofFields({
      queryStringParameters: { user_id: OTHER_UUID, tenant_id: C1C },
      headers: { 'x-user-id': OTHER_UUID },
      body: JSON.stringify({ user_id: OTHER_UUID }),
    }),
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
  assert.equal(result.authUid, APP_ID);
  assert.notEqual(result.applicationUserId, result.cognitoSub);
  assert.deepEqual(result.visibleProbeLabels, ['freedom-probe-visible']);
  assert.equal(result.isolation.canReadFreedomProbe, true);
  assert.equal(result.isolation.canReadC1cProbe, false);
  assert.deepEqual(result.claimsVisible, { n: 83, freedom: 83, org_null: 0 });
  assert.equal(result.checksVisible.c1c, 0);
  assert.equal(result.restoredTablesRlsEnabled, true);
  assert.deepEqual(result.roles, ['staff']);
  assert.equal(result.spoofFieldsIgnored.queryUserId, OTHER_UUID);
  assert.equal(JSON.stringify(result).includes('unit-test-only-not-a-real-secret'), false);
  const guc = client.queries.filter((q) => q.sql.startsWith('SELECT set_config'));
  assert.equal(guc[0].params[1], APP_ID);
  assert.equal(guc[1].params[1], 'checksops-tester@freedomadj.com');
});
