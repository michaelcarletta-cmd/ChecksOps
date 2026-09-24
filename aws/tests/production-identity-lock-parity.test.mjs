import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHireMortgageAgent } from '../functions/api/tenant-admin.mjs';
import {
  PRODUCTION_COGNITO_LOCK_INSERT_SQL,
  PRODUCTION_COGNITO_LOCK_LOOKUP_SQL,
  PRODUCTION_IDENTITY_WRITE_GUC,
} from '../functions/api/identity-env.mjs';

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APP_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EMAIL = 'agent@example.com';
const FULL_NAME = 'Mo Agent';

const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const PRODUCTION_POOL = 'us-east-1_h00WorYMT';

const withEnv = async (values, fn) => {
  const prior = {};
  for (const [k, v] of Object.entries(values)) {
    prior[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const statefulClient = ({ profileId = APP_USER, locksSeed = [] } = {}) => {
  const queries = [];
  const locksByUser = new Map();
  const locksBySub = new Map();
  for (const [userId, sub] of locksSeed) {
    locksByUser.set(String(userId), String(sub));
    locksBySub.set(String(sub), String(userId));
  }

  const normalize = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

  const query = async (sql, params = []) => {
    const compact = normalize(sql);
    queries.push({ sql: compact, params });

    if (compact.includes("FROM public.user_roles WHERE user_id") && compact.includes("role = 'admin'")) {
      assert.equal(String(params[0]), ADMIN);
      return { rows: [{ role: 'admin' }], rowCount: 1 };
    }

    if (compact.includes('SELECT public.is_master_owner() AS is_master')) {
      return { rows: [{ is_master: false }], rowCount: 1 };
    }

    if (compact.includes('FROM public.profiles') && compact.includes('lower(email) = $1')) {
      return { rows: profileId ? [{ id: String(profileId) }] : [], rowCount: profileId ? 1 : 0 };
    }

    if (compact.includes('SELECT role FROM public.user_roles WHERE user_id = $1::uuid') && !compact.includes("role = 'admin'")) {
      return { rows: [], rowCount: 0 };
    }

    if (compact.includes('INSERT INTO public.identity_accounts')) {
      return { rows: [], rowCount: 1 };
    }

    if (compact === `SET LOCAL ${PRODUCTION_IDENTITY_WRITE_GUC}=1`) {
      return { rows: [], rowCount: 0 };
    }

    if (compact === normalize(PRODUCTION_COGNITO_LOCK_INSERT_SQL)) {
      const userId = String(params[0]);
      const sub = String(params[1]);
      const existingUserSub = locksByUser.get(userId) || null;
      const existingSubUser = locksBySub.get(sub) || null;
      if (!existingUserSub && !existingSubUser) {
        locksByUser.set(userId, sub);
        locksBySub.set(sub, userId);
      }
      return { rows: [], rowCount: 1 };
    }

    if (compact === normalize(PRODUCTION_COGNITO_LOCK_LOOKUP_SQL)) {
      const userId = String(params[0]);
      const sub = String(params[1]);
      const rows = [];
      const userSub = locksByUser.get(userId);
      const subUser = locksBySub.get(sub);
      if (userSub) rows.push({ application_user_id: userId, cognito_sub: userSub });
      if (subUser && subUser !== userId) {
        rows.push({ application_user_id: subUser, cognito_sub: sub });
      } else if (subUser && !userSub) {
        rows.push({ application_user_id: subUser, cognito_sub: sub });
      }
      return { rows, rowCount: rows.length };
    }

    if (compact.includes('INSERT INTO public.profiles')) {
      return { rows: [], rowCount: 1 };
    }

    if (compact.includes('INSERT INTO public.user_roles') && compact.includes("'mortgage_agent'")) {
      return { rows: [{ id: '1' }], rowCount: 1 };
    }

    if (compact.includes('SELECT 1 FROM public.user_roles') && compact.includes("'mortgage_agent'")) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    if (/^\s*select\b/i.test(compact)) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected write query: ${compact}`);
  };

  return {
    query,
    queries,
    locksByUser,
    locksBySub,
  };
};

test('production hire-mortgage-agent binds production identity lock using server-resolved sub and server-resolved app user', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'production-prep',
    COGNITO_USER_POOL_ID: PRODUCTION_POOL,
    COGNITO_CLIENT_ID: 'client-prod-test',
    AWS_REGION: 'us-east-1',
  }, async () => {
    const client = statefulClient({ profileId: APP_USER });
    const result = await runHireMortgageAgent({
      client,
      mapping: { application_user_id: ADMIN },
      spoof: { ignored: true },
      send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
      body: {
        email: EMAIL,
        full_name: FULL_NAME,
        cognito_sub: 'client-supplied-evil',
        applicationUserId: OTHER_USER,
      },
      cognitoJson: async (target) => {
        assert.equal(target, 'AdminCreateUser');
        return { User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'server-sub-1' }] } };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(client.locksByUser.get(APP_USER), 'server-sub-1');
    assert.equal(client.locksBySub.get('server-sub-1'), APP_USER);
    assert.ok(client.queries.some((q) => q.sql === `SET LOCAL ${PRODUCTION_IDENTITY_WRITE_GUC}=1`));
    assert.ok(client.queries.some((q) => q.sql === String(PRODUCTION_COGNITO_LOCK_INSERT_SQL).replace(/\s+/g, ' ').trim()));
  });
});

test('staging hire-mortgage-agent never writes the production lock', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'staging',
    COGNITO_USER_POOL_ID: STAGING_POOL,
    COGNITO_CLIENT_ID: 'client-staging-test',
    AWS_REGION: 'us-east-1',
  }, async () => {
    const client = statefulClient({ profileId: APP_USER });
    const result = await runHireMortgageAgent({
      client,
      mapping: { application_user_id: ADMIN },
      spoof: { ignored: true },
      send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
      body: { email: EMAIL, full_name: FULL_NAME },
      cognitoJson: async () => ({ User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'server-sub-2' }] } }),
    });
    assert.equal(result.ok, true);
    assert.equal(client.queries.some((q) => q.sql.includes('identity_production_cognito_locks')), false);
    assert.equal(client.queries.some((q) => q.sql.startsWith(`SET LOCAL ${PRODUCTION_IDENTITY_WRITE_GUC}`)), false);
  });
});

test('production hire-mortgage-agent is idempotent for the same app-user/sub pair', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'production',
    COGNITO_USER_POOL_ID: PRODUCTION_POOL,
    COGNITO_CLIENT_ID: 'client-prod-test',
    AWS_REGION: 'us-east-1',
  }, async () => {
    const client = statefulClient({ profileId: APP_USER });
    let created = 0;
    const cognitoJson = async (target) => {
      if (target === 'AdminCreateUser') {
        created += 1;
        if (created === 1) {
          return { User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'server-sub-3' }] } };
        }
        const err = new Error('exists');
        err.name = 'UsernameExistsException';
        throw err;
      }
      if (target === 'AdminGetUser') {
        return { Username: 'cog', UserAttributes: [{ Name: 'sub', Value: 'server-sub-3' }] };
      }
      throw new Error(`unexpected cognito target ${target}`);
    };

    const first = await runHireMortgageAgent({
      client,
      mapping: { application_user_id: ADMIN },
      spoof: { ignored: true },
      send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
      body: { email: EMAIL, full_name: FULL_NAME },
      cognitoJson,
    });
    const second = await runHireMortgageAgent({
      client,
      mapping: { application_user_id: ADMIN },
      spoof: { ignored: true },
      send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
      body: { email: EMAIL, full_name: FULL_NAME },
      cognitoJson,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(client.locksByUser.get(APP_USER), 'server-sub-3');
    assert.equal(client.locksBySub.get('server-sub-3'), APP_USER);
  });
});

test('production hire-mortgage-agent fails closed on conflicting production lock', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'production-prep',
    COGNITO_USER_POOL_ID: PRODUCTION_POOL,
    COGNITO_CLIENT_ID: 'client-prod-test',
    AWS_REGION: 'us-east-1',
  }, async () => {
    const client = statefulClient({
      profileId: APP_USER,
      locksSeed: [[OTHER_USER, 'server-sub-4']],
    });

    const result = await runHireMortgageAgent({
      client,
      mapping: { application_user_id: ADMIN },
      spoof: { ignored: true },
      send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
      body: { email: EMAIL, full_name: FULL_NAME },
      cognitoJson: async () => ({ User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'server-sub-4' }] } }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'production_identity_lock_conflict');
  });
});

test('production hire-mortgage-agent fails closed when application user is already bound to a different production sub', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'production-prep',
    COGNITO_USER_POOL_ID: PRODUCTION_POOL,
    COGNITO_CLIENT_ID: 'client-prod-test',
    AWS_REGION: 'us-east-1',
  }, async () => {
    const client = statefulClient({
      profileId: APP_USER,
      locksSeed: [[APP_USER, 'existing-sub']],
    });

    const result = await runHireMortgageAgent({
      client,
      mapping: { application_user_id: ADMIN },
      spoof: { ignored: true },
      send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
      body: { email: EMAIL, full_name: FULL_NAME },
      cognitoJson: async () => ({ User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'new-sub' }] } }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'production_identity_lock_conflict');
  });
});

