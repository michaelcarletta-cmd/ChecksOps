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
  generatePublicToken,
  invoiceTotal,
  isPublicInvoiceToken,
  loadPublicInvoiceByToken,
  normalizeLineItems,
  PUBLIC_INVOICE_FORBIDDEN_KEYS,
  PUBLIC_INVOICE_RESPONSE_KEYS,
  PUBLIC_TENANT_RESPONSE_KEYS,
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
const INV_CANCELED = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_ID = '55555555-5555-4555-8555-555555555555';
const CHECK_ID = '66666666-6666-4666-8666-666666666666';
const CUSTOMER_ID = '77777777-7777-4777-8777-777777777777';

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
      if (text.includes('SELECT * FROM public.moov_invoices WHERE id = $1::uuid AND tenant_id = $2::uuid')) {
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
      if (text.includes('FROM public.moov_invoices') && text.includes('public_token = $1::uuid')) {
        const wanted = String(params[0] || '').toLowerCase();
        return {
          rows: store.invoices.filter((row) => String(row.public_token || '').toLowerCase() === wanted),
        };
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

test('5480 local persist path is gone from invoice actions', () => {
  const src = sourceOf('aws/functions/api/invoice-actions.mjs');
  const provider = sourceOf('aws/functions/api/invoice-provider.mjs');
  assert.doesNotMatch(src, /LOCAL_MERCHANT|moov_account_id = 'local'|upsertLocalCustomer/);
  assert.doesNotMatch(src, /invoice_provider_not_authorized/);
  assert.match(src, /runProviderInvoiceAction/);
  assert.match(provider, /moovFetch/);
  assert.match(provider, /status: 'unpaid'/);
  assert.match(provider, /paymentLinkURL/);
  assert.match(provider, /generatePublicToken/);
  assert.doesNotMatch(provider, /createTransfer|moov-disburse|\/transfers|wallet\/|sweep-configs|ach/);
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

test('handler source uses provider invoice actions and not money movement', () => {
  const src = sourceOf('aws/functions/api/invoice-actions.mjs');
  const provider = sourceOf('aws/functions/api/invoice-provider.mjs');
  const onboard = sourceOf('aws/functions/api/providers/parity/moov-onboard.mjs');
  const wrap = sourceOf('aws/functions/api/providers/parity/moov-functions.mjs');
  assert.match(src, /runProviderInvoiceAction/);
  assert.doesNotMatch(src, /createTransfer|moov-disburse/);
  assert.match(provider, /runProviderInvoiceAction/);
  assert.match(onboard, /runProviderInvoiceAction/);
  assert.match(wrap, /withIdentityWrite/);
  assert.doesNotMatch(wrap, /liveProviderCalled: false,\n        applicationUserId/);
  const invoiceWrap = wrap.slice(wrap.indexOf("if (name === 'moov-invoice')"), wrap.indexOf("if (name === 'moov-invoice')") + 80);
  assert.equal(invoiceWrap.includes('fetchImpl: null'), false);
});

test('accepted overlay and recipient contracts stay out of this change', () => {
  const accounting = sourceOf('aws/functions/api/payment-accounting.mjs');
  assert.match(accounting, /list_recipient_overlays/);
  assert.match(accounting, /update_recipient_display/);
  assert.doesNotMatch(accounting, /moov-invoice|runInvoiceAction/);
});

const publicInvoiceRow = (overrides = {}) => ({
  ...unpaid,
  public_token: TOKEN,
  customer_name: 'Acme',
  customer_email: 'billing@acme.com',
  customer_id: CUSTOMER_ID,
  customer_moov_account_id: 'moov-cust-1',
  moov_account_id: 'moov-merchant-1',
  moov_invoice_id: 'moov-inv-1',
  provider_metadata: { invoiceID: 'secret', bank: { routing_number: '021000021' } },
  environment: 'sandbox',
  created_by: USER_A,
  last_synced_at: '2026-10-05T00:00:00Z',
  line_items: items,
  total_amount: 500,
  invoice_number: 'INV-TEST01',
  description: 'Mitigation',
  invoice_date: '2026-10-01',
  due_date: '2026-10-15',
  payment_link_url: null,
  created_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

const publicDeps = (client) => ({
  loadDatabaseCredentials: async () => ({}),
  createClient: () => ({
    connect: async () => {},
    end: async () => {},
    query: client.query,
  }),
});

test('public tokens are UUID v4 with CSPRNG entropy and are not sequential', () => {
  const tokens = Array.from({ length: 32 }, () => generatePublicToken());
  for (const token of tokens) {
    assert.equal(isPublicInvoiceToken(token), true);
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
  assert.equal(new Set(tokens).size, tokens.length);
  const hexHeads = tokens.map((token) => Number.parseInt(token.slice(0, 8), 16));
  const sequential = hexHeads.every((value, index, all) => index === 0 || value === all[index - 1] + 1);
  assert.equal(sequential, false);
  assert.equal(isPublicInvoiceToken('1'), false);
  assert.equal(isPublicInvoiceToken('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa'), false);
  assert.equal(isPublicInvoiceToken(`${TOKEN}0`), false);
  assert.equal(isPublicInvoiceToken(`${TOKEN.slice(0, 8)}%`), false);
});

test('public lookup requires the complete exact token', async () => {
  const client = mockClient({ invoices: [publicInvoiceRow()] });
  const exact = await loadPublicInvoiceByToken(client, TOKEN);
  assert.equal(exact.ok, true);
  assert.equal(exact.invoice.public_token, TOKEN);

  const attempts = [
    TOKEN.slice(0, 8),
    TOKEN.slice(0, -1),
    `${TOKEN}%`,
    `${TOKEN}_`,
    `%${TOKEN}%`,
    TOKEN.replace(/a/g, 'b'),
    'not-a-token',
    '1',
    1,
    '',
  ];
  for (const token of attempts) {
    const result = await loadPublicInvoiceByToken(client, token);
    assert.equal(result.ok, false, `expected fail closed for ${JSON.stringify(token)}`);
    assert.ok(result.statusCode === 400 || result.statusCode === 404);
  }
});

test('invoice, tenant, claim, check, and customer identifiers cannot retrieve a public invoice', async () => {
  const client = mockClient({ invoices: [publicInvoiceRow()] });
  const identifiers = [INV_UNPAID, TENANT_A, CLAIM_ID, CHECK_ID, CUSTOMER_ID, 'billing@acme.com'];
  for (const token of identifiers) {
    const result = await loadPublicInvoiceByToken(client, token);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 404);
  }
});

test('public HTTP handler ignores invoice_id and other identifiers as lookup keys', async () => {
  const client = mockClient({ invoices: [publicInvoiceRow()] });
  const deps = publicDeps(client);
  const byInvoiceId = await handlePublicInvoice({
    httpMethod: 'POST',
    body: JSON.stringify({ invoice_id: INV_UNPAID }),
  }, deps);
  assert.equal(byInvoiceId.ok, false);
  assert.equal(byInvoiceId.statusCode, 400);

  const byTenant = await handlePublicInvoice({
    httpMethod: 'POST',
    body: JSON.stringify({ tenant_id: TENANT_A }),
  }, deps);
  assert.equal(byTenant.ok, false);
  assert.equal(byTenant.statusCode, 400);

  const byClaim = await handlePublicInvoice({
    httpMethod: 'POST',
    body: JSON.stringify({ claim_id: CLAIM_ID, check_id: CHECK_ID, customer_id: CUSTOMER_ID }),
  }, deps);
  assert.equal(byClaim.ok, false);

  const tokenPlusInvoiceId = await handlePublicInvoice({
    httpMethod: 'POST',
    body: JSON.stringify({ token: TOKEN, invoice_id: INV_UNPAID }),
  }, deps);
  assert.equal(tokenPlusInvoiceId.ok, true);
  assert.equal(tokenPlusInvoiceId.invoice.public_token, TOKEN);
});

test('public response is allowlisted and strips internals', async () => {
  const client = mockClient({ invoices: [publicInvoiceRow()] });
  const result = await loadPublicInvoiceByToken(client, TOKEN);
  assert.deepEqual(Object.keys(result.invoice).sort(), [...PUBLIC_INVOICE_RESPONSE_KEYS].sort());
  assert.deepEqual(Object.keys(result.tenant).sort(), [...PUBLIC_TENANT_RESPONSE_KEYS].sort());
  for (const key of PUBLIC_INVOICE_FORBIDDEN_KEYS) {
    assert.equal(Object.hasOwn(result.invoice, key), false, key);
  }
  assert.equal(result.invoice.moov_invoice_id, undefined);
  assert.equal(result.invoice.tenant_id, undefined);
  assert.equal(result.invoice.provider_metadata, undefined);
});

test('public endpoint is read-only and cannot change status, mark paid, or move money', async () => {
  const client = mockClient({ invoices: [publicInvoiceRow()] });
  const deps = publicDeps(client);
  const writes = ['send', 'resend', 'cancel', 'delete', 'sync', 'mark_paid', 'pay', 'transfer', 'ach', 'wallet', 'create_transfer'];
  for (const action of writes) {
    const result = await handlePublicInvoice({
      httpMethod: 'POST',
      body: JSON.stringify({ token: TOKEN, action }),
    }, deps);
    assert.equal(result.ok, false, action);
    assert.equal(result.statusCode, 405);
    assert.equal(result.error, 'public_invoice_read_only');
  }
  const patch = await handlePublicInvoice({
    httpMethod: 'PATCH',
    body: JSON.stringify({ token: TOKEN, status: 'paid', paid_amount: 500 }),
  }, deps);
  assert.equal(patch.statusCode, 405);
  assert.equal(client.store.invoices[0].status, 'unpaid');
  assert.equal(client.store.invoices[0].paid_amount, 0);
});

test('public token lifecycle: draft, unpaid, canceled, paid remain retrievable; deleted does not', async () => {
  const canceled = publicInvoiceRow({
    id: INV_CANCELED,
    status: 'canceled',
    public_token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  const draftRow = publicInvoiceRow({
    id: INV_DRAFT,
    status: 'draft',
    sent_at: null,
    public_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  });
  const paidRow = publicInvoiceRow({
    id: INV_PAID,
    status: 'paid',
    paid_amount: 500,
    paid_at: '2026-10-05T00:00:00Z',
    public_token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  });
  const unpaidRow = publicInvoiceRow({ public_token: TOKEN });
  const client = mockClient({ invoices: [draftRow, unpaidRow, canceled, paidRow] });

  const draftResult = await loadPublicInvoiceByToken(client, draftRow.public_token);
  assert.equal(draftResult.invoice.status, 'draft');

  const unpaidResult = await loadPublicInvoiceByToken(client, TOKEN);
  assert.equal(unpaidResult.invoice.status, 'unpaid');

  const canceledResult = await loadPublicInvoiceByToken(client, canceled.public_token);
  assert.equal(canceledResult.ok, true);
  assert.equal(canceledResult.invoice.status, 'canceled');
  assert.equal(canceledResult.invoice.paid_amount, 0);

  const paidResult = await loadPublicInvoiceByToken(client, paidRow.public_token);
  assert.equal(paidResult.invoice.status, 'paid');
  assert.equal(paidResult.invoice.paid_amount, 500);

  client.store.invoices = client.store.invoices.filter((row) => row.id !== INV_CANCELED);
  const afterDelete = await loadPublicInvoiceByToken(client, canceled.public_token);
  assert.equal(afterDelete.ok, false);
  assert.equal(afterDelete.statusCode, 404);
});

test('invoice UI restores Send/Resend and claims email only after provider success', () => {
  const tab = sourceOf('src/pages/payments/InvoicesTab.tsx');
  const hook = sourceOf('src/hooks/useMoovInvoices.ts');
  const page = sourceOf('src/pages/PublicInvoicePage.tsx');
  assert.match(tab, /Send invoice/);
  assert.match(tab, /Resend invoice/);
  assert.match(tab, /Footer: "\{branding\.invoice_footer_note\}"/);
  assert.match(hook, /action: "resend"/);
  assert.match(hook, /data\?\.emailed === true && data\?\.liveProviderCalled === true/);
  assert.doesNotMatch(hook, /Invoice issued\. Copy or open the payment link/);
  assert.match(page, /Sent on /);
  assert.match(page, /payment_link_url/);
  assert.match(page, /Pay now/);
});

test('public lookup SQL is exact token equality and handler source stays read-only', () => {
  const src = sourceOf('aws/functions/api/invoice-actions.mjs');
  const publicSrc = sourceOf('aws/functions/api/public-invoice.mjs');
  const onboard = sourceOf('aws/functions/api/providers/parity/moov-onboard.mjs');
  assert.match(src, /WHERE public_token = \$1::uuid/);
  assert.doesNotMatch(src, /public_token::text LIKE|public_token ILIKE|WHERE id = \$1.*public_token/);
  assert.match(src, /generatePublicToken|randomUUID/);
  assert.match(publicSrc, /body\.token/);
  assert.doesNotMatch(publicSrc, /body\.invoice_id/);
  assert.match(publicSrc, /public_invoice_read_only/);
  assert.doesNotMatch(onboard, /body\.token \|\| body\.invoice_id/);
  assert.doesNotMatch(publicSrc, /createTransfer|moovFetch|api\.moov\.io/);
  assert.match(publicSrc, /'mark_paid'/);
});

test('invoice wrap no longer forces fetchImpl null or liveProviderCalled false', () => {
  const wrap = sourceOf('aws/functions/api/providers/parity/moov-functions.mjs');
  assert.doesNotMatch(wrap, /name === 'moov-invoice'/);
  assert.match(wrap, /moovParityContext/);
  assert.match(wrap, /withIdentityWrite/);
  assert.doesNotMatch(wrap, /fetchImpl: null/);
});

test('event-log SAVEPOINT contract is restored and SQL 43 stays INSERT-only', () => {
  const db = sourceOf('aws/functions/api/providers/parity/db.mjs');
  const sql43 = sourceOf('aws/rls/sql/43_payment_event_log_write.sql');
  assert.match(db, /SAVEPOINT payment_event_log/);
  assert.match(db, /ROLLBACK TO SAVEPOINT payment_event_log/);
  assert.match(sql43, /CREATE POLICY aws_write_payment_event_log/);
  assert.match(sql43, /FOR INSERT TO authenticated/);
  assert.match(sql43, /aws_can_write_tenant\(tenant_id\)/);
  assert.doesNotMatch(sql43, /FOR ALL|DISABLE ROW LEVEL SECURITY|aws_can_write_tenant\s*=/);
});

test('master provider flags are not silently enabled in recovered invoice source', () => {
  const provider = sourceOf('aws/functions/api/invoice-provider.mjs');
  const flags = sourceOf('aws/functions/api/provider-flags.mjs');
  const sandbox = sourceOf('aws/functions/api/sandbox-flags.mjs');
  assert.doesNotMatch(provider, /AWS_MOOV_ENABLED\s*=\s*['"]true['"]/);
  assert.doesNotMatch(provider, /AWS_PROVIDER_EXECUTION_ENABLED\s*=\s*['"]true['"]/);
  assert.match(flags, /providerExecutionEnabled/);
  assert.match(sandbox, /AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED/);
});

test('accepted overlay and Payment History Type contracts stay out of invoice recovery', () => {
  const accounting = sourceOf('aws/functions/api/payment-accounting.mjs');
  assert.match(accounting, /list_recipient_overlays/);
  assert.match(accounting, /update_recipient_display/);
  assert.match(accounting, /ALLOWED_DISPLAY_TYPES/);
  assert.doesNotMatch(accounting, /moov-invoice|runInvoiceAction|runProviderInvoiceAction/);
});
