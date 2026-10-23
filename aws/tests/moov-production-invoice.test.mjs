import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { scrubInvoiceResult, scrubVendorText } from '../functions/api/providers/production/moov-invoice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '9b1f3c55-1111-4222-8333-444455556666';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const INVOICE_ROW = '7d1e2f3a-4b5c-4d6e-8f70-112233445566';
const MOOV_INVOICE = '11111111-2222-4333-8444-555555555555';

// Production-prep: execution flags on, sandbox execution off (as live).
const FLAGS = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const invoiceEvent = (body) => ({
  rawPath: '/functions/v1/moov-invoice',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'production',
    http: { method: 'POST', path: '/functions/v1/moov-invoice' },
    authorizer: { jwt: { claims: { sub: SUB, email: 'tester@example.com', token_use: 'id' } } },
  },
});

const fakeDb = ({
  tenantEnv = 'production',
  account = { tenant_id: TENANT, environment: 'production', provider_account_id: 'merchant-acct', onboarding_status: 'active' },
  invoices = [],
} = {}) => {
  const log = [];
  const inserted = { invoices: [], customers: [], events: [] };
  const client = {
    log,
    inserted,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      log.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) {
        return { command: sql.split(' ')[0], rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{}] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === SUB ? [{ application_user_id: APP_USER, cognito_sub: SUB, email: 'tester@example.com', status: 'active' }] : [] };
      }
      if (sql.includes('FROM public.tenant_users')) {
        return { rows: [{ tenant_id: TENANT, role: 'member', tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
      }
      if (sql.includes('FROM public.user_roles')) return { rows: [] };
      if (sql.includes('moov_allowlisted, moov_environment')) return { rows: [{ moov_allowlisted: true, moov_environment: tenantEnv }] };
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: account && params[0] === account.tenant_id && params[1] === account.environment ? [account] : [] };
      }
      if (sql.includes("provider_metadata->>'checksops_request_ref'")) return { rows: [] };
      if (sql.includes('invoice_letterhead_url, invoice_footer_note')) return { rows: [{ invoice_footer_note: null }] };
      if (sql.includes('FROM public.moov_invoice_customers')) return { rows: [] };
      if (sql.includes('INSERT INTO public.moov_invoice_customers')) {
        inserted.customers.push(params);
        return { rows: [{ id: 'customer-row' }] };
      }
      if (sql.includes('INSERT INTO public.moov_invoices')) {
        const row = { id: INVOICE_ROW, tenant_id: params[0], environment: params[1], moov_invoice_id: params[3], status: params[13] };
        inserted.invoices.push({ params, row });
        return { rows: [row] };
      }
      if (sql.includes('SELECT * FROM public.moov_invoices WHERE id = $1::uuid AND tenant_id = $2::uuid')) {
        return { rows: invoices.filter((r) => r.id === params[0] && r.tenant_id === params[1]) };
      }
      if (sql.includes('UPDATE public.moov_invoices')) {
        const row = invoices.find((r) => r.id === params[0]);
        return { rows: row ? [{ ...row, status: params[1], sent_at: params[4] }] : [] };
      }
      if (sql.includes('INSERT INTO public.payment_event_log')) {
        inserted.events.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return client;
};

const providerStub = ({ invoiceError = null } = {}) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const host = String(url).match(/^https:\/\/[^/]+/)?.[0];
    const p = String(url).replace(/^https:\/\/[^/]+/, '').split('?')[0];
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = String(init.body); }
    calls.push({ method, host, path: p, headers: init.headers || {}, body });
    const reply = (status, b) => ({ ok: status < 400, status, text: async () => JSON.stringify(b) });
    if (p.includes('/oauth2/token')) return reply(200, { access_token: 't', expires_in: 300 });
    if (method === 'POST' && p === '/accounts') return reply(200, { accountID: 'customer-acct' });
    if (method === 'POST' && p === '/accounts/merchant-acct/invoices') {
      if (invoiceError) return reply(invoiceError.status, invoiceError.body);
      return reply(200, { invoiceID: MOOV_INVOICE, invoiceNumber: 'INV-1', status: 'draft', totalAmount: { valueDecimal: '125.00' } });
    }
    if (method === 'PATCH' && p === `/accounts/merchant-acct/invoices/${MOOV_INVOICE}`) {
      return reply(200, { invoiceID: MOOV_INVOICE, invoiceNumber: 'INV-1', status: 'unpaid', paymentLinkURL: 'https://pay.example/x', sentOn: '2026-10-22T19:30:00Z', totalAmount: { valueDecimal: '125.00' } });
    }
    return reply(500, { message: `unexpected ${method} ${p}` });
  };
  return { calls, impl, writes: () => calls.filter((c) => c.method !== 'GET' && !c.path.includes('/oauth2/token')) };
};

const run = (client, provider, body) => handleProviderRequest(
  invoiceEvent(body),
  '/functions/v1/moov-invoice',
  'POST',
  {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk', MOOV_SECRET_KEY: 'sk', MOOV_ACCOUNT_ID: 'platform-acct' }),
    // Staging-only sandbox credentials must never be read in production.
    loadSandboxCredentials: async () => { throw new Error('sandbox credentials read in production'); },
    fetchImpl: provider.impl,
  },
);

const CREATE_AND_SEND = {
  action: 'create_and_send',
  tenant_id: TENANT,
  customer_name: 'Acme Roofing',
  customer_email: 'billing@acme.example',
  customer_type: 'business',
  line_items: [{ name: 'Inspection', unit_price: 125, quantity: 1 }],
  send: true,
};

test('production create_and_send is no longer production_execution_blocked: it creates and emails the invoice', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const provider = providerStub();
    const result = await run(client, provider, CREATE_AND_SEND);
    assert.notEqual(result.error, 'production_execution_blocked', JSON.stringify(result));
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.emailed, true);
    assert.equal(result.environment, 'production');
    assert.equal(result.liveProviderCalled, true);

    // Production host and production credentials only.
    assert.ok(provider.calls.length > 0);
    for (const call of provider.calls) assert.equal(call.host, 'https://api.moov.io', call.path);
    const token = provider.calls.find((c) => c.path.includes('/oauth2/token'));
    assert.equal(token.headers.Authorization, `Basic ${Buffer.from('pk:sk').toString('base64')}`);

    const writes = provider.writes().map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(writes, [
      'POST /accounts',
      'POST /accounts/merchant-acct/invoices',
      `PATCH /accounts/merchant-acct/invoices/${MOOV_INVOICE}`,
    ]);
    const patch = provider.writes()[2];
    assert.deepEqual(patch.body, { status: 'unpaid' });
    assert.equal(patch.headers['x-moov-version'], 'v2026.07.00');

    // Rows are written for environment='production' only.
    assert.equal(client.inserted.invoices.length, 1);
    assert.equal(client.inserted.invoices[0].row.environment, 'production');
    assert.equal(client.inserted.invoices[0].row.tenant_id, TENANT);
    assert.equal(client.inserted.customers[0][1], 'production');
    // No sandbox account lookup.
    const accountReads = client.log.filter((q) => q.sql.includes('FROM public.payment_provider_accounts'));
    assert.ok(accountReads.length > 0);
    for (const q of accountReads) assert.equal(q.params[1], 'production');
  });
});

test('production send of a draft PATCHes it to unpaid at the provider', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({
      invoices: [{ id: INVOICE_ROW, tenant_id: TENANT, environment: 'production', moov_invoice_id: MOOV_INVOICE, status: 'draft', sent_at: null }],
    });
    const provider = providerStub();
    const result = await run(client, provider, { action: 'send', tenant_id: TENANT, invoice_id: INVOICE_ROW });
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(result.emailed, true);
    assert.deepEqual(provider.writes().map((c) => `${c.method} ${c.path}`), [`PATCH /accounts/merchant-acct/invoices/${MOOV_INVOICE}`]);
  });
});

test('a tenant that is not a production payment tenant fails closed before any provider call', async () => {
  await withEnv(FLAGS, async () => {
    const provider = providerStub();
    const result = await run(fakeDb({ tenantEnv: 'sandbox' }), provider, CREATE_AND_SEND);
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, 'production_provider_context_unresolved');
    assert.equal(provider.calls.length, 0);
  });
});

test('a production tenant without a production payment account fails closed before any provider call', async () => {
  await withEnv(FLAGS, async () => {
    const provider = providerStub();
    const result = await run(fakeDb({ account: null }), provider, CREATE_AND_SEND);
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, 'production_provider_context_unresolved');
    assert.equal(provider.calls.length, 0);
  });
});

test('another tenant id is refused and nothing reaches the provider', async () => {
  await withEnv(FLAGS, async () => {
    const provider = providerStub();
    const result = await run(fakeDb(), provider, { ...CREATE_AND_SEND, tenant_id: OTHER_TENANT });
    assert.equal(result.ok, false);
    assert.ok(result.statusCode === 403 || result.statusCode === 404, JSON.stringify(result));
    assert.equal(provider.calls.length, 0);
  });
});

test('a provider refusal answers in plain words without naming the payment provider', async () => {
  await withEnv(FLAGS, async () => {
    const provider = providerStub({ invoiceError: { status: 422, body: { error: 'Moov invoicing is not enabled for this Moov account' } } });
    const client = fakeDb();
    const result = await run(client, provider, CREATE_AND_SEND);
    assert.equal(result.statusCode, 422, JSON.stringify(result));
    assert.equal(result.ok, false);
    assert.doesNotMatch(String(result.error), /moov/i);
    assert.match(String(result.error), /payment provider invoicing is not enabled/);
    assert.equal(client.inserted.invoices.length, 0);
  });
});

test('scrubVendorText replaces the vendor name in error and message only', () => {
  assert.equal(scrubVendorText('Moov rejected it'), 'payment provider rejected it');
  assert.equal(scrubVendorText('moov-invoice'), 'payment provider-invoice');
  assert.equal(scrubVendorText('removed'), 'removed');
  assert.equal(scrubVendorText(42), 42);
  const out = scrubInvoiceResult({ error: 'MOOV down', message: 'Ask Moov', moov_invoice_id: 'keep' });
  assert.deepEqual(out, { error: 'payment provider down', message: 'Ask payment provider', moov_invoice_id: 'keep' });
});

test('staging keeps the sandbox parity invoice path (production handler only when execution is allowed)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers.mjs'), 'utf8');
  assert.match(
    src,
    /name === 'moov-invoice' && executionAllowed\('moov'\)\) \{\s*const \{ handleProductionMoovInvoice \} = await import\('\.\/providers\/production\/moov-invoice\.mjs'\);/,
  );
  // The production invoice route sits before the production hard block.
  assert.ok(src.indexOf("name === 'moov-invoice'") < src.indexOf("error: 'production_execution_blocked'"));
});
