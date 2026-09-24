import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  IDENTITY_ENV_PRODUCTION,
  IDENTITY_ENV_STAGING,
  INSERT_PRODUCTION_LOCK_SQL,
  PRODUCTION_IDENTITY_WRITE_GUC,
  SELECT_PRODUCTION_LOCK_BY_SUB_SQL,
  SELECT_PRODUCTION_LOCK_BY_USER_SQL,
  bindProductionCognitoLock,
  lookupIdentityMapping,
  resolveTrustedIdentityScope,
} from '../functions/api/identity-env.mjs';
import {
  LOOKUP_PRODUCTION_IDENTITY_SQL,
  resolveIdentitySession,
} from '../functions/api/identity.mjs';
import { handleTenantInviteUser, runTenantInviteUser } from '../functions/api/tenant-admin.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const OWNER_USER = 'f56ed221-47ad-4ce5-b464-fd632b960746';
const OWNER_SUB = '24d8a418-5051-7038-d1dc-09ea9bc6a0a6';
const OWNER_EMAIL = 'checksopsadmin@gmail.com';
const INVITED_SUB = 'd4488448-c0d1-706f-a802-34705a7d07ad';
const INVITED_USER = 'e4054fb8-37d1-458e-a310-e27d5611e36c';
const SPOOF_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROD_TENANT = 'd8267653-4e8d-4635-b42b-fe4968e0e930';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const INVITE_EMAIL = 'claims+prodlock59ff@freedomadj.com';

const stagingScope = () => resolveTrustedIdentityScope({
  checksopsEnv: 'staging',
  userPoolId: 'us-east-1_vPmQ7cL1F',
});
const productionScope = () => resolveTrustedIdentityScope({
  checksopsEnv: 'production-prep',
  userPoolId: 'us-east-1_h00WorYMT',
});

const lockKey = (userId, sub) => `${userId}::${sub}`;

const lockStore = (seed = []) => {
  const locks = new Map(seed.map((row) => [lockKey(row.application_user_id, row.cognito_sub), { ...row }]));
  const writes = [];
  const queries = [];
  const memberships = [];
  return {
    locks,
    writes,
    queries,
    memberships,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === SELECT_PRODUCTION_LOCK_BY_SUB_SQL) {
        const row = [...locks.values()].find((item) => item.cognito_sub === params[0]) || null;
        return { rows: row ? [row] : [] };
      }
      if (sql === SELECT_PRODUCTION_LOCK_BY_USER_SQL) {
        const row = [...locks.values()].find((item) => item.application_user_id === params[0]) || null;
        return { rows: row ? [row] : [] };
      }
      if (sql === INSERT_PRODUCTION_LOCK_SQL) {
        writes.push({ sql, params });
        const [application_user_id, cognito_sub] = params;
        if ([...locks.values()].some((row) => row.cognito_sub === cognito_sub || row.application_user_id === application_user_id)) {
          const error = new Error('duplicate key value violates unique constraint');
          error.code = '23505';
          throw error;
        }
        locks.set(lockKey(application_user_id, cognito_sub), { application_user_id, cognito_sub });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT set_config')) {
        writes.push({ sql, params });
        return { rows: [{ set_config: params[1] }] };
      }
      throw new Error(`unexpected lock query: ${sql}`);
    },
  };
};

const inviteClient = ({
  locks = [],
  identityAccounts = [],
  profiles = [],
  failIdentity = false,
  failMembership = false,
  adminOf = [PROD_TENANT],
  systemAdmin = true,
  masterOwner = true,
} = {}) => {
  const store = lockStore(locks);
  const committed = { value: false, rolledBack: false };
  const identityRows = [...identityAccounts];
  const profileRows = [...profiles];
  store.committed = committed;
  store.query = async (sql, params = []) => {
    store.queries.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'SET TRANSACTION READ WRITE' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      if (sql === 'COMMIT') committed.value = true;
      if (sql === 'ROLLBACK') committed.rolledBack = true;
      return { rows: [] };
    }
    if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT') || sql.startsWith('ROLLBACK TO SAVEPOINT')) {
      return { rows: [] };
    }
    if (sql.startsWith('SELECT set_config')) {
      store.writes.push({ sql, params });
      return { rows: [{ set_config: params[1] }] };
    }
    if (sql === LOOKUP_PRODUCTION_IDENTITY_SQL) {
      const row = locks.find((item) => item.cognito_sub === params[0]);
      return {
        rows: row ? [{
          application_user_id: row.application_user_id,
          cognito_sub: row.cognito_sub,
          email: row.email || OWNER_EMAIL,
          status: 'active',
        }] : [],
      };
    }
    if (sql === SELECT_PRODUCTION_LOCK_BY_SUB_SQL) {
      const row = [...store.locks.values()].find((item) => item.cognito_sub === params[0]) || null;
      return { rows: row ? [row] : [] };
    }
    if (sql === SELECT_PRODUCTION_LOCK_BY_USER_SQL) {
      const row = [...store.locks.values()].find((item) => item.application_user_id === params[0]) || null;
      return { rows: row ? [row] : [] };
    }
    if (sql === INSERT_PRODUCTION_LOCK_SQL) {
      store.writes.push({ sql, params });
      const [application_user_id, cognito_sub] = params;
      if ([...store.locks.values()].some((row) => row.cognito_sub === cognito_sub || row.application_user_id === application_user_id)) {
        const error = new Error('duplicate key value violates unique constraint');
        error.code = '23505';
        throw error;
      }
      store.locks.set(lockKey(application_user_id, cognito_sub), { application_user_id, cognito_sub });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM public.tenant_users') && sql.includes('SELECT role')) {
      return { rows: adminOf.includes(params[0]) ? [{ role: 'admin' }] : [] };
    }
    if (sql.includes('FROM public.user_roles')) {
      return { rows: systemAdmin ? [{ role: 'admin' }] : [] };
    }
    if (sql.includes('is_master_owner')) {
      return { rows: [{ is_master: masterOwner }] };
    }
    if (sql.includes('FROM public.tenants')) {
      return {
        rows: params[0] === PROD_TENANT
          ? [{ id: PROD_TENANT, slug: 'prodonboard59ff', name: 'Prod Onboard', custom_domain: null }]
          : params[0] === FREEDOM_TENANT
            ? [{ id: FREEDOM_TENANT, slug: 'freedom', name: 'Freedom Adjustment', custom_domain: null }]
            : [],
      };
    }
    if (sql.includes('FROM public.profiles') && sql.includes('lower(email)')) {
      const row = profileRows.find((item) => item.email === params[0]);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (sql.includes('FROM public.identity_accounts')) {
      const row = identityRows.find((item) => item.email === params[0] || item.cognito_sub === params[1]);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (sql.includes('INSERT INTO public.identity_accounts')) {
      store.writes.push({ sql, params });
      if (failIdentity) {
        const error = new Error('identity_accounts write failed');
        error.code = '42501';
        throw error;
      }
      identityRows.push({
        cognito_sub: params[0],
        id: params[1],
        email: params[2],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.profiles')) {
      store.writes.push({ sql, params });
      profileRows.push({ id: params[0], email: params[1] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.tenant_users')) {
      store.writes.push({ sql, params });
      if (failMembership) {
        throw new Error('tenant_users write failed');
      }
      const tenantId = sql.includes('VALUES ($1::uuid, $2::uuid, $3::uuid') ? params[1] : params[0];
      const userId = sql.includes('VALUES ($1::uuid, $2::uuid, $3::uuid') ? params[2] : params[1];
      store.memberships.push({ tenant_id: tenantId, user_id: userId });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected invite query: ${sql}`);
  };
  return store;
};

const productionInvite = async ({
  body,
  client,
  cognitoSub = INVITED_SUB,
  existingCognito = false,
  send = async () => ({ deliveredCount: 1 }),
  mapping = { application_user_id: OWNER_USER, email: OWNER_EMAIL },
}) => runTenantInviteUser({
  client,
  mapping,
  spoof: { ignored: true },
  body,
  identityScope: productionScope(),
  send,
  cognitoJson: async (target) => {
    if (target === 'AdminCreateUser') {
      if (existingCognito) {
        const error = new Error('User already exists');
        error.name = 'UsernameExistsException';
        throw error;
      }
      return { User: { Username: cognitoSub, Attributes: [{ Name: 'sub', Value: cognitoSub }] } };
    }
    if (target === 'AdminGetUser') {
      return { Username: cognitoSub, UserAttributes: [{ Name: 'sub', Value: cognitoSub }] };
    }
    if (target === 'AdminSetUserPassword') return {};
    throw new Error(`unexpected ${target}`);
  },
});

test('1. newly invited production administrator receives the production lock', async () => {
  const client = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: OWNER_SUB, email: OWNER_EMAIL }],
    profiles: [{ id: INVITED_USER, email: INVITE_EMAIL }],
  });
  const sent = [];
  const result = await productionInvite({
    client,
    send: async (payload) => {
      sent.push(payload);
      return { deliveredCount: 1 };
    },
    body: { tenant_id: PROD_TENANT, email: INVITE_EMAIL, role: 'admin', full_name: 'Prod Admin' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, INVITED_USER);
  assert.equal(result.cognitoSub, INVITED_SUB);
  assert.equal(sent.length, 1);
  assert.ok([...client.locks.values()].some((row) => (
    row.application_user_id === INVITED_USER && row.cognito_sub === INVITED_SUB
  )));
  assert.ok(client.writes.some((row) => (
    row.sql === INSERT_PRODUCTION_LOCK_SQL
    && row.params[0] === INVITED_USER
    && row.params[1] === INVITED_SUB
  )));
  assert.ok(client.writes.some((row) => (
    row.sql.startsWith('SELECT set_config')
    && row.params[0] === PRODUCTION_IDENTITY_WRITE_GUC
    && row.params[1] === '1'
  )));
});

test('2. binding uses the invited Cognito sub and server-resolved application user', async () => {
  const client = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: OWNER_SUB }],
    identityAccounts: [{ id: INVITED_USER, email: INVITE_EMAIL, cognito_sub: INVITED_SUB }],
  });
  const result = await productionInvite({
    client,
    body: {
      tenant_id: PROD_TENANT,
      email: INVITE_EMAIL,
      role: 'admin',
      application_user_id: SPOOF_USER,
      user_id: SPOOF_USER,
      sub: OTHER_SUB,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, INVITED_USER);
  assert.equal(result.cognitoSub, INVITED_SUB);
  const inserted = client.writes.find((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL);
  assert.deepEqual(inserted.params, [INVITED_USER, INVITED_SUB]);
  assert.equal(inserted.params.includes(SPOOF_USER), false);
  assert.equal(inserted.params.includes(OTHER_SUB), false);
});

test('3. conflicting existing Cognito lock fails closed', async () => {
  const helper = lockStore([{ application_user_id: OWNER_USER, cognito_sub: INVITED_SUB }]);
  const conflict = await bindProductionCognitoLock(helper, {
    cognitoSub: INVITED_SUB,
    applicationUserId: INVITED_USER,
    identityScope: productionScope(),
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'identity_lock_conflict');
  assert.equal(conflict.writesAttempted, false);
  assert.equal(helper.locks.size, 1);
  assert.equal([...helper.locks.values()][0].application_user_id, OWNER_USER);

  const client = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: INVITED_SUB, email: OWNER_EMAIL }],
    profiles: [{ id: INVITED_USER, email: INVITE_EMAIL }],
  });
  const sent = [];
  const invite = await productionInvite({
    client,
    send: async (payload) => {
      sent.push(payload);
      return { deliveredCount: 1 };
    },
    body: { tenant_id: PROD_TENANT, email: INVITE_EMAIL, role: 'admin' },
  });
  assert.equal(invite.ok, false);
  assert.equal(invite.statusCode, 409);
  assert.equal(invite.error, 'identity_lock_conflict');
  assert.equal(sent.length, 0);
  assert.equal(client.writes.some((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL), false);
});

test('4. client cannot spoof application_user_id for the lock', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'functions/api/tenant-admin.mjs'), 'utf8');
  assert.match(source, /bindProductionCognitoLock\(client, \{[\s\S]*applicationUserId: appUserId/);
  assert.doesNotMatch(source, /applicationUserId:\s*body\.(application_user_id|user_id|applicationUserId)/);

  const client = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: OWNER_SUB }],
    profiles: [{ id: INVITED_USER, email: INVITE_EMAIL }],
  });
  const result = await productionInvite({
    client,
    body: {
      tenant_id: PROD_TENANT,
      email: INVITE_EMAIL,
      role: 'admin',
      application_user_id: SPOOF_USER,
      applicationUserId: SPOOF_USER,
      user_id: SPOOF_USER,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, INVITED_USER);
  const inserted = client.writes.find((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL);
  assert.equal(inserted.params[0], INVITED_USER);
  assert.notEqual(inserted.params[0], SPOOF_USER);
});

test('5. client cannot spoof tenant_id to create another identity binding', async () => {
  const client = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: OWNER_SUB }],
    profiles: [{ id: INVITED_USER, email: INVITE_EMAIL }],
    adminOf: [PROD_TENANT],
    systemAdmin: false,
    masterOwner: false,
  });
  const denied = await productionInvite({
    client,
    body: { tenant_id: FREEDOM_TENANT, email: INVITE_EMAIL, role: 'admin' },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.statusCode, 403);
  assert.equal(client.writes.some((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL), false);

  const allowed = await productionInvite({
    client,
    body: {
      tenant_id: PROD_TENANT,
      email: INVITE_EMAIL,
      role: 'admin',
      spoof_tenant_id: FREEDOM_TENANT,
    },
  });
  assert.equal(allowed.ok, true);
  const inserted = client.writes.find((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL);
  assert.deepEqual(inserted.params, [INVITED_USER, INVITED_SUB]);
  assert.equal(inserted.params.includes(FREEDOM_TENANT), false);
  assert.equal(inserted.params.includes(PROD_TENANT), false);
  assert.doesNotMatch(INSERT_PRODUCTION_LOCK_SQL, /tenant/i);
});

test('6. existing valid lock remains unchanged and is idempotent', async () => {
  const helper = lockStore([{ application_user_id: INVITED_USER, cognito_sub: INVITED_SUB }]);
  const result = await bindProductionCognitoLock(helper, {
    cognitoSub: INVITED_SUB,
    applicationUserId: INVITED_USER,
    identityScope: productionScope(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.writesAttempted, false);
  assert.equal(helper.writes.some((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL), false);
  assert.equal(helper.locks.size, 1);

  const client = inviteClient({
    locks: [
      { application_user_id: OWNER_USER, cognito_sub: OWNER_SUB },
      { application_user_id: INVITED_USER, cognito_sub: INVITED_SUB },
    ],
    profiles: [{ id: INVITED_USER, email: INVITE_EMAIL }],
  });
  const invite = await productionInvite({
    client,
    existingCognito: true,
    body: { tenant_id: PROD_TENANT, email: INVITE_EMAIL, role: 'admin' },
  });
  assert.equal(invite.ok, true);
  assert.equal(client.writes.some((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL), false);
  assert.equal(client.locks.size, 2);
  assert.ok([...client.locks.values()].some((row) => (
    row.application_user_id === OWNER_USER && row.cognito_sub === OWNER_SUB
  )));
});

test('7. staging invite stays on identity_accounts and does not write locks', async () => {
  const client = inviteClient({
    profiles: [{ id: INVITED_USER, email: INVITE_EMAIL }],
  });
  const result = await runTenantInviteUser({
    client,
    mapping: { application_user_id: OWNER_USER, email: OWNER_EMAIL },
    spoof: { ignored: true },
    identityScope: stagingScope(),
    body: { tenant_id: PROD_TENANT, email: INVITE_EMAIL, role: 'admin' },
    send: async () => ({ deliveredCount: 1 }),
    cognitoJson: async (target) => {
      if (target === 'AdminCreateUser') {
        return { User: { Username: INVITED_SUB, Attributes: [{ Name: 'sub', Value: INVITED_SUB }] } };
      }
      if (target === 'AdminSetUserPassword') return {};
      throw new Error(`unexpected ${target}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(client.writes.some((row) => row.sql.includes('INSERT INTO public.identity_accounts')), true);
  assert.equal(client.writes.some((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL), false);
  assert.equal(client.locks.size, 0);

  const skipped = await bindProductionCognitoLock(lockStore(), {
    cognitoSub: INVITED_SUB,
    applicationUserId: INVITED_USER,
    identityScope: stagingScope(),
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.writesAttempted, false);
});

test('8. existing platform-owner identity stays valid and login still does not write', async () => {
  const ownerLock = {
    application_user_id: OWNER_USER,
    cognito_sub: OWNER_SUB,
    email: OWNER_EMAIL,
    status: 'active',
  };
  const store = {
    writes: [],
    queries: [],
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      store.queries.push({ sql, params });
      if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)) {
        store.writes.push({ sql, params });
        throw new Error('identity resolution must not write');
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_PRODUCTION_IDENTITY_SQL) {
        return { rows: params[0] === OWNER_SUB ? [ownerLock] : [] };
      }
      if (sql.includes('FROM public.profiles')) {
        return { rows: [{ id: OWNER_USER, email: OWNER_EMAIL, full_name: 'Platform Owner', approval_status: 'approved' }] };
      }
      if (sql.includes('FROM public.tenant_users')) {
        return { rows: [] };
      }
      if (sql.includes('FROM public.user_roles')) {
        return { rows: [{ role: 'admin' }] };
      }
      if (sql.includes('auth.uid()')) return { rows: [{ auth_uid: OWNER_USER }] };
      if (sql.includes('is_master_owner()')) return { rows: [{ is_master_owner: true }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const looked = await lookupIdentityMapping(store, OWNER_SUB, productionScope());
  assert.equal(looked.mapping.application_user_id, OWNER_USER);
  assert.equal(looked.writesAttempted, false);
  const session = await resolveIdentitySession({
    cognitoSub: OWNER_SUB,
    email: OWNER_EMAIL,
    identityScope: productionScope(),
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => store,
  });
  assert.equal(session.ok, true);
  assert.equal(session.applicationUserId, OWNER_USER);
  assert.equal(session.isMasterOwner, true);
  assert.deepEqual(session.tenants, []);
  assert.equal(store.writes.length, 0);

  const identitySource = fs.readFileSync(path.join(ROOT, 'functions/api/identity.mjs'), 'utf8');
  assert.doesNotMatch(identitySource, /bindProductionCognitoLock/);
  assert.match(identitySource, /writesAttempted: false|lookupIdentityMapping/);
});

test('9. invitation failure does not create an incorrect lock', async () => {
  const cognitoFailClient = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: OWNER_SUB }],
  });
  const cognitoFail = await runTenantInviteUser({
    client: cognitoFailClient,
    mapping: { application_user_id: OWNER_USER, email: OWNER_EMAIL },
    spoof: { ignored: true },
    identityScope: productionScope(),
    body: { tenant_id: PROD_TENANT, email: INVITE_EMAIL, role: 'admin' },
    send: async () => ({ deliveredCount: 1 }),
    cognitoJson: async () => {
      const error = new Error('AccessDenied');
      error.name = 'AccessDeniedException';
      throw error;
    },
  });
  assert.equal(cognitoFail.ok, false);
  assert.equal(cognitoFail.error, 'cognito_invite_failed');
  assert.equal(cognitoFailClient.writes.some((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL), false);

  const identityFailClient = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: OWNER_SUB }],
    failIdentity: true,
  });
  const identityFail = await productionInvite({
    client: identityFailClient,
    body: { tenant_id: PROD_TENANT, email: INVITE_EMAIL, role: 'admin' },
  });
  assert.equal(identityFail.ok, false);
  assert.equal(identityFail.error, 'identity_link_failed');
  assert.equal(identityFailClient.writes.some((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL), false);

  const sent = [];
  const event = {
    rawPath: '/functions/v1/tenant-invite-user',
    headers: {},
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            sub: OWNER_SUB,
            email: OWNER_EMAIL,
            iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_h00WorYMT',
          },
        },
      },
    },
    body: JSON.stringify({
      tenant_id: PROD_TENANT,
      email: INVITE_EMAIL,
      role: 'admin',
      application_user_id: SPOOF_USER,
    }),
  };
  const handlerClient = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: OWNER_SUB, email: OWNER_EMAIL }],
    failMembership: true,
  });
  const handler = await handleTenantInviteUser(event, {
    identityScope: productionScope(),
    loadDatabaseCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => handlerClient,
    sendViaSesOrSink: async (payload) => {
      sent.push(payload);
      return { deliveredCount: 1 };
    },
    cognitoJson: async (target) => {
      if (target === 'AdminCreateUser') {
        return { User: { Username: INVITED_SUB, Attributes: [{ Name: 'sub', Value: INVITED_SUB }] } };
      }
      if (target === 'AdminSetUserPassword') return {};
      throw new Error(`unexpected ${target}`);
    },
  });
  assert.equal(handler.ok, false);
  assert.equal(handler.error, 'tenant_membership_failed');
  assert.equal(sent.length, 0);
  assert.equal(handlerClient.committed.value, false);
  assert.equal(handlerClient.committed.rolledBack, true);
});

test('10. identity binding does not grant tenant membership by itself', async () => {
  const helper = lockStore();
  const bound = await bindProductionCognitoLock(helper, {
    cognitoSub: INVITED_SUB,
    applicationUserId: INVITED_USER,
    identityScope: productionScope(),
  });
  assert.equal(bound.ok, true);
  assert.equal(helper.writes.every((row) => !/tenant_users/i.test(row.sql)), true);
  assert.doesNotMatch(INSERT_PRODUCTION_LOCK_SQL, /tenant_users|tenant_id/);

  const source = fs.readFileSync(path.join(ROOT, 'functions/api/identity-env.mjs'), 'utf8');
  assert.match(source, /Login \/identity\/me must not call this/);
  assert.match(source, /IDENTITY_ENV_PRODUCTION/);
  assert.doesNotMatch(source, /INSERT INTO public\.tenant_users/);

  const client = inviteClient({
    locks: [{ application_user_id: OWNER_USER, cognito_sub: OWNER_SUB }],
    profiles: [{ id: INVITED_USER, email: INVITE_EMAIL }],
  });
  await productionInvite({
    client,
    body: { tenant_id: PROD_TENANT, email: INVITE_EMAIL, role: 'admin' },
  });
  const lockWrite = client.writes.find((row) => row.sql === INSERT_PRODUCTION_LOCK_SQL);
  const membershipWrite = client.writes.find((row) => row.sql.includes('INSERT INTO public.tenant_users'));
  assert.ok(lockWrite);
  assert.ok(membershipWrite);
  assert.notEqual(lockWrite.sql, membershipWrite.sql);
});

test('login and email-only inputs cannot establish a production lock', async () => {
  const missing = await bindProductionCognitoLock(lockStore(), {
    cognitoSub: '',
    applicationUserId: INVITED_USER,
    identityScope: productionScope(),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'identity_lock_missing_binding');

  const same = await bindProductionCognitoLock(lockStore(), {
    cognitoSub: INVITED_USER,
    applicationUserId: INVITED_USER,
    identityScope: productionScope(),
  });
  assert.equal(same.ok, false);
  assert.equal(same.error, 'unsafe_or_missing_cognito_sub');

  const userConflict = await bindProductionCognitoLock(
    lockStore([{ application_user_id: INVITED_USER, cognito_sub: OTHER_SUB }]),
    {
      cognitoSub: INVITED_SUB,
      applicationUserId: INVITED_USER,
      identityScope: productionScope(),
    },
  );
  assert.equal(userConflict.ok, false);
  assert.equal(userConflict.error, 'identity_lock_conflict');

  const loginSource = fs.readFileSync(path.join(ROOT, 'functions/api/identity.mjs'), 'utf8');
  const envSource = fs.readFileSync(path.join(ROOT, 'functions/api/identity-env.mjs'), 'utf8');
  assert.doesNotMatch(loginSource, /bindProductionCognitoLock|INSERT_PRODUCTION_LOCK_SQL/);
  assert.match(envSource, /writesAttempted: false/);
  assert.equal(productionScope().identityEnv, IDENTITY_ENV_PRODUCTION);
  assert.equal(stagingScope().identityEnv, IDENTITY_ENV_STAGING);
});
