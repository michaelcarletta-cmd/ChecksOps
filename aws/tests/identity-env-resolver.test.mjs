import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  EXPECTED_DUAL_ENV_IDENTITIES,
  EXPECTED_EIGHT,
} from '../identity/expected-mappings.mjs';
import {
  LOOKUP_MAPPING_SQL,
  LOOKUP_PRODUCTION_IDENTITY_SQL,
  PROFILE_SQL,
  TENANT_MEMBERSHIP_SQL,
  USER_ROLES_SQL,
  resolveIdentitySession,
} from '../functions/api/identity.mjs';
import {
  IDENTITY_ENV_PRODUCTION,
  IDENTITY_ENV_STAGING,
  PRODUCTION_IDENTITY_SOURCE,
  STAGING_IDENTITY_SOURCE,
  identityLookupSql,
  lookupIdentityMapping,
  rejectUntrustedIdentityHints,
  resolveTrustedIdentityScope,
} from '../functions/api/identity-env.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MICHAEL = EXPECTED_DUAL_ENV_IDENTITIES[0];
const CLAIMS = EXPECTED_EIGHT.find((row) => row.email === 'claims@freedomadj.com');
const UNKNOWN_SUB = '00000000-0000-4000-8000-000000000099';

const stagingScope = () => resolveTrustedIdentityScope({
  checksopsEnv: 'staging',
  userPoolId: 'us-east-1_vPmQ7cL1F',
});
const productionScope = () => resolveTrustedIdentityScope({
  checksopsEnv: 'production-prep',
  userPoolId: 'us-east-1_h00WorYMT',
});

const dualStore = () => {
  const staging = new Map([[MICHAEL.stagingCognitoSub, {
    application_user_id: MICHAEL.applicationUserId,
    cognito_sub: MICHAEL.stagingCognitoSub,
    email: MICHAEL.email,
    status: 'active',
  }]]);
  const production = new Map([[MICHAEL.productionCognitoSub, {
    application_user_id: MICHAEL.applicationUserId,
    cognito_sub: MICHAEL.productionCognitoSub,
    email: MICHAEL.email,
    status: 'active',
  }]]);
  const writes = [];
  const queries = [];
  return {
    staging,
    production,
    writes,
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)) {
        writes.push({ sql, params });
        throw new Error('identity resolution must not write');
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql.includes('auth.uid()')) {
        return { rows: [{ auth_uid: MICHAEL.applicationUserId }] };
      }
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: staging.has(params[0]) ? [staging.get(params[0])] : [] };
      }
      if (sql === LOOKUP_PRODUCTION_IDENTITY_SQL) {
        return { rows: production.has(params[0]) ? [production.get(params[0])] : [] };
      }
      if (sql === PROFILE_SQL) {
        return { rows: [{
          id: MICHAEL.applicationUserId,
          email: MICHAEL.email,
          full_name: 'M. Carletta',
          approval_status: 'approved',
        }] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL) {
        assert.equal(params[0], MICHAEL.applicationUserId);
        return { rows: [{
          tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
          role: 'admin',
          tenant_name: 'Freedom Adjustment',
          tenant_slug: 'freedom',
        }] };
      }
      if (sql === USER_ROLES_SQL) {
        assert.equal(params[0], MICHAEL.applicationUserId);
        return { rows: [{ role: 'admin' }] };
      }
      if (sql.includes('is_master_owner()')) {
        return { rows: [{ is_master_owner: false }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
};

const resolveWith = async (store, { cognitoSub, scope, email = MICHAEL.email }) => (
  resolveIdentitySession({
    cognitoSub,
    email,
    identityScope: scope,
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => store,
  })
);

test('trusted scope maps staging and production-prep to isolated pools', () => {
  const staging = stagingScope();
  const production = productionScope();
  assert.equal(staging.ok, true);
  assert.equal(staging.identityEnv, IDENTITY_ENV_STAGING);
  assert.equal(staging.mappingSource, STAGING_IDENTITY_SOURCE);
  assert.equal(staging.issuer, 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_vPmQ7cL1F');
  assert.equal(production.ok, true);
  assert.equal(production.identityEnv, IDENTITY_ENV_PRODUCTION);
  assert.equal(production.mappingSource, PRODUCTION_IDENTITY_SOURCE);
  assert.equal(identityLookupSql(IDENTITY_ENV_STAGING), LOOKUP_MAPPING_SQL);
  assert.equal(identityLookupSql(IDENTITY_ENV_PRODUCTION), LOOKUP_PRODUCTION_IDENTITY_SQL);
  assert.notEqual(LOOKUP_MAPPING_SQL, LOOKUP_PRODUCTION_IDENTITY_SQL);
});

test('unset CHECKSOPS_ENV with no pool defaults to the staging map', () => {
  const scope = resolveTrustedIdentityScope({ checksopsEnv: '', userPoolId: '' });
  assert.equal(scope.ok, true);
  assert.equal(scope.identityEnv, IDENTITY_ENV_STAGING);
  assert.equal(scope.mappingSource, STAGING_IDENTITY_SOURCE);
});

test('client-supplied env or pool hints are ignored and never select a map', () => {
  const hinted = rejectUntrustedIdentityHints({
    headers: { 'x-checksops-env': 'production', 'x-cognito-user-pool-id': 'us-east-1_h00WorYMT' },
    queryStringParameters: { userPoolId: 'us-east-1_h00WorYMT', environment: 'production' },
  });
  assert.equal(hinted.ignored, true);
  const trusted = resolveTrustedIdentityScope({
    checksopsEnv: 'staging',
    userPoolId: 'us-east-1_vPmQ7cL1F',
  });
  assert.equal(trusted.identityEnv, IDENTITY_ENV_STAGING);
  assert.notEqual(hinted.hint, trusted.userPoolId);
});

test('pool/env mismatch and unknown env fail closed', () => {
  assert.equal(resolveTrustedIdentityScope({
    checksopsEnv: 'staging',
    userPoolId: 'us-east-1_h00WorYMT',
  }).error, 'identity_pool_mismatch');
  assert.equal(resolveTrustedIdentityScope({
    checksopsEnv: 'production',
    userPoolId: 'us-east-1_vPmQ7cL1F',
  }).error, 'identity_pool_mismatch');
  assert.equal(resolveTrustedIdentityScope({
    checksopsEnv: 'lab',
    userPoolId: 'us-east-1_vPmQ7cL1F',
  }).error, 'identity_env_unknown');
});

test('Michael staging sub resolves to the Freedom application user', async () => {
  const store = dualStore();
  const result = await resolveWith(store, {
    cognitoSub: MICHAEL.stagingCognitoSub,
    scope: stagingScope(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, MICHAEL.applicationUserId);
  assert.equal(result.cognitoSub, MICHAEL.stagingCognitoSub);
  assert.equal(result.identityEnv, 'staging');
  assert.equal(result.identitySource, STAGING_IDENTITY_SOURCE);
  assert.deepEqual(result.roles, ['admin']);
  assert.equal(result.tenants[0].tenant_slug, 'freedom');
  assert.equal(result.authorizationSource, 'user_roles_and_tenant_users');
  assert.equal(store.writes.length, 0);
});

test('Michael production sub resolves to the same application user', async () => {
  const store = dualStore();
  const result = await resolveWith(store, {
    cognitoSub: MICHAEL.productionCognitoSub,
    scope: productionScope(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, MICHAEL.applicationUserId);
  assert.equal(result.cognitoSub, MICHAEL.productionCognitoSub);
  assert.equal(result.identityEnv, 'production');
  assert.equal(result.identitySource, PRODUCTION_IDENTITY_SOURCE);
  assert.deepEqual(result.roles, ['admin']);
  assert.equal(result.tenants[0].role, 'admin');
  assert.equal(store.writes.length, 0);
});

test('staging and production mappings coexist and resolving one does not alter the other', async () => {
  const store = dualStore();
  const stagingBefore = store.staging.get(MICHAEL.stagingCognitoSub);
  const productionBefore = store.production.get(MICHAEL.productionCognitoSub);

  const staging = await lookupIdentityMapping(store, MICHAEL.stagingCognitoSub, stagingScope());
  const production = await lookupIdentityMapping(store, MICHAEL.productionCognitoSub, productionScope());
  await resolveWith(store, { cognitoSub: MICHAEL.productionCognitoSub, scope: productionScope() });
  await resolveWith(store, { cognitoSub: MICHAEL.stagingCognitoSub, scope: stagingScope() });

  assert.equal(staging.mapping.application_user_id, MICHAEL.applicationUserId);
  assert.equal(production.mapping.application_user_id, MICHAEL.applicationUserId);
  assert.equal(store.staging.get(MICHAEL.stagingCognitoSub), stagingBefore);
  assert.equal(store.production.get(MICHAEL.productionCognitoSub), productionBefore);
  assert.equal(store.staging.size, 1);
  assert.equal(store.production.size, 1);
  assert.equal(store.writes.length, 0);
  assert.ok(store.queries.every((row) => !/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(row.sql)));
});

test('unknown staging and production subs fail closed', async () => {
  const store = dualStore();
  const staging = await resolveWith(store, { cognitoSub: UNKNOWN_SUB, scope: stagingScope() });
  const production = await resolveWith(store, { cognitoSub: UNKNOWN_SUB, scope: productionScope() });
  assert.equal(staging.ok, false);
  assert.equal(staging.error, 'identity_not_linked');
  assert.equal(production.ok, false);
  assert.equal(production.error, 'identity_not_linked');
});

test('production sub presented in staging fails and does not query the production map', async () => {
  const store = dualStore();
  const result = await resolveWith(store, {
    cognitoSub: MICHAEL.productionCognitoSub,
    scope: stagingScope(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'identity_not_linked');
  assert.ok(store.queries.some((row) => row.sql === LOOKUP_MAPPING_SQL));
  assert.ok(!store.queries.some((row) => row.sql === LOOKUP_PRODUCTION_IDENTITY_SQL));
});

test('staging sub presented in production fails and does not query the staging map', async () => {
  const store = dualStore();
  const result = await resolveWith(store, {
    cognitoSub: MICHAEL.stagingCognitoSub,
    scope: productionScope(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'identity_not_linked');
  assert.ok(store.queries.some((row) => row.sql === LOOKUP_PRODUCTION_IDENTITY_SQL));
  assert.ok(!store.queries.some((row) => row.sql === LOOKUP_MAPPING_SQL));
});

test('email equality alone cannot cross-resolve identities', async () => {
  const store = dualStore();
  store.staging.set('email-only-staging-sub', {
    application_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cognito_sub: 'email-only-staging-sub',
    email: MICHAEL.email,
    status: 'active',
  });
  const result = await resolveWith(store, {
    cognitoSub: UNKNOWN_SUB,
    email: MICHAEL.email,
    scope: productionScope(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'identity_not_linked');
  assert.ok(!store.queries.some((row) => String(row.sql).toLowerCase().includes('email')));
});

test('wrong issuer fails closed without consulting either map', async () => {
  const store = dualStore();
  const result = await resolveIdentitySession({
    cognitoSub: MICHAEL.stagingCognitoSub,
    claims: { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_h00WorYMT' },
    identityScope: stagingScope(),
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => store,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'identity_issuer_mismatch');
  assert.equal(store.queries.length, 0);
});

test('Mortgage Ops claims@ stays a separate application user and is not hard-coded in the resolver', () => {
  assert.ok(CLAIMS);
  assert.notEqual(CLAIMS.applicationUserId, MICHAEL.applicationUserId);
  assert.equal(CLAIMS.appRole, 'mortgage_agent');
  assert.equal(EXPECTED_DUAL_ENV_IDENTITIES.every((row) => row.email !== CLAIMS.email), true);
  const resolver = fs.readFileSync(path.join(ROOT, 'functions/api/identity-env.mjs'), 'utf8');
  const session = fs.readFileSync(path.join(ROOT, 'functions/api/identity.mjs'), 'utf8');
  for (const needle of [
    MICHAEL.applicationUserId,
    MICHAEL.email,
    MICHAEL.stagingCognitoSub,
    MICHAEL.productionCognitoSub,
    CLAIMS.applicationUserId,
    CLAIMS.email,
  ]) {
    assert.doesNotMatch(resolver, new RegExp(needle));
    assert.doesNotMatch(session, new RegExp(needle));
  }
});

test('unapplied environment SQL versions the production map and does not rewrite users', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'identity/sql/11_identity_environment_cognito.sql'), 'utf8');
  assert.match(sql, /NOT APPLIED/);
  assert.match(sql, /identity_production_cognito_locks/);
  assert.match(sql, /GRANT SELECT/);
  assert.doesNotMatch(sql, /INSERT INTO/);
  assert.doesNotMatch(sql, /UPDATE public\.identity_accounts/);
  assert.doesNotMatch(sql, /7dbb3009-f059-4767-b5dc-1c5c72379330/);
});
