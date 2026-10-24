import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { SECRET_COLUMNS, secretColumnsForTable, stripSecretColumns } from '../functions/api/secret-columns.mjs';
import { executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';
import { handleWrite } from '../functions/api/write.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

// The tables whose write routes return `RETURNING *` rows to the writer (PR #1213 review).
const WRITE_ECHO_TABLES = [
  'profiles', 'tenants', 'mortgage_companies', 'claims', 'user_sessions',
  'signature_signers', 'homeowner_intro_requests', 'check_payees', 'check_endorsements',
  'company_branding',
];

test('SECRET_COLUMNS is the PR #1213 data.mjs map, frozen', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SECRET_COLUMNS)), {
    check_endorsements: ['token'],
    check_payees: ['endorsement_token'],
    check_payment_directions: ['secure_token'],
    checkalt_config: ['webhook_secret'],
    claims: ['mortgage_portal_password'],
    company_branding: ['signnow_make_webhook_url'],
    email_unsubscribe_tokens: ['token'],
    external_payment_recipients: ['secure_token'],
    homeowner_bank_link_tokens: ['token'],
    homeowner_intro_requests: ['access_token'],
    mortgage_companies: ['portal_password'],
    profiles: ['jobnimbus_api_key'],
    signature_signers: ['token_hash'],
    stakeholder_accounts: ['plaid_access_token', 'verification_token'],
    tenant_billing_accounts: ['account_number_encrypted'],
    tenant_openai_credentials: ['encrypted_key'],
    tenants: ['actum_password', 'actum_test_password', 'actum_webhook_secret', 'ein'],
    user_sessions: ['session_token'],
  });
  assert.ok(Object.isFrozen(SECRET_COLUMNS));
  for (const columns of Object.values(SECRET_COLUMNS)) assert.ok(Object.isFrozen(columns));
  // Columns a screen shows on purpose stay readable.
  assert.ok(!secretColumnsForTable('signature_signers').includes('access_token'));
});

test('stripSecretColumns removes exactly the table secret columns, with and without them present', () => {
  for (const [table, secret] of Object.entries(SECRET_COLUMNS)) {
    const withSecret = { id: ID, name: 'kept' };
    for (const column of secret) withSecret[column] = `secret-${column}`;
    const before = structuredClone(withSecret);
    const stripped = stripSecretColumns(table, withSecret);
    assert.deepEqual(stripped, { id: ID, name: 'kept' }, table);
    assert.deepEqual(withSecret, before, `${table}: input is not mutated`);
    // Array form and the public.-qualified name.
    assert.deepEqual(stripSecretColumns(`public.${table}`, [withSecret, withSecret]), [{ id: ID, name: 'kept' }, { id: ID, name: 'kept' }], table);
    // A row without secret columns comes back as the same object.
    const clean = { id: ID, name: 'kept' };
    assert.equal(stripSecretColumns(table, clean), clean, table);
    assert.equal(stripSecretColumns(table, [clean])[0], clean, table);
  }
  // A table without secret columns: the input is returned as given, even a same-named column.
  const rows = [{ id: ID, token: 'not-a-secret-here' }];
  assert.equal(stripSecretColumns('check_message_reads', rows), rows);
  assert.equal(stripSecretColumns('', rows), rows);
  // Non-row values pass through.
  assert.equal(stripSecretColumns('profiles', null), null);
  assert.equal(stripSecretColumns('profiles', undefined), undefined);
  assert.deepEqual(stripSecretColumns('profiles', [null, 1]), [null, 1]);
});

const jwtEvent = (body) => ({
  rawPath: '/data/write',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/write' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

// Every lookup answers with a row that satisfies the writers' preconditions (member, platform owner,
// draft request, tenant-assigned claim); the write statement on `table` answers with that table's
// row, including its secret columns when `withSecrets`.
const BASE_ROW = {
  id: ID,
  tenant_id: TENANT,
  org_id: TENANT,
  user_id: APP_ID,
  check_id: ID,
  claim_id: ID,
  check_intake_item_id: ID,
  payee_id: ID,
  signature_request_id: ID,
  contractor_profile_id: ID,
  contractor_user_id: APP_ID,
  role: 'owner',
  status: 'draft',
  claim_number: 'old',
  ok: true,
  is_owner: true,
};
const echoRow = (table, withSecrets) => {
  const row = { ...BASE_ROW, name: 'kept' };
  if (withSecrets) for (const column of SECRET_COLUMNS[table]) row[column] = `secret-${column}`;
  return row;
};
const writeSql = (table) => new RegExp(`(?:INSERT INTO|UPDATE|DELETE FROM) public\\.${table}\\b[\\s\\S]*RETURNING`);

const mockClient = (table, { withSecrets = true } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', status: 'active' }] };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK|SET )/.test(text)) return { rows: [] };
      if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params?.[1] || '1' }] };
      if (writeSql(table).test(text)) return { rows: [echoRow(table, withSecrets)] };
      return { rows: [{ ...BASE_ROW }] };
    },
  };
};

const depsFor = (client) => ({
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

// One request per write op each table allows, through the same routes the SPA uses.
const CASES = [
  ['profiles', { op: 'update', values: { full_name: 'X' }, filters: [{ column: 'id', value: APP_ID }] }],
  ['tenants', { op: 'update', values: { name: 'X' }, filters: [{ column: 'id', value: TENANT }] }],
  ['tenants', { op: 'insert', values: { name: 'X', slug: 'x' } }],
  ['mortgage_companies', { op: 'update', values: { name: 'X' }, filters: [{ column: 'id', value: ID }] }],
  ['mortgage_companies', { op: 'insert', values: { name: 'X' } }],
  ['claims', { op: 'update', values: { claim_number: '123' }, filters: [{ column: 'id', value: ID }] }],
  ['user_sessions', { op: 'insert', values: { session_token: 'client-minted-token', device_info: 'd' } }],
  ['user_sessions', { op: 'update', values: { is_active: false }, filters: [{ column: 'id', value: ID }] }],
  ['signature_signers', { op: 'insert', values: { signature_request_id: ID, signer_name: 'Ann', signer_email: 'ann@example.com' } }],
  ['homeowner_intro_requests', { op: 'insert', values: { contractor_profile_id: ID, homeowner_name: 'Ann', homeowner_email: 'ann@example.com' } }],
  ['homeowner_intro_requests', { op: 'update', values: { status: 'contacted' }, filters: [{ column: 'id', value: ID }] }],
  ['check_payees', { op: 'insert', values: { check_id: ID, payee_name: 'X' } }],
  ['check_payees', { op: 'update', values: { payee_name: 'X' }, filters: [{ column: 'id', value: ID }] }],
  ['check_payees', { op: 'delete', filters: [{ column: 'id', value: ID }] }],
  ['check_endorsements', { op: 'update', values: { notes: 'X' }, filters: [{ column: 'id', value: ID }] }],
  ['check_endorsements', { op: 'delete', filters: [{ column: 'id', value: ID }] }],
  ['company_branding', { op: 'update', values: { company_name: 'X' }, filters: [{ column: 'id', value: ID }] }],
  ['company_branding', { op: 'insert', values: { company_name: 'X' } }],
];

test('every write-echo table is exercised', () => {
  assert.deepEqual([...new Set(CASES.map(([table]) => table))].sort(), [...WRITE_ECHO_TABLES].sort());
});

for (const [table, body] of CASES) {
  test(`POST /data/write ${table} ${body.op}: the echo drops the secret columns, keeps the rest`, async () => {
    const client = mockClient(table);
    const result = await handleWrite(jwtEvent({ table, ...body }), depsFor(client));
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.ok(client.queries.some((q) => writeSql(table).test(q.sql)), 'the write statement ran');
    assert.equal(result.count, 1);
    const expected = echoRow(table, false);
    assert.deepEqual(result.data, [expected]);
    for (const column of SECRET_COLUMNS[table]) assert.equal(column in result.data[0], false, column);
    assert.doesNotMatch(JSON.stringify(result), /secret-/);
  });

  test(`POST /data/write ${table} ${body.op}: an echo without secret columns is unchanged`, async () => {
    const client = mockClient(table, { withSecrets: false });
    const result = await handleWrite(jwtEvent({ table, ...body }), depsFor(client));
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.deepEqual(result.data, [echoRow(table, false)]);
  });
}

test('single: true returns the stripped row object', async () => {
  const client = mockClient('profiles');
  const result = await handleWrite(jwtEvent({
    table: 'profiles', op: 'update', single: true, values: { full_name: 'X' }, filters: [{ column: 'id', value: APP_ID }],
  }), depsFor(client));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.data, echoRow('profiles', false));
});

test('only the echo changes: the user_sessions insert still writes the client session token', async () => {
  const client = mockClient('user_sessions');
  const result = await handleWrite(jwtEvent({
    table: 'user_sessions', op: 'insert', values: { session_token: 'client-minted-token', device_info: 'd' },
  }), depsFor(client));
  assert.equal(result.statusCode, 200);
  const insert = client.queries.find((q) => writeSql('user_sessions').test(q.sql));
  assert.ok(insert.params.includes('client-minted-token'));
  assert.equal('session_token' in result.data[0], false);
});

test('a table without secret columns keeps a same-named column in its echo', async () => {
  const client = {
    queries: [],
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      const text = String(sql);
      if (text === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'x@example.com', status: 'active' }] };
      }
      if (/RETURNING/.test(text)) return { rows: [{ user_id: APP_ID, check_id: ID, token: 'kept' }] };
      if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params?.[1] || '1' }] };
      return { rows: [] };
    },
  };
  const result = await handleWrite(jwtEvent({ table: 'check_message_reads', op: 'upsert', values: { check_id: ID } }), depsFor(client));
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.deepEqual(result.data, [{ user_id: APP_ID, check_id: ID, token: 'kept' }]);
});

test('executeAppMetadataWrite strips its own echo (also reached from write-check-workflow.mjs)', async () => {
  for (const table of ['profiles', 'tenants', 'mortgage_companies', 'claims', 'company_branding']) {
    const [, body] = CASES.find(([name]) => name === table);
    const client = mockClient(table);
    const result = await executeAppMetadataWrite({
      client,
      mapping: { application_user_id: APP_ID },
      table,
      op: body.op,
      values: body.values,
      filters: body.filters || [],
    });
    assert.deepEqual(result.rows, [echoRow(table, false)], table);
  }
  // Errors pass through untouched.
  const refused = await executeAppMetadataWrite({ client: mockClient('profiles'), mapping: {}, table: 'nope', op: 'update', values: {}, filters: [] });
  assert.deepEqual(refused, { error: 'table_not_allowlisted', table: 'nope' });
});
