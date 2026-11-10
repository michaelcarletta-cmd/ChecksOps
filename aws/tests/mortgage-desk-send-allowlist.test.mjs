// Send to Mortgage Desk (src/components/loss-draft/SendToMortgageDeskButton.tsx) through the
// real handleWrite: the exact insert body the button sends for a 1st and a 2nd mortgagee must
// pass the write allowlist and reach the INSERT; invalid values and a predecessor request from
// another tenant or another check are refused. Production 2026-11-10: the button failed with
// "Could not create request, column_not_allowlisted" (403 on POST /prep/data/write).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { WRITE_ALLOWLIST, pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const OTHER_CHECK_ID = '9e3c2d4f-5a6b-4789-8bcd-ef0123456789';
const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIRST_REQUEST_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_TENANT_REQUEST_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_CHECK_REQUEST_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const jwtEvent = (body) => ({
  headers: { authorization: 'Bearer test' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/write' },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@example.com', token_use: 'id' } },
    },
  },
});

const MORTGAGE_REQUESTS = [
  { id: FIRST_REQUEST_ID, check_intake_item_id: CHECK_ID, tenant_id: TENANT },
  // Same check id, another tenant: cannot be named as a predecessor.
  { id: OTHER_TENANT_REQUEST_ID, check_intake_item_id: CHECK_ID, tenant_id: OTHER_TENANT },
  // Same tenant, another check: cannot be named as a predecessor either.
  { id: OTHER_CHECK_REQUEST_ID, check_intake_item_id: OTHER_CHECK_ID, tenant_id: TENANT },
];

const mockClient = () => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: params[0] === COGNITO_SUB
            ? [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@example.com', status: 'active' }]
            : [],
        };
      }
      if (/FROM public.check_intake_items WHERE id = \$1::uuid/.test(sql)) {
        return { rows: params[0] === CHECK_ID ? [{ id: CHECK_ID, tenant_id: TENANT, claim_id: CLAIM_ID }] : [] };
      }
      if (/FROM public.mortgage_handling_requests/.test(sql) && /tenant_id = \$2::uuid/.test(sql)) {
        const [id, tenantId, checkId] = params;
        return {
          rows: MORTGAGE_REQUESTS
            .filter((r) => r.id === id && r.tenant_id === tenantId && r.check_intake_item_id === checkId)
            .map((r) => ({ id: r.id })),
        };
      }
      if (/INSERT INTO public.mortgage_handling_requests/.test(sql)) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', check_intake_item_id: params[1] }] };
      }
      return { rows: [] };
    },
  };
};

const deps = (client) => ({
  forceEnabled: true,
  forceWorkflow: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

// The exact object SendToMortgageDeskButton.submit() passes to
// supabase.from("mortgage_handling_requests").insert(...) for the 1st mortgagee.
const firstMortgageeBody = () => ({
  tenant_id: TENANT,
  check_intake_item_id: CHECK_ID,
  claim_id: CLAIM_ID,
  mortgage_company: 'Test Mortgage Co',
  loan_number: 'LN-000123',
  note: null,
  requested_by: SPOOF_ID,
  policy_number: 'POL-42',
  claim_number: 'CLM-7',
  insurance_company: 'Test Carrier',
  loss_type: 'Wind',
  date_of_loss: '2026-10-01',
  homeowner_name: 'Test Homeowner',
  homeowner_email: 'homeowner@example.com',
  homeowner_phone: '555-0100',
  homeowner_ssn_last_four: '1234',
  property_address: '1 Test St',
});

// ...and for "Add 2nd mortgagee" (orderFields spread into the same object).
const secondMortgageeBody = (predecessor = FIRST_REQUEST_ID) => ({
  ...firstMortgageeBody(),
  mortgage_company: 'Second Lender',
  note: '[2nd mortgagee — send after 1st is endorsed & returned]',
  endorsement_order: 2,
  total_mortgagees: 2,
  predecessor_request_id: predecessor,
});

const insert = async (values) => {
  const client = mockClient();
  const result = await handleWrite(jwtEvent({ table: 'mortgage_handling_requests', op: 'insert', values }), deps(client));
  const sql = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.mortgage_handling_requests'));
  return { result, insertQuery: sql, client };
};

const insertedColumns = (insertQuery) => {
  const match = String(insertQuery.sql).match(/mortgage_handling_requests \(([^)]*)\)/);
  return match[1].split(',').map((c) => c.trim());
};

const insertedValue = (insertQuery, column) => {
  const index = insertedColumns(insertQuery).indexOf(column);
  assert.notEqual(index, -1, `${column} is not inserted`);
  const placeholders = String(insertQuery.sql).match(/VALUES \(([^)]*)\)/)[1].split(',').map((v) => v.trim());
  const param = placeholders[index].match(/^\$(\d+)::/);
  assert.ok(param, `${column} is not a bound parameter`);
  return insertQuery.params[Number(param[1]) - 1];
};

test('the 1st-mortgagee Send to Mortgage Desk body passes the allowlist and every field is inserted', async () => {
  const body = firstMortgageeBody();
  const picked = pickAllowlistedValues('mortgage_handling_requests', body);
  assert.equal(picked.error, undefined, JSON.stringify(picked));
  // tenant_id / requested_by / claim_id are ignored, never taken from the client.
  assert.deepEqual([...picked.ignored].sort(), ['claim_id', 'requested_by', 'tenant_id']);

  const { result, insertQuery } = await insert(body);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.statusCode, 200);
  assert.ok(insertQuery);
  // Identity and tenant come from the server: the check's tenant, the mapped user, the check's claim.
  assert.equal(insertedValue(insertQuery, 'tenant_id'), TENANT);
  assert.equal(insertedValue(insertQuery, 'requested_by'), APP_ID);
  assert.equal(insertedValue(insertQuery, 'claim_id'), CLAIM_ID);
  assert.match(insertQuery.sql, /'requested'/);
  for (const column of [
    'mortgage_company', 'loan_number', 'policy_number', 'claim_number', 'insurance_company', 'loss_type',
    'date_of_loss', 'homeowner_name', 'homeowner_email', 'homeowner_phone', 'homeowner_ssn_last_four',
    'property_address',
  ]) {
    assert.equal(insertedValue(insertQuery, column), body[column], column);
  }
  assert.equal(insertedValue(insertQuery, 'note'), null);
  assert.equal(insertedValue(insertQuery, 'endorsement_order'), null);
  assert.equal(insertedValue(insertQuery, 'total_mortgagees'), null);
  assert.equal(insertedValue(insertQuery, 'predecessor_request_id'), null);
  assert.match(insertQuery.sql, /\$\d+::date/);
});

test('the 2nd-mortgagee body passes with a predecessor request of the same tenant and check', async () => {
  const { result, insertQuery, client } = await insert(secondMortgageeBody());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(insertedValue(insertQuery, 'endorsement_order'), 2);
  assert.equal(insertedValue(insertQuery, 'total_mortgagees'), 2);
  assert.equal(insertedValue(insertQuery, 'predecessor_request_id'), FIRST_REQUEST_ID);
  const lookup = client.queries.find((q) => /FROM public.mortgage_handling_requests/.test(q.sql) && /tenant_id = \$2::uuid/.test(q.sql));
  assert.deepEqual(lookup.params, [FIRST_REQUEST_ID, TENANT, CHECK_ID]);
});

test('a predecessor request of another tenant or another check is refused', async () => {
  for (const predecessor of [OTHER_TENANT_REQUEST_ID, OTHER_CHECK_REQUEST_ID, '12345678-1234-4234-8234-123456789012']) {
    const { result, insertQuery } = await insert(secondMortgageeBody(predecessor));
    assert.equal(result.ok, false, predecessor);
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'rls_denied');
    assert.equal(insertQuery, undefined, 'no INSERT is issued');
  }
});

test('invalid Send to Mortgage Desk values are refused before any INSERT', async () => {
  const cases = [
    [{ homeowner_ssn_last_four: '123' }, 'homeowner_ssn_last_four'],
    [{ homeowner_ssn_last_four: '12345' }, 'homeowner_ssn_last_four'],
    [{ homeowner_ssn_last_four: '12a4' }, 'homeowner_ssn_last_four'],
    [{ homeowner_ssn_last_four: 1234 }, 'homeowner_ssn_last_four'],
    [{ date_of_loss: '10/01/2026' }, 'date_of_loss'],
    [{ date_of_loss: '2026-02-30' }, 'date_of_loss'],
    [{ date_of_loss: '2026-10-01T00:00:00Z' }, 'date_of_loss'],
    [{ endorsement_order: 0 }, 'endorsement_order'],
    [{ endorsement_order: 3 }, 'endorsement_order'],
    [{ endorsement_order: 1.5 }, 'endorsement_order'],
    [{ endorsement_order: 'two' }, 'endorsement_order'],
    [{ total_mortgagees: 0 }, 'total_mortgagees'],
    [{ total_mortgagees: 3 }, 'total_mortgagees'],
    [{ endorsement_order: 2, total_mortgagees: 1 }, 'endorsement_order'],
    [{ policy_number: 'x'.repeat(81) }, 'length'],
    [{ loss_type: 'x'.repeat(81) }, 'length'],
  ];
  for (const [patch, field] of cases) {
    const { result, insertQuery } = await insert({ ...firstMortgageeBody(), ...patch });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.statusCode, 400, JSON.stringify(patch));
    assert.equal(result.error, 'invalid_field', JSON.stringify(patch));
    assert.equal(result.field, field, JSON.stringify(patch));
    assert.equal(insertQuery, undefined, JSON.stringify(patch));
  }
  const badUuid = await insert(secondMortgageeBody('not-a-uuid'));
  assert.equal(badUuid.result.statusCode, 400);
  assert.equal(badUuid.result.error, 'invalid_uuid');
  assert.equal(badUuid.result.field, 'predecessor_request_id');
  assert.equal(badUuid.insertQuery, undefined);
});

test('empty optional values insert as NULL', async () => {
  const { result, insertQuery } = await insert({
    ...firstMortgageeBody(),
    policy_number: null,
    loss_type: null,
    date_of_loss: null,
    homeowner_ssn_last_four: null,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const column of ['policy_number', 'loss_type', 'date_of_loss', 'homeowner_ssn_last_four']) {
    assert.equal(insertedValue(insertQuery, column), null, column);
  }
});

test('the new columns are insert-only: an update naming them is refused (no tenant UPDATE grant or policy live)', async () => {
  // The 2nd-mortgagee backfill (update endorsement_order 1 / total_mortgagees 2 on the first
  // request) needs a database change first: SQL 100 records no tenant UPDATE policy and no
  // UPDATE grant on these columns. The API keeps refusing it, as before, instead of letting
  // the database fail.
  for (const values of [
    { endorsement_order: 1, total_mortgagees: 2 },
    { homeowner_ssn_last_four: '1234' },
    { predecessor_request_id: FIRST_REQUEST_ID },
  ]) {
    const client = mockClient();
    const result = await handleWrite(jwtEvent({
      table: 'mortgage_handling_requests',
      op: 'update',
      values,
      filters: [{ column: 'id', op: 'eq', value: FIRST_REQUEST_ID }],
    }), deps(client));
    assert.equal(result.ok, false, JSON.stringify(values));
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'column_not_allowlisted');
    assert.deepEqual(result.columns, Object.keys(values));
    assert.equal(client.queries.some((q) => /UPDATE public.mortgage_handling_requests/.test(q.sql)), false);
  }
});

test('homeowner_ssn_last_four never reaches a log line on a refused or accepted write', async () => {
  const lines = [];
  const original = { info: console.info, error: console.error, log: console.log, warn: console.warn };
  const previousEnv = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'staging'; // the only environment that logs refused writes
  for (const key of Object.keys(original)) console[key] = (...args) => lines.push(args.map(String).join(' '));
  try {
    await insert({ ...firstMortgageeBody(), homeowner_ssn_last_four: '9876' });
    await insert({ ...firstMortgageeBody(), homeowner_ssn_last_four: '98x6' });
    await insert({ ...secondMortgageeBody(OTHER_TENANT_REQUEST_ID), homeowner_ssn_last_four: '9876' });
  } finally {
    Object.assign(console, original);
    if (previousEnv === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = previousEnv;
  }
  assert.ok(lines.length >= 1, 'refused writes are logged in staging');
  for (const line of lines) {
    assert.doesNotMatch(line, /9876|98x6/);
  }
});

test('allowlist spec: the Send to Mortgage Desk columns are allowlisted and the UI still sends exactly these', () => {
  const spec = WRITE_ALLOWLIST.mortgage_handling_requests;
  for (const column of [
    'policy_number', 'loss_type', 'date_of_loss', 'homeowner_ssn_last_four',
    'endorsement_order', 'total_mortgagees', 'predecessor_request_id',
  ]) {
    assert.equal(spec.columns.has(column), true, column);
  }
  assert.equal(spec.identityColumn, 'requested_by');
  assert.equal(spec.clientIgnored.has('tenant_id'), true);
  assert.equal(spec.clientIgnored.has('claim_id'), true);

  const source = readFileSync(new URL('../../src/components/loss-draft/SendToMortgageDeskButton.tsx', import.meta.url), 'utf8');
  const insertBlock = source.slice(source.indexOf('.from("mortgage_handling_requests").insert({'));
  const keys = [...insertBlock.slice(0, insertBlock.indexOf('...orderFields')).matchAll(/^\s+([a-z_0-9]+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), Object.keys(firstMortgageeBody()).sort());
  for (const key of ['endorsement_order', 'total_mortgagees', 'predecessor_request_id']) {
    assert.match(source, new RegExp(`${key}: `));
  }
});
