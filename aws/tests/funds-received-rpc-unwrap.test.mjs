import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handleDataRpc, unwrapRpcData } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';

const manyRows = [
  { id: 'ce3ba146-01a0-41f0-a7de-7fae966efe60', amount: 23259.16, check_intake_item_id: '3f60998b-ac56-4cea-8899-6363309d4bbf', sender_name: 'Sender A' },
  { id: '11111111-1111-4111-8111-111111111111', amount: 100.00, check_intake_item_id: '22222222-2222-4222-8222-222222222222', sender_name: 'Sender B' },
  { id: '33333333-3333-4333-8333-333333333333', amount: 50.77, check_intake_item_id: '44444444-4444-4444-8444-444444444444', sender_name: 'Sender C' },
];

const jwtEvent = (body) => ({
  rawPath: '/data/rpc',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/rpc' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const mockClient = (rows) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === COGNITO_SUB ? [{
          application_user_id: APP_ID,
          cognito_sub: COGNITO_SUB,
          email: 'checksops-tester@freedomadj.com',
          status: 'active',
        }] : [] };
      }
      if (String(sql).includes('get_tenant_funds_received')) return { rows };
      return { rows: [] };
    },
    end: async () => {},
  };
};

test('unwrapRpcData(get_tenant_funds_received, manyRows) returns the complete array', () => {
  const data = unwrapRpcData('get_tenant_funds_received', manyRows);
  assert.ok(Array.isArray(data));
  assert.equal(data.length, manyRows.length);
  assert.deepEqual(data, manyRows);
});

test('unwrapRpcData still unwraps true single-column RPCs', () => {
  assert.equal(unwrapRpcData('has_permission', [{ has_permission: true }]), true);
  assert.equal(unwrapRpcData('get_total_unread_check_messages', [{ get_total_unread_check_messages: 4 }]), 4);
  assert.equal(unwrapRpcData('get_tenant_funds_received', []), []);
});

test('lane mapping does not throw when API returns the full funds-received array', () => {
  const data = unwrapRpcData('get_tenant_funds_received', manyRows);
  assert.doesNotThrow(() => data.map((row) => ({ id: row.id, amount: row.amount })));
  const mapped = data.map((row) => ({ id: row.id, amount: row.amount }));
  assert.equal(mapped.length, 3);
  assert.equal(mapped.reduce((n, r) => n + Number(r.amount), 0), 23409.93);
});

test('handleDataRpc preserves get_tenant_funds_received as an array', async () => {
  const client = mockClient(manyRows);
  const result = await handleDataRpc(jwtEvent({
    name: 'get_tenant_funds_received',
    args: { _tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  }), {
    loadDatabaseCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => client,
  });
  assert.equal(result.statusCode, 200);
  assert.ok(Array.isArray(result.data));
  assert.equal(result.data.length, manyRows.length);
  assert.equal(result.data[0].id, manyRows[0].id);
  assert.match(client.queries.some((q) => String(q.sql).includes('get_tenant_funds_received')) ? 'called' : '', /called/);
});

test('data.mjs no longer lists get_tenant_funds_received in RPC_UNWRAP_SINGLE_COLUMN', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const block = src.slice(src.indexOf('const RPC_UNWRAP_SINGLE_COLUMN'), src.indexOf('export const ident'));
  assert.match(block, /RPC_UNWRAP_SINGLE_COLUMN/);
  assert.doesNotMatch(block, /get_tenant_funds_received/);
  assert.match(src, /READ_RPCS[\s\S]*get_tenant_funds_received/);
});
