import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import {
  CLIENT_IDENTITY_KEYS,
  denyTableReason,
  pickAllowlistedValues,
  WRITE_ALLOWLIST,
} from '../functions/api/write-allowlist.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': 'spoof-tenant',
    'x-role': 'admin',
    ...(extra.headers || {}),
  },
  queryStringParameters: { user_id: SPOOF_ID, tenant_id: 'spoof-tenant', ...(extra.query || {}) },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: { jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const mappingFor = (sub = COGNITO_SUB) => ({
  application_user_id: APP_ID,
  cognito_sub: sub,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const mockClient = ({ rows = [], mapping = mappingFor(), throwOn = null } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (throwOn && String(sql).includes(throwOn)) {
        const error = new Error('synthetic write failure');
        error.code = '40001';
        throw error;
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      return { rows };
    },
    end: async () => {},
  };
};

const depsFor = (client) => ({
  forceEnabled: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: (config) => {
    client.lastConfig = config;
    return client;
  },
});

test('allowlist rejects financial tables and unknown columns; ignores spoof identity keys', () => {
  assert.equal(denyTableReason('claim_payments'), 'financial_or_provider');
  assert.equal(denyTableReason('check_intake_items'), 'financial_or_provider');
  assert.equal(denyTableReason('moov_unknown'), 'unknown_table');
  assert.equal(WRITE_ALLOWLIST.check_message_reads.ops.has('upsert'), true);
  const picked = pickAllowlistedValues('check_message_reads', {
    user_id: SPOOF_ID,
    tenant_id: 'spoof-tenant',
    check_id: CHECK_ID,
    last_read_at: '2026-09-02T00:00:00.000Z',
    amount: 12,
  });
  assert.equal(picked.error, 'column_not_allowlisted');
  assert.deepEqual(picked.columns, ['amount']);
  const ok = pickAllowlistedValues('notification_preferences', {
    user_id: SPOOF_ID,
    in_app_enabled: false,
    email_enabled: true,
    sms_enabled: false,
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.values.user_id, undefined);
  assert.equal(ok.ignored.includes('user_id'), true);
  assert.equal(CLIENT_IDENTITY_KEYS.has('tenant_id'), true);
});

test('POST /data/write upserts check_message_reads as mapped UUID and ignores spoofed ids', async () => {
  const client = mockClient({
    rows: [{ user_id: APP_ID, check_id: CHECK_ID, last_read_at: '2026-09-02T00:00:00.000Z' }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_message_reads',
    op: 'upsert',
    values: {
      user_id: SPOOF_ID,
      tenant_id: '4f172140-f57a-4744-8050-95f4f07b13b4',
      check_id: CHECK_ID,
      last_read_at: '2026-09-02T00:00:00.000Z',
    },
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, APP_ID);
  assert.notEqual(result.applicationUserId, result.cognitoSub);
  assert.equal(result.spoofFieldsIgnored.headerUserId, SPOOF_ID);
  const write = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_message_reads'));
  assert.ok(write);
  assert.equal(write.params[0], APP_ID);
  assert.equal(write.params.includes(SPOOF_ID), false);
  assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), true);
  assert.equal(client.queries.some((q) => q.sql === 'SET TRANSACTION READ WRITE'), true);
  assert.equal(Boolean(client.lastConfig?.options), false);
});

test('kill switch disables writes without using the write transaction', async () => {
  const previous = process.env.AWS_WRITES_ENABLED;
  process.env.AWS_WRITES_ENABLED = 'false';
  try {
    const client = mockClient();
    const result = await handleWrite(jwtEvent('/data/write', 'POST', {
      table: 'check_message_reads',
      op: 'upsert',
      values: { check_id: CHECK_ID },
    }), { ...depsFor(client), forceEnabled: false });
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'writes_disabled');
    assert.equal(client.queries.some((q) => String(q.sql).includes('INSERT')), false);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  } finally {
    if (previous === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previous;
  }
});

test('unauthenticated write is 401; unapproved table/column/financial tables are 403', async () => {
  const unauth = await handler({
    rawPath: '/data/write',
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/data/write' } },
    body: JSON.stringify({ table: 'check_message_reads', op: 'upsert', values: { check_id: CHECK_ID } }),
  });
  assert.equal(unauth.statusCode, 401);

  const client = mockClient();
  const unknown = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'tenants',
    op: 'update',
    values: { name: 'x' },
  }), depsFor(client));
  assert.equal(unknown.statusCode, 403);
  assert.equal(unknown.error, 'table_not_allowlisted');

  const financial = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'disbursement_batches',
    op: 'insert',
    values: { amount: 1 },
  }), depsFor(client));
  assert.equal(financial.reason, 'financial_or_provider');

  const column = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'notification_preferences',
    op: 'update',
    values: { webhook_url: 'https://evil.example' },
  }), depsFor(client));
  assert.equal(column.error, 'column_not_allowlisted');
});

test('generic /data mutating routes stay writes_disabled; get_or_create ignores p_user_id', async () => {
  const generic = await handler(jwtEvent('/data/claims', 'POST', { name: 'x' }));
  assert.equal(generic.statusCode, 403);
  assert.equal(JSON.parse(generic.body).error, 'writes_disabled');

  const client = mockClient({
    rows: [{ id: 'pref-1', user_id: APP_ID, in_app_enabled: true, email_enabled: true, sms_enabled: false }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'notification_preferences',
    op: 'get_or_create',
    args: { p_user_id: SPOOF_ID },
    values: { user_id: SPOOF_ID },
    maybeSingle: true,
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.user_id, APP_ID);
  const select = client.queries.find((q) => String(q.sql).includes('FROM public.notification_preferences'));
  assert.equal(select.params[0], APP_ID);
});

test('write errors roll back and do not COMMIT', async () => {
  const client = mockClient({ throwOn: 'INSERT INTO public.check_message_reads' });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: CHECK_ID },
  }), depsFor(client));
  assert.equal(result.ok, false);
  assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  assert.equal(client.queries.some((q) => q.sql === 'ROLLBACK'), true);
});

test('Cognito sub used as application UUID is refused', async () => {
  const client = mockClient({
    mapping: {
      application_user_id: COGNITO_SUB,
      cognito_sub: COGNITO_SUB,
      email: 'checksops-tester@freedomadj.com',
      status: 'active',
    },
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: CHECK_ID, user_id: COGNITO_SUB },
  }), depsFor(client));
  assert.equal(result.ok, false);
  assert.match(String(result.message || result.error), /application_user_id equals cognito_sub|data_query_failed/);
});

test('unmapped identity including ninth UUID cannot write', async () => {
  const client = mockClient();
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'notification_preferences',
    op: 'update',
    values: { in_app_enabled: false },
  }, { sub: '00000000-0000-0000-0000-000000000009' }), depsFor(client));
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, 'identity_not_linked');
  assert.equal(client.queries.some((q) => String(q.sql).includes('INSERT') || String(q.sql).includes('UPDATE')), false);
});
