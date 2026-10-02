import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IDENTITY_ENV_PRODUCTION,
  INSERT_PRODUCTION_LOCK_SQL,
  PRODUCTION_IDENTITY_WRITE_GUC,
  SELECT_PRODUCTION_LOCK_BY_SUB_SQL,
  SELECT_PRODUCTION_LOCK_BY_USER_SQL,
  bindProductionCognitoLock,
} from '../functions/api/identity-env.mjs';

const productionScope = () => ({
  ok: true,
  identityEnv: IDENTITY_ENV_PRODUCTION,
  mappingSource: 'identity_production_cognito_locks',
});

test('bindProductionCognitoLock is a no-op in staging identity env', async () => {
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      throw new Error(`unexpected query in staging: ${sql}`);
    },
  };
  const result = await bindProductionCognitoLock(client, {
    cognitoSub: 'sub-1',
    applicationUserId: 'user-1',
    identityScope: { ok: true, identityEnv: 'staging', mappingSource: 'identity_accounts' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.bound, false);
  assert.equal(queries.length, 0);
});

test('bindProductionCognitoLock binds when no lock exists (production)', async () => {
  const calls = [];
  const lock = { bySub: null, byUser: null, inserted: null };
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql === SELECT_PRODUCTION_LOCK_BY_SUB_SQL) return { rows: lock.bySub ? [lock.bySub] : [] };
      if (sql === SELECT_PRODUCTION_LOCK_BY_USER_SQL) return { rows: lock.byUser ? [lock.byUser] : [] };
      if (sql.startsWith('SELECT set_config')) {
        assert.equal(params[0], PRODUCTION_IDENTITY_WRITE_GUC);
        assert.equal(params[1], '1');
        return { rows: [{ set_config: '1' }] };
      }
      if (sql === INSERT_PRODUCTION_LOCK_SQL) {
        lock.inserted = { application_user_id: params[0], cognito_sub: params[1] };
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await bindProductionCognitoLock(client, {
    cognitoSub: 'sub-2',
    applicationUserId: '11111111-1111-4111-8111-111111111111',
    identityScope: productionScope(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.bound, true);
  assert.equal(result.idempotent, false);
  assert.equal(result.writesAttempted, true);
  assert.deepEqual(lock.inserted, {
    application_user_id: '11111111-1111-4111-8111-111111111111',
    cognito_sub: 'sub-2',
  });
  assert.ok(calls.some((c) => c.sql === SELECT_PRODUCTION_LOCK_BY_SUB_SQL));
  assert.ok(calls.some((c) => c.sql === SELECT_PRODUCTION_LOCK_BY_USER_SQL));
  assert.ok(calls.some((c) => String(c.sql).startsWith('SELECT set_config')));
});

test('bindProductionCognitoLock is idempotent when the same pair is already present', async () => {
  const client = {
    query: async (sql, params = []) => {
      if (sql === SELECT_PRODUCTION_LOCK_BY_SUB_SQL) {
        return { rows: [{ application_user_id: 'user-3', cognito_sub: 'sub-3' }] };
      }
      if (sql === SELECT_PRODUCTION_LOCK_BY_USER_SQL) {
        return { rows: [{ application_user_id: 'user-3', cognito_sub: 'sub-3' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await bindProductionCognitoLock(client, {
    cognitoSub: 'sub-3',
    applicationUserId: 'user-3',
    identityScope: productionScope(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.bound, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.writesAttempted, false);
});

test('bindProductionCognitoLock fails closed on conflicting binding (sub -> other user)', async () => {
  const client = {
    query: async (sql, params = []) => {
      if (sql === SELECT_PRODUCTION_LOCK_BY_SUB_SQL) {
        return { rows: [{ application_user_id: 'other-user', cognito_sub: params[0] }] };
      }
      if (sql === SELECT_PRODUCTION_LOCK_BY_USER_SQL) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await bindProductionCognitoLock(client, {
    cognitoSub: 'sub-4',
    applicationUserId: 'user-4',
    identityScope: productionScope(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'identity_lock_conflict');
  assert.equal(result.writesAttempted, false);
});

test('bindProductionCognitoLock fails closed on conflicting binding (user -> other sub)', async () => {
  const client = {
    query: async (sql, params = []) => {
      if (sql === SELECT_PRODUCTION_LOCK_BY_SUB_SQL) return { rows: [] };
      if (sql === SELECT_PRODUCTION_LOCK_BY_USER_SQL) {
        return { rows: [{ application_user_id: params[0], cognito_sub: 'other-sub' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await bindProductionCognitoLock(client, {
    cognitoSub: 'sub-5',
    applicationUserId: 'user-5',
    identityScope: productionScope(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'identity_lock_conflict');
  assert.equal(result.writesAttempted, false);
});

