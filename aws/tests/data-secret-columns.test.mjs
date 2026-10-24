import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SECRET_COLUMNS,
  denySecretColumnQuery,
  handleDataQuery,
  relatedFk,
  secretColumnsFor,
  stripSecretColumns,
} from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const PARENT = 'audit_logs';

// The review (2026-10-24): every BLOCK column, by table.
const EXPECTED_BLOCK = {
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
};

// KEEP-READABLE columns a screen shows on purpose, and the non-secret metadata next to secrets.
const KEEP = {
  signature_signers: ['access_token', 'expires_at'],
  homeowner_ledger_tokens: ['token'],
  moov_invoices: ['public_token'],
  external_payment_recipients: ['token_expires_at', 'token_used_at'],
  check_payees: ['endorsement_token_expires_at'],
  check_endorsements: ['token_expires_at'],
  stakeholder_accounts: ['verification_token_expires_at', 'homeowner_link_token_id'],
  checkalt_config: ['fi_key'],
  tenants: ['partner_code', 'referral_code'],
  tenant_billing_accounts: ['account_number_last4', 'routing_number'],
  check_intake_items: ['routing_number', 'account_number'],
};

const secretValue = (table, column) => `SECRET-${table}-${column}-0123456789abcdef`;

const fullRow = (table, id = CHILD_ID) => {
  const row = { id, name: `row of ${table}`, tenant_id: TENANT_A };
  for (const column of SECRET_COLUMNS[table] || []) row[column] = secretValue(table, column);
  for (const column of KEEP[table] || []) row[column] = `keep-${table}-${column}`;
  return row;
};

const jwtEvent = (body) => ({
  rawPath: '/data/query',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/query' },
    requestId: 'req-secret-columns-test',
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const mockClient = ({ parentRow = null } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === COGNITO_SUB ? [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', status: 'active' }] : [] };
      }
      if (/is_platform_owner\(\)/.test(sql)) return { rows: [{ is_owner: true, is_master: true }] };
      const match = sql.match(/FROM public\.([a-z_]+)/);
      if (!match) return { rows: [] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: 1 }] };
      if (match[1] === PARENT && parentRow) return { rows: [parentRow] };
      const table = match[1] === 'checkalt_config_public' ? 'checkalt_config' : match[1];
      return { rows: [fullRow(table)] };
    },
    end: async () => {},
  };
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
  forceEnabled: true,
});

const query = async (body, client = mockClient()) => ({ result: await handleDataQuery(jwtEvent({ op: 'select', ...body }), depsFor(client)), client });

const selectsOf = (client) => client.queries.filter((q) => /^SELECT .* FROM public\./.test(q.sql));

const assertDenied = (result, client, label) => {
  assert.equal(result.statusCode, 403, label);
  assert.equal(result.error, 'secret_column_denied', label);
  assert.equal(result.ok, false, label);
  assert.deepEqual(selectsOf(client), [], `${label}: no table read`);
  assert.equal(JSON.stringify(result).includes('SECRET-'), false, label);
};

const BLOCKED = Object.entries(EXPECTED_BLOCK).flatMap(([table, columns]) => columns.map((column) => [table, column]));

test('secret columns: the BLOCK list is the review, every table is allowlisted, KEEP columns are not on it', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SECRET_COLUMNS).map(([table, columns]) => [table, [...columns]])),
    EXPECTED_BLOCK,
  );
  assert.ok(Object.isFrozen(SECRET_COLUMNS));
  const allowed = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/functions/api/allowed-tables.json'), 'utf8')));
  for (const table of Object.keys(SECRET_COLUMNS)) assert.ok(allowed.has(table), table);
  for (const [table, columns] of Object.entries(KEEP)) {
    for (const column of columns) assert.equal(secretColumnsFor(table).has(column), false, `${table}.${column}`);
  }
  // Table-scoped: `token` is secret on check_endorsements, readable on homeowner_ledger_tokens.
  assert.equal(secretColumnsFor('check_endorsements').has('token'), true);
  assert.equal(secretColumnsFor('homeowner_ledger_tokens').has('token'), false);
  assert.equal(secretColumnsFor('public.user_sessions').has('session_token'), true);
});

for (const [table, column] of BLOCKED) {
  test(`secret column ${table}.${column}: explicit select, embedded select, filters and order are refused`, async () => {
    for (const select of [`id, ${column}`, column, `${column}, id`]) {
      const { result, client } = await query({ table, select });
      assertDenied(result, client, `select ${select}`);
    }
    for (const select of [`id, ${table}(${column})`, `id, ${table}(id, ${column})`, `id, rel:${table}(${column})`, `id, ${table}!inner(${column})`, `*, check_payees(id, ${table}(${column}))`]) {
      const { result, client } = await query({ table: PARENT, select });
      assertDenied(result, client, `embed ${select}`);
    }
    const filters = [
      [{ column, op: 'eq', value: secretValue(table, column) }],
      [{ column, op: 'in', value: [secretValue(table, column)] }],
      [{ column, op: 'like', value: 'SECRET%' }],
      [{ column, op: 'ilike', value: 'secret%' }],
      [{ column, op: 'gt', value: 'A' }],
      [{ column, op: 'is', value: null }],
      [{ column, op: 'not', notOp: 'is', value: null }],
      [{ col: column, op: 'eq', value: 'x' }],
      [{ op: 'or', value: `id.eq.${CHILD_ID},${column}.eq.${secretValue(table, column)}` }],
      [{ op: 'or', value: `and(id.eq.${CHILD_ID},${column}.like.SECRET*)` }],
    ];
    for (const f of filters) {
      const { result, client } = await query({ table, select: 'id', filters: f });
      assertDenied(result, client, `filter ${JSON.stringify(f)}`);
      const head = await query({ table, select: 'id', filters: f, head: true, count: 'exact' });
      assertDenied(head.result, head.client, `head count ${JSON.stringify(f)}`);
    }
    const embedded = await query({ table: PARENT, select: `id, ${table}(id)`, filters: [{ column: `${table}.${column}`, op: 'eq', value: 'x' }] });
    assertDenied(embedded.result, embedded.client, 'embedded filter');
    const ordered = await query({ table, select: 'id', order: { column, ascending: true } });
    assertDenied(ordered.result, ordered.client, 'order');
  });

  test(`secret column ${table}.${column}: a * select still answers, without the column`, async () => {
    const { result } = await query({ table, select: '*' });
    assert.equal(result.statusCode, 200, `* of ${table}`);
    assert.equal(result.ok, true);
    const row = result.data[0];
    assert.equal(Object.prototype.hasOwnProperty.call(row, column), false, `${table}.${column} stripped`);
    assert.equal(row.id, CHILD_ID);
    assert.equal(row.name, `row of ${table}`);
    for (const keep of KEEP[table] || []) assert.equal(row[keep], `keep-${table}-${keep}`, `${table}.${keep} kept`);
    assert.equal(JSON.stringify(result).includes('SECRET-'), false);

    const omitted = await query({ table });
    assert.equal(omitted.result.statusCode, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(omitted.result.data[0], column), false, 'select omitted means *');
  });

  test(`secret column ${table}.${column}: an embedded (*) still answers, without the column`, async () => {
    const fk = relatedFk(PARENT, table);
    const client = mockClient({ parentRow: { id: PARENT_ID, [fk]: CHILD_ID, action: 'viewed' } });
    const { result } = await query({ table: PARENT, select: `*, ${table}(*)` }, client);
    assert.equal(result.statusCode, 200, `${table}(*)`);
    const embedded = result.data[0][table];
    assert.ok(embedded && typeof embedded === 'object', `${table} embedded`);
    const rows = Array.isArray(embedded) ? embedded : [embedded];
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, column), false, `${table}.${column} stripped in embed`);
      assert.equal(row.name, `row of ${table}`);
      for (const keep of KEEP[table] || []) assert.equal(row[keep], `keep-${table}-${keep}`, `${table}.${keep} kept in embed`);
    }
    assert.equal(JSON.stringify(result).includes('SECRET-'), false);
  });
}

test('secret columns: KEEP columns stay selectable, filterable and orderable', async () => {
  const ledger = await query({ table: 'homeowner_ledger_tokens', select: 'id, token', filters: [{ column: 'token', op: 'eq', value: 'keep-homeowner_ledger_tokens-token' }], order: { column: 'token' } });
  assert.equal(ledger.result.statusCode, 200);
  assert.equal(ledger.result.data[0].token, 'keep-homeowner_ledger_tokens-token');

  const invoices = await query({ table: 'moov_invoices', select: '*' });
  assert.equal(invoices.result.statusCode, 200);
  assert.equal(invoices.result.data[0].public_token, 'keep-moov_invoices-public_token');

  const signers = await query({ table: 'signature_signers', select: 'id, access_token, expires_at' });
  assert.equal(signers.result.statusCode, 200);
  assert.equal(signers.result.data[0].access_token, 'keep-signature_signers-access_token');

  // The SignatureDiagnostics / SharedCheckPaymentDirection shape: signature_requests(*, signature_signers(*)).
  const fk = relatedFk(PARENT, 'signature_signers');
  const embedClient = mockClient({ parentRow: { id: PARENT_ID, [fk]: CHILD_ID } });
  const embed = await query({ table: PARENT, select: '*, signature_signers(*)' }, embedClient);
  assert.equal(embed.result.statusCode, 200);
  const signer = [].concat(embed.result.data[0].signature_signers)[0];
  assert.equal(signer.access_token, 'keep-signature_signers-access_token');
  assert.equal('token_hash' in signer, false);

  const payee = await query({ table: 'external_payment_recipients', select: 'id, token_expires_at, token_used_at', filters: [{ column: 'token_expires_at', op: 'gt', value: '2026-01-01' }] });
  assert.equal(payee.result.statusCode, 200);
  assert.equal(payee.result.data[0].token_expires_at, 'keep-external_payment_recipients-token_expires_at');

  const micr = await query({ table: 'check_intake_items', select: 'id, routing_number, account_number' });
  assert.equal(micr.result.statusCode, 200);
  assert.equal(micr.result.data[0].routing_number, 'keep-check_intake_items-routing_number');

  // A column named like a secret elsewhere is not refused on a table that does not hold it as a secret.
  const other = await query({ table: 'homeowner_ledger_tokens', select: 'id', filters: [{ op: 'or', value: 'token.eq.abc,id.eq.x' }] });
  assert.equal(other.result.statusCode, 200);
  // A filter value that merely looks like an or-term is data, not a column reference.
  const value = await query({ table: 'external_payment_recipients', select: 'id', filters: [{ column: 'display_name', op: 'eq', value: 'secure_token.eq.x' }] });
  assert.equal(value.result.statusCode, 200);
});

test('secret columns: an embedded tenants(...) list of public columns still uses tenants_public; tenants(ein) is refused', async () => {
  const fk = relatedFk(PARENT, 'tenants');
  const client = mockClient({ parentRow: { id: PARENT_ID, [fk]: CHILD_ID } });
  const ok = await query({ table: PARENT, select: 'id, tenants(id, name, partner_code)' }, client);
  assert.equal(ok.result.statusCode, 200);
  assert.ok(client.queries.some((q) => /FROM public\.tenants_public/.test(q.sql)));
  const denied = await query({ table: PARENT, select: 'id, tenants(id, name, ein)' });
  assertDenied(denied.result, denied.client, 'tenants(ein)');
});

test('secret columns: checkalt_config is read through checkalt_config_public; naming webhook_secret is refused before the read', async () => {
  const ok = await query({ table: 'checkalt_config', select: 'id, fi_key' });
  assert.equal(ok.result.statusCode, 200);
  assert.ok(ok.client.queries.some((q) => /FROM public\.checkalt_config_public/.test(q.sql)));
  const denied = await query({ table: 'checkalt_config', select: 'id, webhook_secret' });
  assertDenied(denied.result, denied.client, 'checkalt_config.webhook_secret');
});

test('secret columns: the tax refusal still answers first for tax columns', async () => {
  const { result } = await query({ table: 'profiles', select: 'id, tin, jobnimbus_api_key' });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'tax_secret_denied');
});

test('secret columns: pure helpers', () => {
  assert.equal(denySecretColumnQuery('profiles', { columns: ['*'], embeds: [] }, [], null).denied, false);
  assert.equal(denySecretColumnQuery('profiles', { columns: ['id', 'jobnimbus_api_key'], embeds: [] }).denied, true);
  assert.equal(denySecretColumnQuery('public.profiles', { columns: ['jobnimbus_api_key'], embeds: [] }).denied, true);
  assert.equal(denySecretColumnQuery('profiles', { columns: ['id'], embeds: [] }, [], { column: 'jobnimbus_api_key' }).denied, true);
  assert.equal(denySecretColumnQuery('profiles', { columns: ['id'], embeds: [] }, [{ column: 'full_name', op: 'eq', value: 'x' }]).denied, false);
  const rows = [{ id: 1, jobnimbus_api_key: 'k', full_name: 'A' }, { id: 2, full_name: 'B' }, null];
  const stripped = stripSecretColumns(rows, 'profiles');
  assert.deepEqual(stripped, [{ id: 1, full_name: 'A' }, { id: 2, full_name: 'B' }, null]);
  assert.equal(rows[0].jobnimbus_api_key, 'k', 'input rows are not mutated');
  assert.equal(stripSecretColumns(rows, 'homeowner_ledger_tokens'), rows, 'no secret columns: same array');
});
