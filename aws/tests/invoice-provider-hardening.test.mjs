/**
 * PR #1033 security review follow-ups for the invoice lifecycle and Platform Finance:
 * - M1: platform wallet / wallet-transaction / treasury list reads use the wallets read scope;
 * - M2: create / create_and_send carry an idempotency key (client request id or a derived
 *   tenant + payload key) and replay instead of creating twice; send refuses once sent_at is set;
 * - L2: recover only accepts a UUID-shaped moov_invoice_id;
 * - L3: a DB error is logged, the caller gets a fixed code;
 * - L4: claim_id must belong to the caller's tenant;
 * - L5: sync runs each row in a savepoint so one DB error does not abort the rest.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';
import { platformBank, platformTreasury } from '../functions/api/providers/parity/moov-onboard.mjs';
import {
  INVOICE_CREATE_WINDOW_MS,
  invoiceCreateRequestKey,
  runProviderInvoiceAction,
} from '../functions/api/invoice-provider.mjs';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '7a7a7a7a-1111-4222-8333-444444444444';
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const MERCHANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLATFORM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MOOV_INVOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const INVOICE_ROW = '55555555-5555-4555-8555-555555555555';
const CLAIM = '66666666-6666-4666-8666-666666666666';

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

/** Provider stand-in: the token is the granted scope, so each call shows the scope it used. */
const provider = (routes = []) => {
  const calls = [];
  let invoiceCount = 0;
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    const method = init.method || 'GET';
    const headers = init.headers || {};
    if (text.includes('/oauth2/token')) {
      const scope = new URLSearchParams(String(init.body)).get('scope');
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: scope, expires_in: 300 }) };
    }
    calls.push({
      url: text, method, body: init.body ? JSON.parse(init.body) : undefined,
      scope: String(headers.Authorization || '').replace(/^Bearer /, ''),
      idempotencyKey: headers['X-Idempotency-Key'] || null,
    });
    const hit = routes.find((r) => text.includes(r.match) && (!r.method || r.method === method));
    if (hit) {
      const body = typeof hit.body === 'function' ? hit.body({ url: text, method, init }) : hit.body;
      return { ok: (hit.status || 200) < 400, status: hit.status || 200, text: async () => JSON.stringify(body) };
    }
    if (method === 'POST' && /\/accounts$/.test(text)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ accountID: CUSTOMER_ACCOUNT }) };
    }
    if (method === 'POST' && /\/invoices$/.test(text)) {
      invoiceCount += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ invoiceID: `${MOOV_INVOICE.slice(0, -1)}${invoiceCount}`, status: 'draft', invoiceNumber: `INV-${invoiceCount}` }) };
    }
    if (method === 'PATCH') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ invoiceID: MOOV_INVOICE, status: 'unpaid', sentOn: '2026-10-18T00:00:00Z' }) };
    }
    return { ok: true, status: 200, text: async () => '[]' };
  };
  return { fetchImpl, calls };
};

/** In-memory moov_invoices with the queries invoice-provider.mjs makes. */
const store = ({ invoices = [], claims = [], failInsert = null, failUpdateFor = null } = {}) => {
  const calls = [];
  const rows = [...invoices];
  const client = {
    calls,
    rows,
    query: async (sql, params = []) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(text.trim())) return { rows: [] };
      if (/FROM public\.payment_provider_accounts/.test(text)) {
        return { rows: [{ tenant_id: TENANT, provider: 'moov', environment: 'sandbox', provider_account_id: MERCHANT }] };
      }
      if (/FROM public\.tenants/.test(text)) return { rows: [{ invoice_footer_note: null }] };
      if (/FROM public\.claims/.test(text)) {
        assert.match(text, /c\.org_id = \$2::uuid/);
        assert.doesNotMatch(text, /c\.tenant_id|WHERE id = \$1::uuid AND tenant_id/);
        return { rows: claims.filter((c) => c.id === params[0] && c.org_id === params[1]).map(() => ({ '?column?': 1 })) };
      }
      if (/FROM public\.moov_invoice_customers/.test(text)) return { rows: [] };
      if (/INSERT INTO public\.moov_invoice_customers/.test(text)) return { rows: [{ id: '77777777-7777-4777-8777-777777777777' }] };
      if (/checksops_request_ref/.test(text) && /^\s*SELECT/.test(text)) {
        return { rows: rows.filter((r) => r.tenant_id === params[0] && r.environment === params[1] && r.provider_metadata?.checksops_request_ref === params[2]) };
      }
      if (/INSERT INTO public\.moov_invoices/.test(text)) {
        if (failInsert) throw failInsert;
        const row = {
          id: `88888888-8888-4888-8888-88888888888${rows.length}`,
          tenant_id: params[0], environment: params[1], moov_account_id: params[2], moov_invoice_id: params[3],
          status: params[13], sent_at: params[18], claim_id: params[19], provider_metadata: JSON.parse(params[20]),
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (/SELECT \* FROM public\.moov_invoices WHERE id = \$1::uuid AND tenant_id = \$2::uuid/.test(text)) {
        return { rows: rows.filter((r) => r.id === params[0] && r.tenant_id === params[1]) };
      }
      if (/SELECT \* FROM public\.moov_invoices/.test(text)) {
        return { rows: rows.filter((r) => r.tenant_id === params[0] && r.environment === params[1]) };
      }
      if (/UPDATE public\.moov_invoices/.test(text)) {
        if (failUpdateFor && params[0] === failUpdateFor) {
          throw Object.assign(new Error('permission denied for table moov_invoices (secret detail)'), { code: '42501' });
        }
        return { rows: rows.filter((r) => r.id === params[0]) };
      }
      return { rows: [] };
    },
  };
  return client;
};

const act = (client, body, fetchImpl) => {
  resetMoovTokenCache();
  return withMoovContext(sandboxMoov(fetchImpl), () => runProviderInvoiceAction({
    client,
    body,
    fetchImpl,
    ctx: { environment: 'sandbox', tenantId: TENANT, userId: USER },
  }));
};

const CREATE = {
  customer_name: 'Pat Customer',
  customer_email: 'pat@example.com',
  line_items: [{ name: 'Roof', unit_price: 100, quantity: 1 }],
};

// --- M1 ------------------------------------------------------------------

const platformRoutes = [
  { match: `/accounts/${PLATFORM_ID}/wallets/wallet-1/transactions`, body: [] },
  { match: `/accounts/${PLATFORM_ID}/wallets`, body: [{ walletID: 'wallet-1', walletType: 'default', availableBalance: { valueDecimal: '1.00', currency: 'USD' } }] },
];
const ownerClient = () => ({ query: async (sql) => (/is_platform_owner\(\)/.test(sql) ? { rows: [{ is_owner: true }] } : { rows: [] }) });
const runPlatform = (handler, body, fetchImpl) => {
  resetMoovTokenCache();
  const moovContext = sandboxMoov(fetchImpl);
  return withMoovContext(moovContext, () => handler.run({
    client: ownerClient(), body, fetchImpl, ctx: { environment: 'sandbox', tenantId: null, userId: USER, moovContext },
  }));
};

test('M1: platform wallet, wallet transactions and treasury list use the wallets read scope', async () => {
  const walletsRead = `/accounts/${PLATFORM_ID}/wallets.read`;
  for (const [handler, action] of [[platformBank, 'wallet'], [platformTreasury, 'wallet'], [platformTreasury, 'overview']]) {
    const { fetchImpl, calls } = provider(platformRoutes);
    const result = await runPlatform(handler, { action }, fetchImpl);
    assert.equal(result.success, true, JSON.stringify(result));
    const walletCalls = calls.filter((c) => c.url.includes('/wallets'));
    assert.ok(walletCalls.some((c) => c.url.includes('/transactions')), action);
    for (const call of walletCalls) assert.equal(call.scope, walletsRead, call.url);
  }
  const { fetchImpl, calls } = provider(platformRoutes);
  const listed = await runPlatform(platformTreasury, { action: 'list' }, fetchImpl);
  assert.equal(listed.success, true);
  assert.deepEqual(calls.map((c) => c.scope), [walletsRead]);
});

// --- M2 ------------------------------------------------------------------

test('M2: create passes an idempotency key on every provider write, bound to tenant and request id', async () => {
  const client = store();
  const { fetchImpl, calls } = provider();
  const result = await act(client, { action: 'create_and_send', request_id: 'req-12345678', ...CREATE }, fetchImpl);
  assert.equal(result.success, true, JSON.stringify(result));
  const writes = calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(writes.map((c) => c.method), ['POST', 'POST', 'PATCH']);
  for (const call of writes) assert.match(call.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(writes.map((c) => c.idempotencyKey)).size, 3);
  // The request id never reaches the provider as-is (a UUID request id would otherwise be used verbatim).
  const uuidReq = '12345678-1234-4234-8234-123456789012';
  const other = provider();
  await act(store(), { action: 'create', request_id: uuidReq, ...CREATE }, other.fetchImpl);
  assert.ok(other.calls.every((c) => c.idempotencyKey !== uuidReq));
  // Another tenant with the same request id gets different provider keys.
  const a = invoiceCreateRequestKey({ tenantId: TENANT, action: 'create', body: { request_id: 'req-12345678' } });
  const b = invoiceCreateRequestKey({ tenantId: OTHER_TENANT, action: 'create', body: { request_id: 'req-12345678' } });
  assert.notEqual(a.key, b.key);
  assert.equal(client.rows[0].provider_metadata.checksops_request_ref.length, 64);
});

test('M2: a double create (same request id, or same payload without one) creates one provider invoice', async () => {
  for (const body of [{ action: 'create', request_id: 'req-abcdefgh', ...CREATE }, { action: 'create', ...CREATE }]) {
    const client = store();
    const { fetchImpl, calls } = provider();
    const first = await act(client, body, fetchImpl);
    const second = await act(client, body, fetchImpl);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(second.idempotent, true);
    assert.equal(second.liveProviderCalled, false);
    assert.equal(second.invoice.id, first.invoice.id);
    assert.equal(calls.filter((c) => c.method === 'POST' && /\/invoices$/.test(c.url)).length, 1);
    assert.equal(client.rows.length, 1);
  }
  // A different request id is a different invoice.
  const client = store();
  const { fetchImpl, calls } = provider();
  await act(client, { action: 'create', request_id: 'req-11111111', ...CREATE }, fetchImpl);
  await act(client, { action: 'create', request_id: 'req-22222222', ...CREATE }, fetchImpl);
  assert.equal(calls.filter((c) => c.method === 'POST' && /\/invoices$/.test(c.url)).length, 2);
  // A malformed request id is refused before any provider call.
  const bad = provider();
  const refused = await act(store(), { action: 'create', request_id: 'x', ...CREATE }, bad.fetchImpl);
  assert.equal(refused.statusCode, 400);
  assert.equal(bad.calls.length, 0);
});

test('M2: the derived key is deterministic per tenant + payload within the window, and differs outside it', () => {
  const items = [{ name: 'Roof', unit_price: 100, quantity: 1 }];
  const now = 1_800_000_000_000;
  const key = (extra = {}) => invoiceCreateRequestKey({ tenantId: TENANT, action: 'create', body: { ...CREATE, ...extra.body }, items: extra.items || items, now: extra.now ?? now }).key;
  assert.equal(key(), key());
  assert.equal(key({ body: { customer_email: 'PAT@example.com ' } }), key());
  assert.notEqual(key({ items: [{ name: 'Roof', unit_price: 101, quantity: 1 }] }), key());
  assert.notEqual(key({ body: { due_date: '2026-11-01' } }), key());
  assert.notEqual(invoiceCreateRequestKey({ tenantId: OTHER_TENANT, action: 'create', body: CREATE, items, now }).key, key());
  assert.notEqual(invoiceCreateRequestKey({ tenantId: TENANT, action: 'create_and_send', body: CREATE, items, now }).key, key());
  assert.notEqual(key({ now: now + INVOICE_CREATE_WINDOW_MS }), key());
});

test('M2: send refuses an invoice that was already sent (resend is the path for that)', async () => {
  const sentRow = {
    id: INVOICE_ROW, tenant_id: TENANT, environment: 'sandbox', moov_invoice_id: MOOV_INVOICE,
    status: 'unpaid', sent_at: '2026-10-17T00:00:00Z', provider_metadata: {},
  };
  {
    const client = store({ invoices: [sentRow] });
    const { fetchImpl, calls } = provider();
    const result = await act(client, { action: 'send', invoice_id: INVOICE_ROW }, fetchImpl);
    assert.equal(result.statusCode, 409, JSON.stringify(result));
    assert.equal(result.error, 'invoice_already_sent');
    assert.equal(calls.length, 0);
    assert.equal(client.calls.some((c) => /UPDATE public\.moov_invoices/.test(c.sql)), false);
  }
  {
    const client = store({ invoices: [sentRow] });
    const { fetchImpl, calls } = provider();
    const result = await act(client, { action: 'resend', invoice_id: INVOICE_ROW }, fetchImpl);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);
  }
  {
    const client = store({ invoices: [{ ...sentRow, status: 'draft', sent_at: null }] });
    const { fetchImpl, calls } = provider();
    const result = await act(client, { action: 'send', invoice_id: INVOICE_ROW }, fetchImpl);
    assert.equal(result.success, true, JSON.stringify(result));
    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 1);
    // A first send carries a key per invoice, so two racing sends are one provider send.
    assert.ok(patches[0].idempotencyKey, 'send PATCH has an idempotency key');
    const again = provider();
    await act(store({ invoices: [{ ...sentRow, status: 'draft', sent_at: null }] }), { action: 'send', invoice_id: INVOICE_ROW }, again.fetchImpl);
    assert.equal(again.calls.find((c) => c.method === 'PATCH').idempotencyKey, patches[0].idempotencyKey);
  }
});

// --- L2-L5 ---------------------------------------------------------------

test('L2: recover refuses a moov_invoice_id that is not UUID-shaped, before any DB or provider call', async () => {
  for (const id of ['moov-inv-1', '../invoices', `${MOOV_INVOICE}/x`, "' OR 1=1 --"]) {
    const client = store();
    const { fetchImpl, calls } = provider();
    const result = await act(client, { action: 'recover', moov_invoice_id: id }, fetchImpl);
    assert.equal(result.statusCode, 400, id);
    assert.equal(calls.length, 0, id);
    assert.equal(client.calls.some((c) => /moov_invoices/.test(c.sql)), false, id);
  }
});

test('L3: a persist failure returns a fixed code, not the DB error text', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const failInsert = Object.assign(new Error('duplicate key value violates unique constraint "moov_invoices_provider_uidx" DETAIL: secret'), { code: '23505' });
    const client = store({ failInsert });
    const { fetchImpl } = provider();
    const result = await act(client, { action: 'create', ...CREATE }, fetchImpl);
    assert.equal(result.statusCode, 500);
    assert.equal(result.persistError, 'invoice_persist_failed');
    assert.equal(JSON.stringify(result).includes('duplicate key'), false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.ok(errors.some((args) => JSON.stringify(args).includes('duplicate key')), 'logged server-side');
    // An unexpected DB error elsewhere is generic too.
    const broken = { query: async (sql) => { if (/payment_provider_accounts/.test(sql)) throw new Error('relation "x" does not exist'); return { rows: [] }; } };
    const generic = await act(broken, { action: 'list' }, fetchImpl);
    assert.equal(generic.statusCode, 500);
    assert.equal(generic.error_code, 'invoice_action_failed');
    assert.equal(JSON.stringify(generic).includes('relation'), false);
  } finally {
    console.error = original;
  }
});

test('L4: claim_id must belong to the caller tenant before anything is created', async () => {
  const claims = [{ id: CLAIM, org_id: OTHER_TENANT }];
  for (const claimId of [CLAIM, 'not-a-uuid']) {
    const client = store({ claims });
    const { fetchImpl, calls } = provider();
    const result = await act(client, { action: 'create', claim_id: claimId, ...CREATE }, fetchImpl);
    assert.ok(result.statusCode === 404 || result.statusCode === 400, JSON.stringify(result));
    assert.equal(calls.length, 0);
    assert.equal(client.rows.length, 0);
  }
  const client = store({ claims: [{ id: CLAIM, org_id: TENANT }] });
  const { fetchImpl } = provider();
  const result = await act(client, { action: 'create', claim_id: CLAIM, ...CREATE }, fetchImpl);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(client.rows[0].claim_id, CLAIM);
  const lookup = client.calls.find((c) => /FROM public\.claims/.test(c.sql));
  assert.match(lookup.sql, /tenant_id = \$2::uuid/);
  assert.deepEqual(lookup.params, [CLAIM, TENANT]);
});

test('L5: sync wraps each row in a savepoint; one DB error does not stop the rest', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const ids = ['91111111-1111-4111-8111-111111111111', '92222222-2222-4222-8222-222222222222', '93333333-3333-4333-8333-333333333333'];
    const invoices = ids.map((id, i) => ({ id, tenant_id: TENANT, environment: 'sandbox', moov_invoice_id: `${MOOV_INVOICE.slice(0, -1)}${i}`, status: 'unpaid', provider_metadata: {} }));
    const client = store({ invoices, failUpdateFor: ids[1] });
    const { fetchImpl } = provider([{ match: '/invoices/', method: 'GET', body: { status: 'unpaid', totalAmount: { valueDecimal: '1.00' } } }]);
    const result = await act(client, { action: 'sync' }, fetchImpl);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.synced, 2);
    assert.equal(result.failed, 1);
    const statements = client.calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 2).join(' '));
    assert.equal(statements.filter((s) => s === 'SAVEPOINT invoice_sync_row').length, 3);
    assert.equal(statements.filter((s) => s === 'RELEASE SAVEPOINT').length, 2);
    assert.equal(statements.filter((s) => s === 'ROLLBACK TO').length, 1);
    // The rollback comes right after the failed UPDATE, before the next row's savepoint.
    const failedAt = client.calls.findIndex((c) => /UPDATE public\.moov_invoices/.test(c.sql) && c.params[0] === ids[1]);
    assert.match(client.calls[failedAt + 1].sql, /ROLLBACK TO SAVEPOINT invoice_sync_row/);
    assert.equal(JSON.stringify(result).includes('permission denied'), false);
  } finally {
    console.error = original;
  }
});
