import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHireMortgageAgent } from '../functions/api/tenant-admin.mjs';
import {
  INSERT_PRODUCTION_LOCK_SQL,
  PRODUCTION_IDENTITY_WRITE_GUC,
  SELECT_PRODUCTION_LOCK_BY_SUB_SQL,
  SELECT_PRODUCTION_LOCK_BY_USER_SQL,
} from '../functions/api/identity-env.mjs';

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APP_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const compact = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();
const SUB_SQL = compact(SELECT_PRODUCTION_LOCK_BY_SUB_SQL);
const USER_SQL = compact(SELECT_PRODUCTION_LOCK_BY_USER_SQL);
const INSERT_SQL = compact(INSERT_PRODUCTION_LOCK_SQL);

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const c = compact(sql);
    for (const handler of handlers) {
      if (handler.match(c, params)) return handler.result(params, c);
    }
    throw new Error(`unexpected query: ${c}`);
  },
});

const productionScope = () => ({
  ok: true,
  identityEnv: 'production',
  mappingSource: 'identity_production_cognito_locks',
});

test('production hire-mortgage-agent binds production lock using server-resolved app user + Cognito sub', async () => {
  const queries = [];
  const client = sqlClient([
    {
      match: (sql) => sql.includes("FROM public.user_roles WHERE user_id") && sql.includes("role = 'admin'"),
      result: () => ({ rows: [{ role: 'admin' }] }),
    },
    { match: (sql) => sql.includes('SELECT public.is_master_owner()'), result: () => ({ rows: [{ is_master: false }] }) },
    {
      match: (sql) => sql.includes('FROM public.profiles') && sql.includes('lower(email) = $1'),
      result: () => ({ rows: [{ id: APP_USER }] }),
    },
    {
      match: (sql) => sql.includes('SELECT role FROM public.user_roles') && sql.includes('WHERE user_id = $1::uuid'),
      result: () => ({ rows: [] }),
    },
    { match: (sql) => sql.includes('INSERT INTO public.identity_accounts'), result: () => ({ rows: [], rowCount: 1 }) },
    {
      match: (sql) => sql.includes('aws_hire_mortgage_agent_provision'),
      result: (params) => {
        assert.equal(params[0], APP_USER);
        assert.equal(params[1], 'agent@example.com');
        assert.equal(params[2], 'Mo Agent');
        return { rows: [{ result: { ok: true, mortgage_agent_granted: true } }], rowCount: 1 };
      },
    },

    {
      match: (sql) => sql === SUB_SQL,
      result: (params) => {
        queries.push({ sql: SUB_SQL, params });
        assert.equal(params[0], 'server-sub-1');
        return { rows: [] };
      },
    },
    {
      match: (sql) => sql === USER_SQL,
      result: (params) => {
        queries.push({ sql: USER_SQL, params });
        assert.equal(params[0], APP_USER);
        return { rows: [] };
      },
    },
    {
      match: (sql) => sql.startsWith('SELECT set_config'),
      result: (params) => {
        queries.push({ sql: 'SELECT set_config', params });
        assert.equal(params[0], PRODUCTION_IDENTITY_WRITE_GUC);
        assert.equal(params[1], '1');
        return { rows: [{ set_config: '1' }] };
      },
    },
    {
      match: (sql) => sql === INSERT_SQL,
      result: (params) => {
        queries.push({ sql: INSERT_SQL, params });
        assert.equal(params[0], APP_USER);
        assert.equal(params[1], 'server-sub-1');
        return { rows: [], rowCount: 1 };
      },
    },

    // profiles/user_roles provisioning must happen via the narrow SECURITY DEFINER function.
    {
      match: (sql) => sql.includes('INSERT INTO public.profiles') || (sql.includes('INSERT INTO public.user_roles') && sql.includes('mortgage_agent')),
      result: () => { throw new Error('direct provisioning write attempted'); },
    },
  ]);

  const result = await runHireMortgageAgent({
    client,
    mapping: { application_user_id: ADMIN },
    spoof: { ignored: true },
    identityScope: productionScope(),
    send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
    body: {
      email: 'agent@example.com',
      full_name: 'Mo Agent',
      applicationUserId: OTHER_USER,
      cognito_sub: 'client-supplied-evil',
    },
    cognitoJson: async (target) => {
      assert.equal(target, 'AdminCreateUser');
      return { User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'server-sub-1' }] } };
    },
  });

  assert.equal(result.ok, true);
  assert.ok(queries.some((q) => q.sql === SUB_SQL));
  assert.ok(queries.some((q) => q.sql === USER_SQL));
  assert.ok(queries.some((q) => q.sql === INSERT_SQL));
});

test('production hire-mortgage-agent fails closed on conflicting lock', async () => {
  const client = sqlClient([
    { match: (sql) => sql.includes("role = 'admin'"), result: () => ({ rows: [{ role: 'admin' }] }) },
    { match: (sql) => sql.includes('SELECT public.is_master_owner()'), result: () => ({ rows: [{ is_master: false }] }) },
    { match: (sql) => sql.includes('FROM public.profiles') && sql.includes('lower(email)'), result: () => ({ rows: [{ id: APP_USER }] }) },
    { match: (sql) => sql.includes('SELECT role FROM public.user_roles') && sql.includes('WHERE user_id = $1::uuid'), result: () => ({ rows: [] }) },
    { match: (sql) => sql.includes('INSERT INTO public.identity_accounts'), result: () => ({ rows: [], rowCount: 1 }) },
    {
      match: (sql) => sql.includes('aws_hire_mortgage_agent_provision'),
      result: () => ({ rows: [{ result: { ok: true, mortgage_agent_granted: true } }], rowCount: 1 }),
    },
    { match: (sql) => sql === SUB_SQL, result: () => ({ rows: [{ application_user_id: OTHER_USER, cognito_sub: 'server-sub-2' }] }) },
    { match: (sql) => sql === USER_SQL, result: () => ({ rows: [] }) },
  ]);

  const result = await runHireMortgageAgent({
    client,
    mapping: { application_user_id: ADMIN },
    spoof: { ignored: true },
    identityScope: productionScope(),
    send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
    body: { email: 'agent@example.com', full_name: 'Mo Agent' },
    cognitoJson: async () => ({ User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'server-sub-2' }] } }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'identity_lock_conflict');
});

test('staging hire-mortgage-agent never touches production lock table', async () => {
  const client = sqlClient([
    { match: (sql) => sql.includes("role = 'admin'"), result: () => ({ rows: [{ role: 'admin' }] }) },
    { match: (sql) => sql.includes('SELECT public.is_master_owner()'), result: () => ({ rows: [{ is_master: false }] }) },
    { match: (sql) => sql.includes('FROM public.profiles') && sql.includes('lower(email)'), result: () => ({ rows: [{ id: APP_USER }] }) },
    { match: (sql) => sql.includes('SELECT role FROM public.user_roles') && sql.includes('WHERE user_id = $1::uuid'), result: () => ({ rows: [] }) },
    { match: (sql) => sql.includes('INSERT INTO public.identity_accounts'), result: () => ({ rows: [], rowCount: 1 }) },
    { match: (sql) => sql.includes('aws_hire_mortgage_agent_provision'), result: () => ({ rows: [{ result: { ok: true, mortgage_agent_granted: true } }], rowCount: 1 }) },
    {
      match: (sql) => sql.includes('identity_production_cognito_locks') || sql.startsWith('SELECT set_config'),
      result: () => {
        throw new Error('production lock write attempted in staging');
      },
    },
    {
      match: (sql) => sql.includes('INSERT INTO public.profiles') || (sql.includes('INSERT INTO public.user_roles') && sql.includes('mortgage_agent')),
      result: () => { throw new Error('direct provisioning write attempted'); },
    },
  ]);

  const result = await runHireMortgageAgent({
    client,
    mapping: { application_user_id: ADMIN },
    spoof: { ignored: true },
    identityScope: { ok: true, identityEnv: 'staging', mappingSource: 'identity_accounts' },
    send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink' }] }),
    body: { email: 'agent@example.com', full_name: 'Mo Agent' },
    cognitoJson: async () => ({ User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'server-sub-3' }] } }),
  });

  assert.equal(result.ok, true);
});

