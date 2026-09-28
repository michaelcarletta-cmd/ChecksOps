import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { invoice, INVOICE_API_VERSION } from '../functions/api/providers/parity/moov-onboard.mjs';
import { logPaymentEvent } from '../functions/api/providers/parity/db.mjs';
import {
  classifyTrackedSqlFailure,
  commitWriteTransaction,
  logCommitFailure,
} from '../functions/api/data.mjs';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';
import {
  FREEDOM,
  FREEDOM_PROD,
  STAGING_ACCOUNT,
  STAGING_TENANT,
  OTHER_TENANT,
  accountRow,
  ctxOf,
  fakeInvoiceClient,
  invoiceStore,
  recordingFetch,
  sandboxMoovCtx,
} from './invoice-test-harness.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const recoveredInvoice = {
  invoiceID: 'existing-inv-1',
  invoiceNumber: 'INV-1',
  customerAccountID: '37995fe2-ad72-4a4b-a031-a8b9bce3c5e2',
  customerDisplayName: 'Pat Customer',
  customerEmail: 'pat@example.test',
  status: 'overdue',
  sentOn: '2026-09-28T18:49:13.590Z',
  createdOn: '2026-09-28T18:49:12.273Z',
  dueDate: '2026-09-28T00:00:00Z',
  paymentLinkURL: 'https://moov.example/pay/existing-inv-1',
  totalAmount: { currency: 'USD', valueDecimal: '1.00' },
  paidAmount: { currency: 'USD', valueDecimal: '0.00' },
  lineItems: { items: [{ name: 'Fee', quantity: 1, basePrice: { currency: 'USD', valueDecimal: '1.00' } }] },
};

const runInvoice = async (store, body, fetchImpl, tenantId = STAGING_TENANT, environment = 'sandbox') => {
  resetMoovTokenCache();
  return withMoovContext(sandboxMoovCtx(fetchImpl), () => invoice.run({
    client: fakeInvoiceClient(store),
    body,
    ctx: ctxOf(tenantId, environment),
    fetchImpl,
  }));
};

test('recover persists an existing provider invoice without POST or PATCH', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
  });
  const { calls, fetchImpl } = recordingFetch({ invoices: [recoveredInvoice] });
  const result = await runInvoice(store, {
    action: 'recover',
    tenant_id: STAGING_TENANT,
    moov_invoice_id: recoveredInvoice.invoiceID,
  }, fetchImpl);
  assert.equal(result.statusCode, 200);
  assert.equal(result.recovered, true);
  assert.equal(result.providerWrites, false);
  assert.equal(result.invoice.moov_invoice_id, recoveredInvoice.invoiceID);
  assert.equal(result.invoice.customer_email, 'pat@example.test');
  assert.equal(result.invoice.status, 'overdue');
  assert.equal(result.invoice.payment_link_url, recoveredInvoice.paymentLinkURL);
  assert.equal(store.customers.length, 1);
  assert.equal(store.invoices.length, 1);
  assert.equal(store.customers[0].moov_account_id, recoveredInvoice.customerAccountID);
  assert.equal(calls.some((call) => call.method === 'POST' && !call.url.includes('/oauth2/token')), false);
  assert.equal(calls.some((call) => call.method === 'PATCH'), false);
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);
  assert.equal(calls.filter((call) => call.method === 'GET' && call.url.includes('/invoices/existing-inv-1')).length, 1);
});

test('recover is idempotent and does not create a duplicate', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
    invoices: [{
      id: 'local-1',
      tenant_id: STAGING_TENANT,
      environment: 'sandbox',
      moov_invoice_id: recoveredInvoice.invoiceID,
      customer_email: 'pat@example.test',
      status: 'overdue',
    }],
  });
  const { calls, fetchImpl } = recordingFetch({ invoices: [recoveredInvoice] });
  const result = await runInvoice(store, {
    action: 'recover',
    tenant_id: STAGING_TENANT,
    moov_invoice_id: recoveredInvoice.invoiceID,
  }, fetchImpl);
  assert.equal(result.statusCode, 200);
  assert.equal(result.alreadyPresent, true);
  assert.equal(result.recovered, false);
  assert.equal(store.invoices.length, 1);
  assert.equal(calls.some((call) => call.method === 'GET' && call.url.includes('/invoices/')), false);
});

test('event-log INSERT failure does not drop customer or invoice rows', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
  });
  const client = fakeInvoiceClient(store);
  const original = client.query;
  client.query = async (sql, params) => {
    if (String(sql).includes('INSERT INTO public.payment_event_log')) {
      throw Object.assign(new Error('new row violates row-level security policy for table "payment_event_log"'), { code: '42501' });
    }
    return original(sql, params);
  };
  const { fetchImpl } = recordingFetch();
  resetMoovTokenCache();
  const result = await withMoovContext(sandboxMoovCtx(fetchImpl), () => invoice.run({
    client,
    body: {
      action: 'create_and_send',
      tenant_id: STAGING_TENANT,
      customer_name: 'Acme Adjusting',
      customer_email: 'billing@acme.test',
      customer_type: 'business',
      line_items: [{ name: 'Fee', unit_price: 1, quantity: 1 }],
    },
    ctx: ctxOf(STAGING_TENANT, 'sandbox'),
    fetchImpl,
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(store.customers.length, 1);
  assert.equal(store.invoices.length, 1);
  assert.equal(store.events.length, 0);
});

test('logPaymentEvent uses SAVEPOINT and rolls back only the event insert', async () => {
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(String(sql));
      if (sql.includes('INSERT INTO public.payment_event_log')) {
        throw Object.assign(new Error('rls denied'), { code: '42501' });
      }
      return { rows: [] };
    },
  };
  await logPaymentEvent(client, {
    tenant_id: STAGING_TENANT,
    event_type: 'invoice.sent',
    environment: 'sandbox',
    provider_metadata: { invoiceID: 'x' },
  });
  assert.equal(queries.some((sql) => sql.includes('SAVEPOINT payment_event_log')), true);
  assert.equal(queries.some((sql) => sql.includes('ROLLBACK TO SAVEPOINT payment_event_log')), true);
});

test('commitWriteTransaction treats COMMIT-as-ROLLBACK as failure and logs first SQL error', async () => {
  const failures = [{
    sqlstate: '42501',
    table: 'payment_event_log',
    operation: 'INSERT',
    message: 'new row violates row-level security policy for table "payment_event_log"',
  }];
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const first = logCommitFailure(new Error('transaction_not_committed'), failures, {
      rawPath: '/functions/v1/moov-invoice',
      requestContext: { requestId: 'test' },
    });
    assert.equal(first.sqlstate, '42501');
    assert.equal(first.table, 'payment_event_log');
    assert.match(errors.join(' '), /write_transaction_not_committed/);
    assert.match(errors.join(' '), /42501/);
  } finally {
    console.error = orig;
  }
  const client = { query: async () => ({ command: 'ROLLBACK' }) };
  await assert.rejects(() => commitWriteTransaction(client), /transaction_not_committed/);
  assert.equal(classifyTrackedSqlFailure({ code: '42501', message: 'rls' }, 'INSERT INTO public.payment_event_log').table, 'payment_event_log');
});

test('recover is tenant isolated', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
    invoices: [{
      id: 'other-local',
      tenant_id: OTHER_TENANT,
      environment: 'sandbox',
      moov_invoice_id: recoveredInvoice.invoiceID,
      customer_email: 'other@example.test',
    }],
  });
  const { fetchImpl } = recordingFetch({ invoices: [recoveredInvoice] });
  const result = await runInvoice(store, {
    action: 'recover',
    tenant_id: STAGING_TENANT,
    moov_invoice_id: recoveredInvoice.invoiceID,
  }, fetchImpl);
  assert.equal(result.statusCode, 200);
  assert.equal(result.recovered, true);
  assert.equal(store.invoices.filter((row) => row.tenant_id === STAGING_TENANT).length, 1);
  assert.equal(store.invoices.filter((row) => row.tenant_id === OTHER_TENANT).length, 1);
  assert.equal(FREEDOM, '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
});

test('payment_event_log write SQL is INSERT-only and tenant scoped', () => {
  const sql = readFileSync(path.join(ROOT, '../rls/sql/43_payment_event_log_write.sql'), 'utf8');
  assert.match(sql, /CREATE POLICY aws_write_payment_event_log/);
  assert.match(sql, /FOR INSERT TO authenticated/);
  assert.match(sql, /aws_can_write_tenant\(tenant_id\)/);
  assert.equal(/FOR ALL/.test(sql), false);
  assert.equal(/DISABLE ROW LEVEL SECURITY/.test(sql), false);
  assert.equal(/DROP POLICY aws_select_payment_event_log/.test(sql), false);
});

test('send path still PATCHes unpaid only for create_and_send', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
  });
  const { calls, fetchImpl } = recordingFetch();
  const result = await runInvoice(store, {
    action: 'create_and_send',
    tenant_id: STAGING_TENANT,
    customer_name: 'Acme Adjusting',
    customer_email: 'billing@acme.test',
    customer_type: 'business',
    line_items: [{ name: 'Fee', unit_price: 1, quantity: 1 }],
  }, fetchImpl);
  assert.equal(result.statusCode, 200);
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(INVOICE_API_VERSION, 'v2026.07.00');
  assert.equal(FREEDOM_PROD, '60922058-7eca-4889-81dd-5720d7b9de96');
});
