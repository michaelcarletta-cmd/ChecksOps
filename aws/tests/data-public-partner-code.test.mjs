/**
 * Audit finding 9 (2026-10-29): a partner code connects whoever enters it, and POST /data/query
 * answered tenants_public with every tenant's partner_code, signed in or not (an anonymous request
 * to staging returned them). The public tenant list keeps its public columns and never carries a
 * partner code: `*` strips it, naming it in a select, filter or order is refused before any read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleDataQuery } from '../functions/api/data.mjs';

const TENANTS = [
  { id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', name: 'Freedom Adjustment', slug: 'freedom', partner_code: 'FREEDOM-CODE-1' },
  { id: '4f172140-f57a-4744-8050-95f4f07b13b4', name: 'Condition One Commercial', slug: 'c1c', partner_code: 'C1C-CODE-2' },
];

/** A database that hands back partner codes whenever the query lets them through. */
const mockClient = () => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/^(BEGIN|ROLLBACK|COMMIT)/.test(sql)) return { rows: [] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: TENANTS.length }] };
      if (/FROM public\.tenants_public/.test(sql)) return { rows: TENANTS.map((t) => ({ ...t })) };
      return { rows: [] };
    },
    end: async () => {},
  };
};

const anonymous = (body) => ({
  rawPath: '/data/query',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ op: 'select', ...body }),
  requestContext: { stage: 'staging', http: { method: 'POST', path: '/data/query' }, requestId: 'req-public-partner-code' },
});

const run = async (body) => {
  const client = mockClient();
  const result = await handleDataQuery(anonymous(body), {
    loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops' }),
    createClient: () => client,
  });
  return { result, client };
};

const reads = (client) => client.queries.filter((q) => /FROM public\./.test(q.sql));

test('anonymous tenants_public: names, slugs and the other public columns still answer', async () => {
  const { result } = await run({ table: 'tenants_public', select: 'id, name, slug' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.data.map((t) => t.name), ['Freedom Adjustment', 'Condition One Commercial']);
});

test('anonymous tenants_public with * never returns a partner code', async () => {
  const { result } = await run({ table: 'tenants_public', select: '*' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.length, 2);
  for (const row of result.data) assert.equal(Object.hasOwn(row, 'partner_code'), false, row.name);
  assert.equal(JSON.stringify(result).includes('-CODE-'), false);
});

test('anonymous tenants_public: selecting, filtering or ordering by partner_code is refused before any read', async () => {
  for (const body of [
    { select: 'id, name, partner_code' },
    { select: 'name', filters: [{ column: 'partner_code', op: 'eq', value: 'C1C-CODE-2' }] },
    { select: 'name', filters: [{ column: 'name', op: 'or', value: 'partner_code.eq.C1C-CODE-2,name.eq.x' }] },
    { select: 'name', order: { column: 'partner_code' } },
  ]) {
    const { result, client } = await run({ table: 'tenants_public', ...body });
    const label = JSON.stringify(body);
    assert.equal(result.statusCode, 403, label);
    assert.equal(result.error, 'secret_column_denied', label);
    assert.deepEqual(reads(client), [], label);
    assert.equal(JSON.stringify(result).includes('-CODE-'), false, label);
  }
});

test('anonymous requests for any other table still need a login', async () => {
  const { result, client } = await run({ table: 'tenants', select: 'id, name, partner_code' });
  assert.equal(result.statusCode, 401);
  assert.deepEqual(reads(client), []);
});
