// Vendor payments (owner 2026-11-13, "Start the vendor payments API and screens"; SQL 141, SQL 165).
// The API side of vendor payees and the platform-owner vendor flag:
//   - /data/rpc vendor_payee_add {tenant_id, partner_code}, vendor_payee_remove {tenant_id, vendor_tenant_id} and
//     vendor_payees_list {tenant_id} run SQL 141's / SQL 165's SECURITY DEFINER functions as the verified sign-in
//     (each checks membership), one call each, and answer the function's own result as data;
//   - tenant-billing-admin vendor-set {tenant_id, is_vendor} and vendor-status {tenant_id}: platform owner only.
// The database behaviour is proven in sql141-permanent-vendor-payees-pg.test.mjs and
// sql165-vendor-payee-lookup-and-payroll-vendor-pg.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import {
  SAFE_WRITE_RPC_CLASSIFICATION,
  SAFE_WRITE_RPCS,
  VENDOR_PAYEE_ADD_SQL,
  VENDOR_PAYEE_REMOVE_SQL,
  VENDOR_PAYEES_LIST_SQL,
  handleSafeWriteRpc,
  vendorPayeeListRow,
} from '../functions/api/workflow-rpc.mjs';
import {
  SET_TENANT_VENDOR_SQL,
  TENANT_VENDOR_STATUS_SQL,
  handleTenantBillingAdmin,
} from '../functions/api/tenant-billing-handlers.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT = '11111111-1111-4111-8111-111111111111';
const VENDOR = '16500000-0000-4000-8000-000000000001';
const VENDOR_OFF = '16500000-0000-4000-8000-000000000002';
const VENDOR_SQL = [VENDOR_PAYEE_ADD_SQL, VENDOR_PAYEE_REMOVE_SQL, VENDOR_PAYEES_LIST_SQL];

const jwtEvent = (body) => ({
  rawPath: '/data/rpc',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/rpc' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@example.com', token_use: 'id' } } },
  },
});

const mockClient = (answers = {}) => {
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
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@example.com', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: [] };
      if (Object.hasOwn(answers, sql)) return { rows: [{ result: answers[sql] }] };
      throw new Error(`unexpected SQL in test: ${sql}`);
    },
  };
};

const depsFor = (client) => ({
  forceEnabled: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops',
  }),
  createClient: () => client,
});
const rpc = (client, name, args) => handleSafeWriteRpc(jwtEvent({ name, args }), depsFor(client));
const calls = (client, sql) => client.queries.filter((q) => q.sql === sql);
const gucBefore = (client, sql) => {
  const guc = client.queries.findIndex((q) => q.sql.startsWith('SELECT set_config') && q.params?.[1] === APP_ID);
  return guc >= 0 && guc < client.queries.findIndex((q) => q.sql === sql);
};

test('the three vendor payee RPCs are safe write RPCs that call only SQL 141\'s and SQL 165\'s DEFINER functions', () => {
  for (const name of ['vendor_payee_add', 'vendor_payee_remove', 'vendor_payees_list']) {
    assert.equal(SAFE_WRITE_RPCS.has(name), true, name);
    assert.equal(SAFE_WRITE_RPC_CLASSIFICATION[name], 'safe_now', name);
  }
  assert.equal(VENDOR_PAYEE_ADD_SQL, 'SELECT public.aws_vendor_payee_add($1::uuid, $2::text) AS result');
  assert.equal(VENDOR_PAYEE_REMOVE_SQL, 'SELECT public.aws_vendor_payee_remove($1::uuid, $2::uuid) AS result');
  assert.equal(VENDOR_PAYEES_LIST_SQL, 'SELECT public.aws_vendor_payees_for_tenant($1::uuid) AS result');
});

test('vendor_payee_add: one DEFINER call as the verified sign-in with the screen\'s argument names; the answer as data', async () => {
  const added = { ok: true, replayed: false, link_id: 'f1000000-0000-4000-8000-000000000001', vendor_tenant_id: VENDOR, vendor_name: 'Acme Supply' };
  const client = mockClient({ [VENDOR_PAYEE_ADD_SQL]: added });
  const result = await rpc(client, 'vendor_payee_add', { tenant_id: TENANT, partner_code: 'VEND165' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.data, added);
  assert.deepEqual(calls(client, VENDOR_PAYEE_ADD_SQL).map((q) => q.params), [[TENANT, 'VEND165']]);
  assert.ok(gucBefore(client, VENDOR_PAYEE_ADD_SQL));
  assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), true);
  // No direct table write from the API.
  assert.equal(client.queries.some((q) => /\b(INSERT|UPDATE|DELETE)\b/i.test(q.sql) && /tenant_vendor_payees|vendor_tenants/.test(q.sql)), false);
  // The p_ / _ spellings are accepted too.
  const alt = mockClient({ [VENDOR_PAYEE_ADD_SQL]: added });
  assert.equal((await rpc(alt, 'vendor_payee_add', { p_tenant_id: TENANT, p_partner_code: 'VEND165' })).ok, true);
  assert.deepEqual(calls(alt, VENDOR_PAYEE_ADD_SQL)[0].params, [TENANT, 'VEND165']);
});

test('vendor_payee_add / remove: SQL 141\'s refusals come back as data with their code; malformed input is refused before any SQL', async () => {
  for (const error of ['forbidden', 'invalid_code', 'vendor_not_found', 'own_code', 'vendor_inactive']) {
    const client = mockClient({ [VENDOR_PAYEE_ADD_SQL]: { ok: false, error } });
    const result = await rpc(client, 'vendor_payee_add', { tenant_id: TENANT, partner_code: 'X1X' });
    assert.equal(result.ok, true, error);
    assert.deepEqual(result.data, { ok: false, error });
  }
  for (const error of ['forbidden', 'invalid_vendor', 'not_found']) {
    const client = mockClient({ [VENDOR_PAYEE_REMOVE_SQL]: { ok: false, error } });
    const result = await rpc(client, 'vendor_payee_remove', { tenant_id: TENANT, vendor_tenant_id: VENDOR });
    assert.deepEqual(result.data, { ok: false, error });
  }
  const removed = mockClient({ [VENDOR_PAYEE_REMOVE_SQL]: { ok: true, vendor_tenant_id: VENDOR } });
  const ok = await rpc(removed, 'vendor_payee_remove', { tenant_id: TENANT, vendor_tenant_id: VENDOR });
  assert.deepEqual(ok.data, { ok: true, vendor_tenant_id: VENDOR });
  assert.deepEqual(calls(removed, VENDOR_PAYEE_REMOVE_SQL).map((q) => q.params), [[TENANT, VENDOR]]);
  for (const [name, args, field] of [
    ['vendor_payee_add', { tenant_id: 'nope', partner_code: 'VEND165' }, 'tenant_id'],
    ['vendor_payee_add', { tenant_id: TENANT, partner_code: '  ' }, 'partner_code'],
    ['vendor_payee_add', { tenant_id: TENANT }, 'partner_code'],
    ['vendor_payee_remove', { tenant_id: TENANT, vendor_tenant_id: 'nope' }, 'vendor_tenant_id'],
    ['vendor_payee_remove', { vendor_tenant_id: VENDOR }, 'tenant_id'],
    ['vendor_payees_list', {}, 'tenant_id'],
  ]) {
    const client = mockClient();
    const result = await rpc(client, name, args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.statusCode, 400);
    assert.equal(result.field, field);
    assert.equal(client.queries.some((q) => VENDOR_SQL.includes(q.sql)), false);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  }
});

test('vendor_payees_list: SQL 165\'s rows with the screen\'s created_at and vendor_active (payable); forbidden as data', async () => {
  const rows = [
    { link_id: 'l1', vendor_tenant_id: VENDOR, vendor_name: 'Acme Supply', partner_code_used: 'VEND165', added_at: '2026-11-13T10:00:00Z', is_vendor: true, subscription_status: 'active', payable: true },
    { link_id: 'l2', vendor_tenant_id: VENDOR_OFF, vendor_name: 'Bolt Hardware', partner_code_used: 'BOLT165', added_at: '2026-11-13T11:00:00Z', is_vendor: false, subscription_status: 'active', payable: false },
  ];
  const client = mockClient({ [VENDOR_PAYEES_LIST_SQL]: { ok: true, tenant_id: TENANT, payees: rows } });
  const result = await rpc(client, 'vendor_payees_list', { tenant_id: TENANT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data, {
    ok: true,
    tenant_id: TENANT,
    payees: [
      { ...rows[0], created_at: '2026-11-13T10:00:00Z', vendor_active: true },
      { ...rows[1], created_at: '2026-11-13T11:00:00Z', vendor_active: false },
    ],
  });
  assert.deepEqual(calls(client, VENDOR_PAYEES_LIST_SQL).map((q) => q.params), [[TENANT]]);
  assert.ok(gucBefore(client, VENDOR_PAYEES_LIST_SQL));
  // A lapsed organization that is still a vendor is not payable either.
  assert.equal(vendorPayeeListRow({ is_vendor: true, subscription_status: 'past_due', payable: false }).vendor_active, false);
  const forbidden = mockClient({ [VENDOR_PAYEES_LIST_SQL]: { ok: false, error: 'forbidden' } });
  assert.deepEqual((await rpc(forbidden, 'vendor_payees_list', { tenant_id: TENANT })).data, { ok: false, error: 'forbidden' });
});

// tenant-billing-admin: vendor-set / vendor-status.
const adminClient = ({ owner = true, setResult = { ok: true, tenant_id: TENANT, is_vendor: true }, isVendor = false } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/is_platform_owner\(\)/.test(text)) return { rows: [{ ok: owner }] };
      if (text === SET_TENANT_VENDOR_SQL) return { rows: [{ result: setResult }] };
      if (text === TENANT_VENDOR_STATUS_SQL) return { rows: [{ is_vendor: isVendor }] };
      return { rows: [] };
    },
  };
};
const admin = (client, body) => handleTenantBillingAdmin({ body: JSON.stringify(body) }, { client, mapping: { application_user_id: APP_ID } });

test('vendor-set: platform owner only; SQL 141\'s function with the tenant and the flag; refusals readable', async () => {
  assert.equal(SET_TENANT_VENDOR_SQL, 'SELECT public.aws_platform_owner_set_tenant_vendor($1::uuid, $2::boolean) AS result');
  const on = adminClient();
  const saved = await admin(on, { action: 'vendor-set', tenant_id: TENANT, is_vendor: true });
  assert.deepEqual(saved, { ok: true, statusCode: 200, spoofFieldsIgnored: saved.spoofFieldsIgnored, saved: true, tenant_id: TENANT, is_vendor: true });
  assert.deepEqual(on.queries.filter((q) => q.sql === SET_TENANT_VENDOR_SQL).map((q) => q.params), [[TENANT, true]]);
  const off = adminClient({ setResult: { ok: true, tenant_id: TENANT, is_vendor: false } });
  assert.equal((await admin(off, { action: 'vendor-set', tenant_id: TENANT, is_vendor: false })).is_vendor, false);
  assert.deepEqual(off.queries.find((q) => q.sql === SET_TENANT_VENDOR_SQL).params, [TENANT, false]);

  const notOwner = adminClient({ owner: false });
  const refused = await admin(notOwner, { action: 'vendor-set', tenant_id: TENANT, is_vendor: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'platform_owner_required');
  assert.equal(notOwner.queries.some((q) => q.sql === SET_TENANT_VENDOR_SQL), false);

  for (const body of [{ action: 'vendor-set', tenant_id: TENANT }, { action: 'vendor-set', tenant_id: TENANT, is_vendor: 'yes' }]) {
    const client = adminClient();
    const r = await admin(client, body);
    assert.deepEqual([r.ok, r.statusCode, r.error, r.field], [false, 400, 'invalid_field', 'is_vendor']);
    assert.equal(client.queries.some((q) => q.sql === SET_TENANT_VENDOR_SQL), false);
  }
  const badTenant = await admin(adminClient(), { action: 'vendor-set', tenant_id: 'nope', is_vendor: true });
  assert.deepEqual([badTenant.statusCode, badTenant.error], [400, 'invalid_uuid']);
  for (const [error, statusCode] of [['forbidden', 403], ['invalid_input', 400], ['tenant_not_found', 404]]) {
    const r = await admin(adminClient({ setResult: { ok: false, error } }), { action: 'vendor-set', tenant_id: TENANT, is_vendor: true });
    assert.deepEqual([r.ok, r.statusCode, r.error], [false, statusCode, error]);
    assert.ok(r.message);
  }
});

test('vendor-status: platform owner only; whether the company is a vendor', async () => {
  assert.equal(TENANT_VENDOR_STATUS_SQL, 'SELECT EXISTS (SELECT 1 FROM public.vendor_tenants WHERE tenant_id = $1::uuid) AS is_vendor');
  for (const isVendor of [true, false]) {
    const client = adminClient({ isVendor });
    const r = await admin(client, { action: 'vendor-status', tenant_id: TENANT });
    assert.deepEqual([r.ok, r.statusCode, r.tenant_id, r.is_vendor], [true, 200, TENANT, isVendor]);
    assert.deepEqual(client.queries.find((q) => q.sql === TENANT_VENDOR_STATUS_SQL).params, [TENANT]);
    assert.equal(client.queries.some((q) => q.sql === SET_TENANT_VENDOR_SQL), false);
  }
  const notOwner = adminClient({ owner: false });
  const refused = await admin(notOwner, { action: 'vendor-status', tenant_id: TENANT });
  assert.equal(refused.error, 'platform_owner_required');
  assert.equal(notOwner.queries.some((q) => q.sql === TENANT_VENDOR_STATUS_SQL), false);
});
