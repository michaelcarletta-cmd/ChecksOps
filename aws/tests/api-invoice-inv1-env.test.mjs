import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoice } from '../functions/api/providers/parity/moov-onboard.mjs';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';
import {
  FREEDOM,
  FREEDOM_PROD,
  PLATFORM,
  STAGING_ACCOUNT,
  STAGING_TENANT,
  accountRow,
  ctxOf,
  fakeInvoiceClient,
  invoiceStore,
  recordingFetch,
  sandboxMoovCtx,
} from './invoice-test-harness.mjs';

const fakeClient = (rows) => ({
  query: async (sql, params) => {
    const tenantId = params?.[0];
    const environment = params?.[1];
    const match = rows.find((row) => row.tenant_id === tenantId && row.environment === environment);
    return { rows: match ? [match] : [] };
  },
});

const lineItems = [{ name: 'INV1 fixture', unit_price: 1, quantity: 1 }];

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
    const store = invoiceStore({ accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)] });
    const result = await withMoovContext(sandboxMoovCtx(fetchImpl), () => invoice.run({
      client: fakeInvoiceClient(store),
      body: {
        action,
        tenant_id: STAGING_TENANT,
        customer_name: 'INV1 Fixture Co',
        customer_email: 'inv1@example.test',
        customer_type: 'business',
        line_items: lineItems,
      },
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
    assert.equal(invoicePosts[0].body.customerAccountID, 'cust-1');
    assert.equal(invoicePosts[0].body.customer, undefined);
  });
}
