/**
 * /data/rpc get_shared_check_source_sends (owner 2026-11-13: "Sends to someone other than the partner"): a partner reads
 * which checks shared with it the sharing organization paid from by a send to someone else, through SQL 162's SECURITY
 * DEFINER read. data.mjs lists it in READ_RPCS behind the tenant gate (aws_can_access_tenant on _tenant_id, before the
 * function runs); the rows come back as the array the function returns (no single-column unwrap). Nothing about SQL 162 is
 * read when data.mjs loads: where the function is absent the call fails like any failed read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { RPC_ACCESS_GATES, handleDataRpc, unwrapRpcData } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = 'get_shared_check_source_sends';
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const ROWS = [
  { check_id: 'a15dfd40-0000-4000-8000-000000000000', source_tenant_id: '9b1f3c55-1111-4222-8333-444455556666', last_sent_at: '2026-11-12T19:06:01.000Z' },
  { check_id: 'b25dfd40-0000-4000-8000-000000000000', source_tenant_id: '9b1f3c55-1111-4222-8333-444455556666', last_sent_at: '2026-11-11T15:00:00.000Z' },
];

const event = (body) => ({
  rawPath: '/data/rpc',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/rpc' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'member@example.invalid', token_use: 'id' } } },
  },
});
const mockClient = ({ access = true, rows = ROWS, missing = false } = {}) => {
  const queries = [];
  return {
    queries,
    ran: () => queries.some((q) => String(q.sql).includes(`public.${NAME}(`)),
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (String(sql).startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'member@example.invalid', status: 'active' }] };
      }
      if (String(sql).includes('aws_can_access_tenant')) return { rows: [{ ok: access }] };
      if (String(sql).includes(`public.${NAME}(`)) {
        if (missing) throw Object.assign(new Error(`function public.${NAME}(_tenant_id => uuid) does not exist`), { code: '42883' });
        return { rows };
      }
      return { rows: [] };
    },
    end: async () => {},
  };
};
const call = (client, args) => handleDataRpc(event({ name: NAME, args }), {
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
});

test('data.mjs: a read RPC behind the tenant gate on _tenant_id; never a write, never unwrapped', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const block = src.slice(src.indexOf('const READ_RPCS = new Set(['), src.indexOf(']);', src.indexOf('const READ_RPCS = new Set([')));
  assert.ok(block.includes(`'${NAME}'`));
  assert.deepEqual(RPC_ACCESS_GATES[NAME], { tenant: '_tenant_id' });
  const unwrap = src.slice(src.indexOf('const RPC_UNWRAP_SINGLE_COLUMN = new Set(['), src.indexOf(']);', src.indexOf('const RPC_UNWRAP_SINGLE_COLUMN = new Set([')));
  assert.doesNotMatch(unwrap, new RegExp(NAME));
  assert.deepEqual(unwrapRpcData(NAME, ROWS), ROWS);
  assert.deepEqual(unwrapRpcData(NAME, []), []);
  // Nothing in data.mjs reads SQL 162 at load: the name appears only in the two lists.
  assert.equal([...src.matchAll(new RegExp(NAME, 'g'))].length, 2);
});

test('a member of the tenant reads the rows as an array; the gate runs first with the tenant id', async () => {
  const client = mockClient();
  const result = await call(client, { _tenant_id: TENANT });
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.deepEqual(result.data, ROWS);
  const gateAt = client.queries.findIndex((q) => String(q.sql).includes('aws_can_access_tenant'));
  const runAt = client.queries.findIndex((q) => String(q.sql).includes(`public.${NAME}(`));
  assert.ok(gateAt >= 0 && gateAt < runAt);
  assert.deepEqual(client.queries[gateAt].params, [TENANT]);
  assert.equal(client.queries[runAt].sql, `SELECT * FROM public.${NAME}(_tenant_id := $1)`);
  assert.deepEqual(client.queries[runAt].params, [TENANT]);
});

test('another tenant, a missing or malformed tenant id: refused before the function runs', async () => {
  const other = mockClient({ access: false });
  const refused = await call(other, { _tenant_id: TENANT });
  assert.equal(refused.statusCode, 403);
  assert.equal(other.ran(), false);
  for (const args of [{}, { _tenant_id: 'not-a-uuid' }]) {
    const client = mockClient();
    assert.equal((await call(client, args)).statusCode, 400, JSON.stringify(args));
    assert.equal(client.ran(), false);
  }
});

test('where SQL 162 is absent the call fails as a failed read (no 200, no rows), and nothing else breaks', async () => {
  const client = mockClient({ missing: true });
  const result = await call(client, { _tenant_id: TENANT }).catch((error) => ({ thrown: error }));
  assert.ok(result.thrown || result.statusCode >= 400, JSON.stringify(result));
  assert.ok(!result.data || !Array.isArray(result.data) || result.data.length === 0);
  // get_tenant_funds_received and get_tenant_incoming_transfers are unaffected.
  const funds = mockClient();
  const ok = await handleDataRpc(event({ name: 'get_tenant_funds_received', args: { _tenant_id: TENANT } }), {
    loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops' }),
    createClient: () => funds,
  });
  assert.equal(ok.statusCode, 200);
  const incoming = mockClient();
  const both = await handleDataRpc(event({ name: 'get_tenant_incoming_transfers', args: { _tenant_id: TENANT } }), {
    loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops' }),
    createClient: () => incoming,
  });
  assert.equal(both.statusCode, 200);
});
