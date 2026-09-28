import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  invoice,
  invoiceProviderErrorMessage,
  normalizeInvoiceLineItems,
  INVOICE_API_VERSION,
} from '../functions/api/providers/parity/moov-onboard.mjs';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';
import {
  FREEDOM,
  FREEDOM_PROD,
  PLATFORM,
  STAGING_ACCOUNT,
  STAGING_TENANT,
  OTHER_TENANT,
  accountRow,
  ctxOf,
  fakeInvoiceClient,
  invoiceStore,
  lineItems,
  recordingFetch,
  sandboxMoovCtx,
} from './invoice-test-harness.mjs';

const createBody = (overrides = {}) => ({
  action: 'create',
  tenant_id: STAGING_TENANT,
  customer_name: 'Acme Adjusting',
  customer_email: 'billing@acme.test',
  customer_type: 'business',
  description: 'Controlled fixture',
  due_date: '2026-10-15',
  line_items: lineItems,
  ...overrides,
});

const runInvoice = async (store, body, fetchImpl, tenantId = STAGING_TENANT, environment = 'sandbox') => {
  resetMoovTokenCache();
  return withMoovContext(sandboxMoovCtx(fetchImpl), () => invoice.run({
    client: fakeInvoiceClient(store),
    body,
    ctx: ctxOf(tenantId, environment),
    fetchImpl,
  }));
};

test('normalizeInvoiceLineItems matches supabase guards', () => {
  assert.equal(normalizeInvoiceLineItems([]), 'At least one line item is required');
  assert.equal(normalizeInvoiceLineItems([{ name: '', unit_price: 1, quantity: 1 }]), 'Every line item needs a description');
  assert.match(normalizeInvoiceLineItems([{ name: 'Fee', unit_price: 0, quantity: 1 }]), /greater than zero/);
  assert.match(normalizeInvoiceLineItems([{ name: 'Fee', unit_price: 1, quantity: 0 }]), /quantity greater than zero/);
  assert.equal(normalizeInvoiceLineItems(Array.from({ length: 51 }, () => ({ name: 'x', unit_price: 1, quantity: 1 }))), 'An invoice can have at most 50 line items');
  assert.deepEqual(normalizeInvoiceLineItems([{ name: 'Fee', unit_price: 1.239, quantity: 2.8 }]), [
    { name: 'Fee', unit_price: 1.24, quantity: 3 },
  ]);
});

test('empty provider error becomes a useful HTTP reason', () => {
  assert.equal(
    invoiceProviderErrorMessage({ status: 400, message: '', body: { error: '' } }),
    'Payment provider rejected the invoice request (HTTP 400)',
  );
  assert.equal(
    invoiceProviderErrorMessage({ status: 400, message: '', body: { errors: { customerAccountID: 'required' } } }),
    'customerAccountID: required',
  );
});

test('A/D/E/F/G/J/K create business customer with customerAccountID and basePrice', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
    tenants: [{ id: STAGING_TENANT, invoice_footer_note: 'Pay within 15 days' }],
  });
  const { calls, fetchImpl } = recordingFetch();
  const result = await runInvoice(store, createBody(), fetchImpl);
  assert.equal(result.statusCode, 200);
  assert.equal(result.invoice.customer_email, 'billing@acme.test');
  assert.equal(result.invoice.customer_moov_account_id, 'cust-1');
  assert.equal(result.invoice.moov_account_id, STAGING_ACCOUNT);
  assert.equal(result.invoice.status, 'draft');
  assert.equal(result.customerReused, false);
  assert.equal(store.customers.length, 1);
  assert.equal(store.invoices.length, 1);
  assert.equal(store.events[0].event_type, 'invoice.created');

  const customerPost = calls.find((call) => call.method === 'POST' && /\/accounts$/.test(call.url.replace(/\?.*$/, '')));
  assert.deepEqual(customerPost.body, {
    accountType: 'business',
    profile: { business: { legalBusinessName: 'Acme Adjusting', email: 'billing@acme.test' } },
  });
  const invoicePosts = calls.filter((call) => call.method === 'POST' && call.url.includes('/invoices'));
  assert.equal(invoicePosts.length, 1);
  assert.match(invoicePosts[0].url, new RegExp(`/accounts/${STAGING_ACCOUNT}/invoices`));
  assert.doesNotMatch(invoicePosts[0].url, new RegExp(PLATFORM));
  assert.doesNotMatch(invoicePosts[0].url, new RegExp(FREEDOM_PROD));
  assert.equal(invoicePosts[0].body.customerAccountID, 'cust-1');
  assert.equal(invoicePosts[0].body.customer, undefined);
  assert.deepEqual(invoicePosts[0].body.lineItems, {
    items: [{ name: 'INV3 fixture', basePrice: { currency: 'USD', valueDecimal: '1.50' }, quantity: 2 }],
  });
  assert.equal(invoicePosts[0].body.footer, 'Pay within 15 days');
  assert.equal(invoicePosts[0].headers['x-moov-version'] || invoicePosts[0].headers['X-Moov-Version'] || INVOICE_API_VERSION, INVOICE_API_VERSION);
  assert.equal(calls.some((call) => call.method === 'PATCH'), false);
});

test('B reuse existing customer by email and do not POST /accounts', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
    customers: [{
      id: 'cust-row-1',
      tenant_id: STAGING_TENANT,
      environment: 'sandbox',
      email: 'billing@acme.test',
      moov_account_id: 'existing-cust',
    }],
  });
  const { calls, fetchImpl } = recordingFetch();
  const result = await runInvoice(store, createBody(), fetchImpl);
  assert.equal(result.statusCode, 200);
  assert.equal(result.customerReused, true);
  assert.equal(result.invoice.customer_moov_account_id, 'existing-cust');
  assert.equal(calls.filter((call) => call.method === 'POST' && /\/accounts$/.test(call.url.replace(/\?.*$/, ''))).length, 0);
  const invoicePost = calls.find((call) => call.method === 'POST' && call.url.includes('/invoices'));
  assert.equal(invoicePost.body.customerAccountID, 'existing-cust');
});

test('C individual customer uses profile.individual.name', async () => {
  const store = invoiceStore({ accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)] });
  const { calls, fetchImpl } = recordingFetch();
  const result = await runInvoice(store, createBody({
    customer_name: 'Jamie Rivera',
    customer_email: 'jamie@example.test',
    customer_type: 'individual',
  }), fetchImpl);
  assert.equal(result.statusCode, 200);
  const customerPost = calls.find((call) => call.method === 'POST' && /\/accounts$/.test(call.url.replace(/\?.*$/, '')));
  assert.deepEqual(customerPost.body, {
    accountType: 'individual',
    profile: { individual: { name: { firstName: 'Jamie', lastName: 'Rivera' }, email: 'jamie@example.test' } },
  });
});

test('H/I create_and_send PATCHes unpaid once and does not POST a second invoice', async () => {
  const store = invoiceStore({ accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)] });
  const { calls, fetchImpl } = recordingFetch();
  const result = await runInvoice(store, createBody({ action: 'create_and_send' }), fetchImpl);
  assert.equal(result.statusCode, 200);
  assert.equal(result.invoice.status, 'unpaid');
  assert.ok(result.invoice.sent_at);
  const invoicePosts = calls.filter((call) => call.method === 'POST' && call.url.includes('/invoices'));
  const patches = calls.filter((call) => call.method === 'PATCH' && call.url.includes('/invoices/'));
  assert.equal(invoicePosts.length, 1);
  assert.equal(patches.length, 1);
  assert.match(patches[0].url, /\/invoices\/inv-1$/);
  assert.deepEqual(patches[0].body, { status: 'unpaid' });
  assert.equal(store.events[0].event_type, 'invoice.sent');
});

test('L send/resend PATCHes the existing invoice and paid/canceled are guarded', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
    invoices: [{
      id: 'local-1',
      tenant_id: STAGING_TENANT,
      environment: 'sandbox',
      moov_invoice_id: 'inv-keep',
      status: 'draft',
      invoice_number: null,
      payment_link_url: null,
    }, {
      id: 'paid-1',
      tenant_id: STAGING_TENANT,
      environment: 'sandbox',
      moov_invoice_id: 'inv-paid',
      status: 'paid',
    }, {
      id: 'canceled-1',
      tenant_id: STAGING_TENANT,
      environment: 'sandbox',
      moov_invoice_id: 'inv-can',
      status: 'canceled',
    }],
  });
  const { calls, fetchImpl } = recordingFetch();
  const sent = await runInvoice(store, { action: 'send', tenant_id: STAGING_TENANT, invoice_id: 'local-1' }, fetchImpl);
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.invoice.status, 'unpaid');
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.includes('/invoices')).length, 0);
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 1);

  const paid = await runInvoice(store, { action: 'resend', tenant_id: STAGING_TENANT, invoice_id: 'paid-1' }, fetchImpl);
  assert.equal(paid.statusCode, 400);
  assert.equal(paid.error, 'This invoice is already paid');
  const canceled = await runInvoice(store, { action: 'resend', tenant_id: STAGING_TENANT, invoice_id: 'canceled-1' }, fetchImpl);
  assert.equal(canceled.statusCode, 400);
  assert.equal(canceled.error, 'A canceled invoice cannot be resent');
});

test('M sync refreshes only the tenant/environment invoice', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
    invoices: [{
      id: 'local-2',
      tenant_id: STAGING_TENANT,
      environment: 'sandbox',
      moov_invoice_id: 'inv-1',
      status: 'unpaid',
      total_amount: 3,
      invoice_number: 'INV-1',
    }, {
      id: 'other',
      tenant_id: OTHER_TENANT,
      environment: 'sandbox',
      moov_invoice_id: 'inv-other',
      status: 'unpaid',
      total_amount: 9,
    }],
  });
  const { fetchImpl } = recordingFetch();
  const result = await runInvoice(store, { action: 'sync', tenant_id: STAGING_TENANT }, fetchImpl);
  assert.equal(result.statusCode, 200);
  assert.equal(result.synced, 1);
  assert.equal(store.invoices.find((row) => row.id === 'other').total_amount, 9);
});

test('N/O staging never uses Freedom production or platform merchant', async () => {
  const store = invoiceStore({
    accounts: [
      accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT),
      accountRow(FREEDOM, 'production', FREEDOM_PROD),
    ],
  });
  const { calls, fetchImpl } = recordingFetch();
  const result = await runInvoice(store, createBody(), fetchImpl);
  assert.equal(result.statusCode, 200);
  const blob = JSON.stringify(calls);
  assert.equal(blob.includes(FREEDOM_PROD), false);
  assert.equal(blob.includes(PLATFORM), false);
  assert.equal(result.invoice.moov_account_id, STAGING_ACCOUNT);
});

test('P empty Moov 400 is surfaced instead of a blank error', async () => {
  const store = invoiceStore({ accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)] });
  const { fetchImpl } = recordingFetch({
    errorFor: ({ url, method }) => (
      method === 'POST' && url.includes('/invoices')
        ? { status: 400, body: { error: '' } }
        : null
    ),
  });
  const result = await runInvoice(store, createBody(), fetchImpl);
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'Payment provider rejected the invoice request (HTTP 400)');
  assert.notEqual(result.error, '');
  assert.notEqual(result.error, 'Invoice request failed');
  assert.equal(store.invoices.length, 0);
});

test('production preflight still resolves Freedom merchant without calling Moov', async () => {
  const store = invoiceStore({ accounts: [accountRow(FREEDOM, 'production', FREEDOM_PROD)] });
  const result = await invoice.run({
    client: fakeInvoiceClient(store),
    body: { action: 'preflight', tenant_id: FREEDOM },
    ctx: ctxOf(FREEDOM, 'production'),
    fetchImpl: async () => { throw new Error('preflight must not call Moov'); },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.merchantAccountId, FREEDOM_PROD);
  assert.equal(result.liveProviderCalled, false);
});
