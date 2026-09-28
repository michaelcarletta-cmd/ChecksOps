import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoice } from '../functions/api/providers/parity/moov-onboard.mjs';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_PROD = '60922058-7eca-4889-81dd-5720d7b9de96';
const PLATFORM = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const STAGING_TENANT = 'a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074';
const STAGING_ACCOUNT = '11111111-2222-4333-8444-555555555555';

const accountRow = (tenantId, environment, providerAccountId) => ({
  tenant_id: tenantId,
  provider: 'moov',
  environment,
  provider_account_id: providerAccountId,
  onboarding_status: 'verified',
  can_receive_payments: true,
});

const fakeClient = (rows) => ({
  query: async (sql, params) => {
    const tenantId = params?.[0];
    const environment = params?.[1];
    const match = rows.find((row) => row.tenant_id === tenantId && row.environment === environment);
    return { rows: match ? [match] : [] };
  },
});

const ctxOf = (tenantId, environment) => ({
  tenantId,
  environment,
  isAdmin: false,
  moovContext: { sandboxPlatformAccountId: PLATFORM, productionPlatformAccountId: PLATFORM },
});

const lineItems = [{ name: 'INV1 fixture', unit_price: 1, quantity: 1 }];

const recordingFetch = () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method || 'GET', body: init.body || null });
    const payload = href.includes('/oauth2/token')
      ? { access_token: 'fixture-token', expires_in: 3600 }
      : { invoiceID: 'inv-fixture', status: 'draft' };
    const text = JSON.stringify(payload);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => text,
      headers: { get: () => null },
    };
  };
  return { calls, fetchImpl };
};

const sandboxMoovCtx = (fetchImpl) => ({
  environment: 'sandbox',
  sandboxPublicKey: 'pk_sandbox',
  sandboxSecretKey: 'sk_sandbox',
  sandboxOrigin: 'https://checksops.com',
  fetchImpl,
});

test('production Freedom invoice preflight uses production merchant account', async () => {
  const result = await invoice.run({
    client: fakeClient([accountRow(FREEDOM, 'production', FREEDOM_PROD)]),
    body: { action: 'preflight', tenant_id: FREEDOM },
    ctx: ctxOf(FREEDOM, 'production'),
    fetchImpl: async () => { throw new Error('preflight must not call Moov'); },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.environment, 'production');
  assert.equal(result.merchantAccountId, FREEDOM_PROD);
  assert.equal(result.liveProviderCalled, false);
  assert.notEqual(result.merchantAccountId, PLATFORM);
});

test('staging invoice preflight uses sandbox account only', async () => {
  const result = await invoice.run({
    client: fakeClient([
      accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT),
      accountRow(FREEDOM, 'production', FREEDOM_PROD),
    ]),
    body: { action: 'preflight', tenant_id: STAGING_TENANT },
    ctx: ctxOf(STAGING_TENANT, 'sandbox'),
    fetchImpl: async () => { throw new Error('preflight must not call Moov'); },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.environment, 'sandbox');
  assert.equal(result.merchantAccountId, STAGING_ACCOUNT);
  assert.notEqual(result.merchantAccountId, FREEDOM_PROD);
});

test('production request does not fall back to a sandbox row', async () => {
  const result = await invoice.run({
    client: fakeClient([accountRow(FREEDOM, 'sandbox', 'sandbox-only-account')]),
    body: { action: 'preflight', tenant_id: FREEDOM },
    ctx: ctxOf(FREEDOM, 'production'),
    fetchImpl: async () => { throw new Error('must not call Moov'); },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, 'production_provider_context_unresolved');
});

test('missing sandbox account still returns setup-required', async () => {
  const result = await invoice.run({
    client: fakeClient([]),
    body: { action: 'create', tenant_id: STAGING_TENANT, line_items: lineItems },
    ctx: ctxOf(STAGING_TENANT, 'sandbox'),
    fetchImpl: async () => { throw new Error('must not call Moov'); },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'Set up your payment account first.');
});

test('unresolved environment fails closed', async () => {
  const result = await invoice.run({
    client: fakeClient([accountRow(FREEDOM, 'production', FREEDOM_PROD)]),
    body: { action: 'preflight', tenant_id: FREEDOM },
    ctx: ctxOf(FREEDOM, ''),
    fetchImpl: async () => { throw new Error('must not call Moov'); },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, 'provider_environment_unresolved');
});

for (const action of ['create', 'create_and_send']) {
  test(`${action} posts to the tenant merchant account, not platform`, async () => {
    resetMoovTokenCache();
    const { calls, fetchImpl } = recordingFetch();
    const result = await withMoovContext(sandboxMoovCtx(fetchImpl), () => invoice.run({
      client: fakeClient([accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)]),
      body: { action, tenant_id: STAGING_TENANT, line_items: lineItems },
      ctx: ctxOf(STAGING_TENANT, 'sandbox'),
      fetchImpl,
    }));
    assert.equal(result.statusCode, 200);
    const invoicePosts = calls.filter((call) => (
      String(call.method).toUpperCase() === 'POST' && call.url.includes('/invoices')
    ));
    assert.equal(invoicePosts.length, 1);
    assert.match(invoicePosts[0].url, new RegExp(`/accounts/${STAGING_ACCOUNT}/invoices`));
    assert.doesNotMatch(invoicePosts[0].url, new RegExp(PLATFORM));
    assert.doesNotMatch(invoicePosts[0].url, new RegExp(FREEDOM_PROD));
  });
}
