/**
 * Reconcile of staging live-only features into main (owner decisions 2026-10-18):
 * - public-invoice answers before any identity check (token-only lookup);
 * - publicInvoice accepts only a UUID v4 token, exact match on moov_invoices;
 * - moov-invoice delegates to invoice-actions.mjs runInvoiceAction (provider lifecycle);
 * - Platform Finance read views (status / overview / wallet / pnl), platform owner only,
 *   every write refused.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runParityHandler } from '../functions/api/providers/parity/dispatch.mjs';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';
import {
  invoice,
  platformBank,
  platformTreasury,
  publicInvoice,
} from '../functions/api/providers/parity/moov-onboard.mjs';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const MERCHANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLATFORM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVOICE_ROW = '55555555-5555-4555-8555-555555555555';
const TOKEN = '9b2f3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d';

const fakeClient = (route = () => null) => {
  const calls = [];
  return {
    calls,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      const hit = route(text, params);
      return hit || { rows: [] };
    },
  };
};

const recordedFetch = (routes = []) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    const hit = routes.find((r) => String(url).includes(r.match) && (!r.method || (init.method || 'GET') === r.method));
    const payload = hit ? hit.body : [];
    const status = hit?.status || 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
};

const TOKEN_ROUTE = { match: '/oauth2/token', method: 'POST', body: { access_token: 'tok', expires_in: 300 } };

const sandboxMoov = (fetchImpl) => ({
  environment: 'sandbox',
  sandboxPublicKey: 'pk_sandbox',
  sandboxSecretKey: 'sk_sandbox',
  sandboxPlatformAccountId: PLATFORM_ID,
  sandboxOrigin: 'https://checksops.com',
  apiVersion: 'v2024.01.00',
  productionPublicKey: null,
  productionSecretKey: null,
  productionPlatformAccountId: null,
  fetchImpl,
});

const runInMoov = (handler, { client, body, ctx = {}, fetchImpl }) => {
  resetMoovTokenCache();
  const moovContext = sandboxMoov(fetchImpl);
  return withMoovContext(moovContext, () => handler.run({
    client,
    body,
    fetchImpl,
    ctx: { environment: 'sandbox', tenantId: TENANT, userId: USER, moovContext, ...ctx },
  }));
};

const invoiceRow = (extra = {}) => ({
  id: INVOICE_ROW,
  public_token: TOKEN,
  invoice_number: 'INV-1',
  customer_name: 'Pat Customer',
  customer_email: 'pat@example.com',
  description: 'Roof',
  line_items: [{ name: 'Roof', unit_price: 100, quantity: 1 }],
  total_amount: '100.00',
  paid_amount: '0',
  status: 'unpaid',
  invoice_date: null,
  due_date: null,
  payment_link_url: 'https://pay.example/1',
  sent_at: null,
  paid_at: null,
  created_at: '2026-10-01T00:00:00Z',
  tenant_id: TENANT,
  moov_account_id: MERCHANT,
  moov_invoice_id: 'moov-inv-1',
  provider_metadata: { secret: 'x' },
  ...extra,
});

const publicLookupRoute = (sql) => {
  if (/FROM public\.moov_invoices/.test(sql)) return { rows: [invoiceRow()] };
  if (/FROM public\.tenants/.test(sql)) return { rows: [{ name: 'Freedom', slug: 'freedom' }] };
  return null;
};

// --- public invoice -------------------------------------------------------

test('public-invoice reaches handlePublicInvoice with no login or identity check', async () => {
  const client = fakeClient(publicLookupRoute);
  let identityChecked = false;
  const event = {
    rawPath: '/functions/v1/public-invoice',
    headers: {},
    body: JSON.stringify({ token: TOKEN }),
    requestContext: { http: { method: 'POST', path: '/functions/v1/public-invoice' } },
  };
  const result = await runParityHandler('public-invoice', event, {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    loadSandboxCredentials: async () => { identityChecked = true; return {}; },
    withIdentity: async () => { identityChecked = true; return { statusCode: 401 }; },
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.success, true);
  assert.equal(result.invoice.public_token, TOKEN);
  assert.equal(result.invoice.tenant_id, undefined);
  assert.equal(result.invoice.moov_invoice_id, undefined);
  assert.equal(result.invoice.provider_metadata, undefined);
  assert.equal(identityChecked, false);
  assert.equal(client.calls.some((c) => /cognito|user_mappings|application_user|tenant_memberships/i.test(c.sql)), false);
});

test('public-invoice refuses a non-token and a write action before any DB work', async () => {
  for (const body of [{ token: '1' }, { action: 'mark_paid', token: TOKEN }]) {
    let created = false;
    const result = await runParityHandler('public-invoice', {
      headers: {},
      body: JSON.stringify(body),
      requestContext: { http: { method: 'POST' } },
    }, { createClient: () => { created = true; return fakeClient(); }, loadDatabaseCredentials: async () => ({}) });
    assert.ok(result.statusCode === 404 || result.statusCode === 405, JSON.stringify(result));
    assert.equal(created, false);
  }
});

test('publicInvoice rejects non-UUIDv4 tokens and never matches by invoice id', async () => {
  const notTokens = [
    '1',
    INVOICE_ROW.replace(/-4/, '-1'), // UUID v1 shape
    '9b2f3c4d-1e2f-4a5b-cc6d-7e8f9a0b1c2d', // bad variant
    `${TOKEN}x`,
    "' OR 1=1 --",
  ];
  for (const token of notTokens) {
    const client = fakeClient(publicLookupRoute);
    const result = await publicInvoice.run({ client, body: { token } });
    assert.equal(result.statusCode, 404, token);
    assert.equal(client.calls.length, 0, token);
  }
  // An invoice id (even a UUID v4) in invoice_id is never a lookup key.
  {
    const client = fakeClient(publicLookupRoute);
    const result = await publicInvoice.run({ client, body: { invoice_id: INVOICE_ROW } });
    assert.equal(result.statusCode, 400);
    assert.equal(client.calls.length, 0);
  }
  // A valid token: exact match on moov_invoices.public_token, sanitized response.
  {
    const client = fakeClient(publicLookupRoute);
    const result = await publicInvoice.run({ client, body: { token: TOKEN.toUpperCase() } });
    assert.equal(result.success, true, JSON.stringify(result));
    const lookup = client.calls[0];
    assert.match(lookup.sql, /FROM public\.moov_invoices/);
    assert.match(lookup.sql, /WHERE public_token = \$1::uuid/);
    assert.doesNotMatch(lookup.sql, /payment_invoices|id::text|SELECT \*/);
    assert.deepEqual(lookup.params, [TOKEN]);
    for (const key of ['tenant_id', 'moov_account_id', 'moov_invoice_id', 'provider_metadata']) {
      assert.equal(key in result.invoice, false, key);
    }
  }
});

// --- invoice lifecycle ----------------------------------------------------

const accountRoute = (sql) => (/FROM public\.payment_provider_accounts/.test(sql)
  ? { rows: [{ tenant_id: TENANT, provider: 'moov', environment: 'sandbox', provider_account_id: MERCHANT }] }
  : null);

test('invoice.run delegates to runInvoiceAction (provider lifecycle actions exist)', async () => {
  // preflight exists only in the provider lifecycle (the legacy port would create an invoice).
  {
    const client = fakeClient(accountRoute);
    const { fetchImpl, calls } = recordedFetch([TOKEN_ROUTE]);
    const result = await runInMoov(invoice, { client, body: { action: 'preflight' }, fetchImpl });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.preflight, true);
    assert.equal(result.tenant_id, TENANT);
    assert.equal(result.merchantAccountId, MERCHANT);
    assert.equal(calls.length, 0);
  }
  // send: PATCH the provider invoice to unpaid, persist to moov_invoices for this tenant.
  {
    const client = fakeClient((sql, params) => {
      const account = accountRoute(sql);
      if (account) return account;
      if (/SELECT \* FROM public\.moov_invoices WHERE id = \$1::uuid AND tenant_id = \$2::uuid/.test(sql)) {
        assert.deepEqual(params, [INVOICE_ROW, TENANT]);
        return { rows: [invoiceRow({ status: 'draft' })] };
      }
      if (/UPDATE public\.moov_invoices/.test(sql)) return { rows: [invoiceRow({ status: 'unpaid' })] };
      return null;
    });
    const { fetchImpl, calls } = recordedFetch([
      TOKEN_ROUTE,
      { match: `/accounts/${MERCHANT}/invoices/moov-inv-1`, method: 'PATCH', body: { invoiceID: 'moov-inv-1', status: 'unpaid' } },
    ]);
    const result = await runInMoov(invoice, { client, body: { action: 'send', invoice_id: INVOICE_ROW }, fetchImpl });
    assert.equal(result.success, true, JSON.stringify(result));
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'provider PATCH');
    assert.deepEqual(JSON.parse(patch.body), { status: 'unpaid' });
    assert.ok(client.calls.some((c) => /UPDATE public\.moov_invoices/.test(c.sql)));
  }
  // Unknown actions are refused by invoice-actions.mjs before any work.
  {
    const client = fakeClient(accountRoute);
    const { fetchImpl, calls } = recordedFetch([TOKEN_ROUTE]);
    const result = await runInMoov(invoice, { client, body: { action: 'mark_paid' }, fetchImpl });
    assert.equal(result.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.equal(client.calls.length, 0);
  }
});

// --- Platform Finance -----------------------------------------------------

const ownerClient = (isOwner, extra = () => null) => fakeClient((sql, params) => {
  if (/is_platform_owner\(\)/.test(sql)) return { rows: [{ is_owner: isOwner }] };
  return extra(sql, params);
});

const platformFetch = () => recordedFetch([
  TOKEN_ROUTE,
  { match: `/accounts/${PLATFORM_ID}/capabilities`, body: [{ capability: 'transfers', status: 'enabled', secret: 'x' }] },
  { match: `/accounts/${PLATFORM_ID}/bank-accounts`, body: [{ bankAccountID: 'bank-1', bankName: 'Chase', lastFourAccountNumber: '6789', status: 'verified', routingNumber: '021000021' }] },
  { match: `/accounts/${PLATFORM_ID}/wallets/wallet-1/transactions`, body: [{ walletTransactionID: 't1', transactionType: 'ach-reversal', status: 'completed', grossAmount: 500 }] },
  { match: `/accounts/${PLATFORM_ID}/wallets`, body: [{ walletID: 'wallet-1', walletType: 'default', availableBalance: { valueDecimal: '12.34', currency: 'USD' }, pendingBalance: { value: 100 } }] },
  { match: `/accounts/${PLATFORM_ID}`, body: { accountType: 'business', displayName: 'ChecksOps', verificationStatus: 'verified' } },
]);

const pnlRoute = (sql) => {
  if (/FROM public\.tenants/.test(sql)) return { rows: [{ id: TENANT, name: 'Freedom' }] };
  if (/FROM public\.platform_fee_line_items/.test(sql)) {
    return { rows: [{ tenant_id: TENANT, amount_cents: 2500, occurred_at: new Date(), status: 'posted' }] };
  }
  if (/FROM public\.payment_transfers/.test(sql)) {
    return { rows: [{ tenant_id: TENANT, amount_cents: 100000, provider_fee_cents: 50, platform_fee_cents: 200, status: 'completed', created_at: new Date() }] };
  }
  return null;
};

test('platform bank status: platform owner reads the platform account (no tenant, no secrets)', async () => {
  const { fetchImpl, calls } = platformFetch();
  const result = await runInMoov(platformBank, { client: ownerClient(true), body: { action: 'status' }, fetchImpl, ctx: { tenantId: null } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.platform_account_id, PLATFORM_ID);
  assert.equal(result.tenant_context_used, false);
  assert.equal(result.profile.displayName, 'ChecksOps');
  assert.deepEqual(result.capabilities, [{ capability: 'transfers', status: 'enabled' }]);
  assert.equal(result.methods.length, 1);
  assert.equal(result.methods[0].last_four, '6789');
  assert.equal(result.methods[0].connection_status, 'connected');
  assert.equal(JSON.stringify(result).includes('021000021'), false);
  assert.equal(result.bankAccountAddInvoked, false);
  assert.equal(calls.some((c) => c.method !== 'GET' && !c.url.includes('/oauth2/token')), false);
});

test('platform treasury overview and pnl: platform owner gets wallet and P&L', async () => {
  {
    const { fetchImpl, calls } = platformFetch();
    const result = await runInMoov(platformTreasury, { client: ownerClient(true, pnlRoute), body: { action: 'overview' }, fetchImpl, ctx: { tenantId: null } });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.wallet.wallet_id, 'wallet-1');
    assert.equal(result.wallet.available_cents, 1234);
    assert.equal(result.wallet.pending_cents, 100);
    assert.equal(result.wallet.transactions[0].amount_cents, 500);
    assert.equal(result.pnl.totals.fees_cents, 2500);
    assert.equal(result.pnl.totals.transfer_fees_cents, 200);
    assert.equal(result.pnl.totals.revenue_cents, 2700);
    assert.equal(result.pnl.totals.profit_cents, 2650);
    assert.equal(result.pnl.months.length, 1);
    assert.match(result.pnl.months[0].month, /^\d{4}-\d{2}$/);
    assert.equal(result.pnl.tenants[0].tenant_name, 'Freedom');
    assert.equal(calls.some((c) => c.method !== 'GET' && !c.url.includes('/oauth2/token')), false);
  }
  {
    const { fetchImpl, calls } = platformFetch();
    const result = await runInMoov(platformTreasury, { client: ownerClient(true, pnlRoute), body: { action: 'pnl' }, fetchImpl, ctx: { tenantId: null } });
    assert.equal(result.success, true);
    assert.equal(result.pnl.totals.revenue_cents, 2700);
    assert.equal(result.liveProviderCalled, false);
    assert.equal(calls.length, 0);
  }
  {
    const { fetchImpl } = platformFetch();
    const result = await runInMoov(platformBank, { client: ownerClient(true), body: { action: 'wallet' }, fetchImpl, ctx: { tenantId: null } });
    assert.equal(result.success, true);
    assert.equal(result.wallet.wallet_id, 'wallet-1');
  }
});

test('platform finance reads are refused for a non-owner before any provider call', async () => {
  for (const handler of [platformBank, platformTreasury]) {
    for (const action of ['status', 'overview', 'wallet', 'pnl']) {
      const { fetchImpl, calls } = platformFetch();
      const client = ownerClient(false, pnlRoute);
      const result = await runInMoov(handler, { client, body: { action }, fetchImpl });
      assert.equal(result.statusCode, 403, action);
      assert.equal(result.error, 'Platform owner access required');
      assert.equal(calls.length, 0, action);
      assert.equal(client.calls.some((c) => /platform_fee_line_items|payment_transfers/.test(c.sql)), false, action);
    }
  }
});

test('platform finance writes stay refused for the platform owner', async () => {
  const writes = ['initiate_micro_deposit', 'confirm_micro_deposit', 'create', 'transfer', 'charge', 'pull', 'sweep', 'enable', 'disable', 'update'];
  for (const handler of [platformBank, platformTreasury]) {
    for (const action of writes) {
      const { fetchImpl, calls } = platformFetch();
      const result = await runInMoov(handler, { client: ownerClient(true), body: { action, amount_cents: 100 }, fetchImpl, ctx: { tenantId: null } });
      assert.equal(result.statusCode, 403, action);
      assert.equal(result.write_blocked, true, action);
      assert.equal(result.liveProviderCalled, false, action);
      assert.equal(calls.length, 0, action);
    }
  }
  // Platform bank add keeps its own refusal (never a tenant account, never a bank write).
  for (const [body, status] of [[{ action: 'add' }, 409], [{ action: 'add', tenant_id: TENANT }, 403]]) {
    const { fetchImpl, calls } = platformFetch();
    const result = await runInMoov(platformBank, { client: ownerClient(true), body, fetchImpl, ctx: { tenantId: null } });
    assert.equal(result.statusCode, status);
    assert.equal(calls.length, 0);
  }
});
