import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  applyCancelTransition,
  applySendTransition,
  applySyncTransition,
  canDeleteStatus,
  invoiceTotal,
  loadPublicInvoiceByToken,
  normalizeLineItems,
  runInvoiceAction,
} from '../functions/api/invoice-actions.mjs';
import { handlePublicInvoice } from '../functions/api/public-invoice.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { denyTableReason, FINANCIAL_OR_PROVIDER_TABLES } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';
const USER_A = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const INV_DRAFT = '11111111-1111-4111-8111-111111111111';
const INV_UNPAID = '22222222-2222-4222-8222-222222222222';
const INV_PAID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const items = [{ name: 'Restore roof', unit_price: 250, quantity: 2 }];

function mockClient({
  invoices = [],
  customers = [],
  tenants = [{ id: TENANT_A, name: 'Condition One Commercial', slug: 'c1c' }],
  memberships = [{ tenant_id: TENANT_A, role: 'admin' }],
} = {}) {
  const store = {
    invoices: invoices.map((row) => ({ ...row })),
    customers: customers.map((row) => ({ ...row })),
    tenants,
    queries: [],
  };
  return {
    store,
    query: async (sql, params = []) => {
      store.queries.push({ sql, params });
      const text = String(sql);
      if (text.includes('FROM public.tenant_users') || text.includes('tenant_users tu')) {
        return { rows: memberships };
      }
      if (text.includes('FROM public.user_roles')) {
        return { rows: [] };
      }
      if (text.includes('FROM public.moov_invoice_customers') && text.includes('lower(email)')) {
        const email = String(params[2] || '').toLowerCase();
        return { rows: store.customers.filter((c) => c.email === email && c.tenant_id === params[0]) };
      }
      if (text.startsWith('INSERT INTO public.moov_invoice_customers')) {
        const row = {
          id: 'cust-1',
          moov_account_id: params[5],
          tenant_id: params[0],
          email: params[3],
        };
        store.customers.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('INSERT INTO public.moov_invoices')) {
        const row = {
          id: 'new-inv',
          tenant_id: params[0],
          environment: params[1],
          moov_account_id: params[2],
          moov_invoice_id: null,
          invoice_number: params[3],
          customer_id: params[4],
          customer_name: params[5],
          customer_email: params[6],
          customer_moov_account_id: params[7],
          description: params[8],
          line_items: JSON.parse(params[9]),
          total_amount: params[10],
          paid_amount: 0,
          status: params[11],
          invoice_date: params[12],
          due_date: params[13],
          payment_link_url: null,
          public_token: params[14],
          sent_at: params[15],
          paid_at: null,
          created_at: '2026-10-05T00:00:00Z',
        };
        store.invoices.push(row);
        return { rows: [row] };
      }
      if (text.includes('FROM public.moov_invoices WHERE id = $1::uuid AND tenant_id = $2::uuid')) {
        return {
          rows: store.invoices.filter((row) => row.id === params[0] && row.tenant_id === params[1]),
        };
      }
      if (text.startsWith('UPDATE public.moov_invoices') && text.includes('status = $2')) {
        const row = store.invoices.find((item) => item.id === params[0] && item.tenant_id === params[4]);
        if (!row) return { rows: [] };
        row.status = params[1];
        row.sent_at = params[2];
        row.public_token = row.public_token || params[3];
        return { rows: [row] };
      }
      if (text.startsWith('UPDATE public.moov_invoices') && text.includes("status = 'canceled'")) {
        const row = store.invoices.find((item) => item.id === params[0] && item.tenant_id === params[1]);
        if (!row) return { rows: [] };
        row.status = 'canceled';
        return { rows: [row] };
      }
      if (text.startsWith('DELETE FROM public.moov_invoices')) {
        const before = store.invoices.length;
        store.invoices = store.invoices.filter((row) => !(row.id === params[0] && row.tenant_id === params[1]));
        return { rowCount: before - store.invoices.length, rows: [] };
      }
      if (text.includes('FROM public.moov_invoices') && text.includes('environment = $2')) {
        return {
          rows: store.invoices.filter((row) => row.tenant_id === params[0] && !['paid', 'canceled', 'void'].includes(row.status)),
        };
      }
      if (text.startsWith('UPDATE public.moov_invoices SET last_synced_at')) {
        return { rows: [] };
      }
      if (text.includes('FROM public.moov_invoices') && text.includes('public_token')) {
        return { rows: store.invoices.filter((row) => String(row.public_token) === String(params[0])) };
      }
      if (text.includes('FROM public.tenants WHERE id')) {
        return { rows: store.tenants.filter((row) => row.id === params[0]) };
      }
      return { rows: [] };
    },
  };
}

const draft = {
  id: INV_DRAFT,
  tenant_id: TENANT_A,
  status: 'draft',
  paid_amount: 0,
  paid_at: null,
  sent_at: null,
  public_token: TOKEN,
  moov_invoice_id: null,
};

const unpaid = {
  id: INV_UNPAID,
  tenant_id: TENANT_A,
  status: 'unpaid',
  paid_amount: 0,
  paid_at: null,
  sent_at: '2026-10-05T00:00:00Z',
  public_token: TOKEN,
};

const paid = {
  id: INV_PAID,
  tenant_id: TENANT_A,
  status: 'paid',
  paid_amount: 500,
  paid_at: '2026-10-05T00:00:00Z',
  sent_at: '2026-10-04T00:00:00Z',
  public_token: TOKEN,
};

test('line items and totals stay display-safe', () => {
  assert.equal(typeof normalizeLineItems([]), 'string');
  assert.equal(invoiceTotal(items), 500);
});

test('send never invents paid or settlement', () => {
  const next = applySendTransition(draft);
  assert.equal(next.status, 'unpaid');
  assert.equal(next.paid_amount, 0);
  assert.equal(next.paid_at, null);
  assert.equal(next.emailed, false);
  assert.equal(applySendTransition(paid).statusCode, 400);
});

test('sync without provider leaves paid fields unchanged', () => {
  const next = applySyncTransition(unpaid, null);
  assert.equal(next.status, 'unpaid');
  assert.equal(next.paid_amount, 0);
  assert.equal(next.invented_paid, false);
  assert.equal(next.liveProviderCalled, false);
});

test('delete is allowed only for draft and canceled', () => {
  assert.equal(canDeleteStatus('draft'), true);
  assert.equal(canDeleteStatus('canceled'), true);
  assert.equal(canDeleteStatus('unpaid'), false);
  assert.equal(canDeleteStatus('paid'), false);
});

test('cancel of paid is invalid; cancel of canceled is idempotent', () => {
  assert.equal(applyCancelTransition(paid).statusCode, 400);
  assert.equal(applyCancelTransition({ status: 'canceled', paid_amount: 0 }).idempotent, true);
});

test('create draft persists locally without Moov', async () => {
  const client = mockClient();
  const result = await runInvoiceAction({
    client,
    tenantId: TENANT_A,
    userId: USER_A,
    body: {
      action: 'create',
      customer_name: 'Acme Restoration',
      customer_email: 'billing@acme.com',
      line_items: items,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.invoice.status, 'draft');
  assert.equal(result.invoice.paid_amount, 0);
  assert.equal(result.invoice.moov_invoice_id, null);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.emailed, false);
  assert.ok(result.invoice.public_token);
});

test('create_and_send marks unpaid but not paid and does not email', async () => {
  const client = mockClient();
  const result = await runInvoiceAction({
    client,
    tenantId: TENANT_A,
    userId: USER_A,
    body: {
      action: 'create_and_send',
      customer_name: 'Acme Restoration',
      customer_email: 'billing@acme.com',
      line_items: items,
    },
  });
  assert.equal(result.invoice.status, 'unpaid');
  assert.equal(result.invoice.paid_amount, 0);
  assert.equal(result.invoice.paid_at, null);
  assert.equal(result.emailed, false);
  assert.equal(result.liveProviderCalled, false);
});

test('send draft then resend is idempotent and stays unpaid', async () => {
  const client = mockClient({ invoices: [draft] });
  const sent = await runInvoiceAction({
    client,
    tenantId: TENANT_A,
    userId: USER_A,
    body: { action: 'send', invoice_id: INV_DRAFT },
  });
  assert.equal(sent.invoice.status, 'unpaid');
  const resent = await runInvoiceAction({
    client,
    tenantId: TENANT_A,
    userId: USER_A,
    body: { action: 'resend', invoice_id: INV_DRAFT },
  });
  assert.equal(resent.invoice.status, 'unpaid');
  assert.equal(resent.invoice.paid_amount, 0);
  assert.equal(resent.emailed, false);
});

test('invalid transitions are refused', async () => {
  const client = mockClient({ invoices: [paid, unpaid] });
  const sendPaid = await runInvoiceAction({
    client, tenantId: TENANT_A, userId: USER_A,
    body: { action: 'send', invoice_id: INV_PAID },
  });
  assert.equal(sendPaid.ok, false);
  const cancelPaid = await runInvoiceAction({
    client, tenantId: TENANT_A, userId: USER_A,
    body: { action: 'cancel', invoice_id: INV_PAID },
  });
  assert.equal(cancelPaid.ok, false);
  const deleteUnpaid = await runInvoiceAction({
    client, tenantId: TENANT_A, userId: USER_A,
    body: { action: 'delete', invoice_id: INV_UNPAID },
  });
  assert.equal(deleteUnpaid.ok, false);
  assert.match(deleteUnpaid.error, /Only canceled or draft/);
});

test('delete draft removes the row; paid row is untouched', async () => {
  const client = mockClient({ invoices: [draft, paid] });
  const result = await runInvoiceAction({
    client, tenantId: TENANT_A, userId: USER_A,
    body: { action: 'delete', invoice_id: INV_DRAFT },
  });
  assert.equal(result.deleted, true);
  assert.equal(client.store.invoices.some((row) => row.id === INV_DRAFT), false);
  assert.equal(client.store.invoices.some((row) => row.id === INV_PAID), true);
});

test('cross-tenant invoice id is not found', async () => {
  const client = mockClient({ invoices: [{ ...draft, tenant_id: TENANT_B }] });
  const result = await runInvoiceAction({
    client, tenantId: TENANT_A, userId: USER_A,
    body: { action: 'send', invoice_id: INV_DRAFT },
  });
  assert.equal(result.statusCode, 404);
});

test('sync does not mark sent invoices paid', async () => {
  const client = mockClient({ invoices: [unpaid] });
  const result = await runInvoiceAction({
    client, tenantId: TENANT_A, userId: USER_A,
    body: { action: 'sync' },
  });
  assert.equal(result.synced, 1);
  assert.equal(result.invented_paid, false);
  assert.equal(client.store.invoices[0].status, 'unpaid');
  assert.equal(client.store.invoices[0].paid_amount, 0);
});

test('live provider flag stays fail-closed', async () => {
  const result = await runInvoiceAction({
    client: mockClient(),
    tenantId: TENANT_A,
    liveProvider: true,
    body: { action: 'create', customer_name: 'X', customer_email: 'a@b.com', line_items: items },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invoice_provider_not_authorized');
  assert.equal(result.liveProviderCalled, false);
});

test('public token lookup returns invoice and tenant without listing others', async () => {
  const client = mockClient({
    invoices: [{
      ...unpaid,
      public_token: TOKEN,
      customer_name: 'Acme',
      customer_email: 'billing@acme.com',
      line_items: items,
      total_amount: 500,
    }],
  });
  const result = await loadPublicInvoiceByToken(client, TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.invoice.customer_name, 'Acme');
  assert.equal(result.tenant.name, 'Condition One Commercial');
  assert.equal(result.invoice.paid_amount, 0);
});

test('public invoice HTTP handler is token-only', async () => {
  const invoices = [{
    ...unpaid,
    public_token: TOKEN,
    customer_name: 'Acme',
    customer_email: 'billing@acme.com',
    line_items: items,
    total_amount: 500,
  }];
  const client = mockClient({ invoices });
  const result = await handlePublicInvoice({
    body: JSON.stringify({ token: TOKEN }),
  }, {
    loadDatabaseCredentials: async () => ({}),
    createClient: () => ({
      connect: async () => {},
      end: async () => {},
      query: client.query,
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.invoice.customer_name, 'Acme');
});

test('moov-invoice is not Class A and generic writes stay denied', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('moov-invoice'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('public-invoice'), false);
  assert.ok(FINANCIAL_OR_PROVIDER_TABLES.has('moov_invoices'));
  assert.ok(denyTableReason('moov_invoices'));
});

test('handler source does not call Moov or money movement', () => {
  const src = sourceOf('aws/functions/api/invoice-actions.mjs');
  assert.doesNotMatch(src, /moovFetch|api\.moov\.io|createTransfer|disburse|wallet|ACH/i);
  assert.match(src, /liveProvider/);
  const onboard = sourceOf('aws/functions/api/providers/parity/moov-onboard.mjs');
  assert.match(onboard, /runInvoiceAction/);
  assert.doesNotMatch(onboard, /\/accounts\/\$\{accountId\}\/invoices/);
});

test('accepted overlay and recipient contracts stay out of this change', () => {
  const accounting = sourceOf('aws/functions/api/payment-accounting.mjs');
  assert.match(accounting, /list_recipient_overlays/);
  assert.match(accounting, /update_recipient_display/);
  assert.doesNotMatch(accounting, /moov-invoice|runInvoiceAction/);
});
