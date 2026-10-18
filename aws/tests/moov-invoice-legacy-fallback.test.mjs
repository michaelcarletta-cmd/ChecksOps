/**
 * Production bundle safety: the production Lambda has no invoice-actions.mjs /
 * invoice-provider.mjs / public-invoice.mjs until a rebuilt ZIP. A resolve hook
 * makes those imports fail with ERR_MODULE_NOT_FOUND (as in that bundle):
 * moov-invoice falls back to the legacy create/list port and public-invoice
 * refuses instead of failing to load.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const HOOK = `
const MISSING = /\\/(invoice-actions|invoice-provider|public-invoice)\\.mjs$/;
export async function resolve(specifier, context, nextResolve) {
  if (MISSING.test(specifier)) {
    return nextResolve(specifier.replace(/\\.mjs$/, '.absent-from-bundle.mjs'), context);
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`);

const { resetMoovTokenCache, withMoovContext } = await import('../functions/api/providers/parity/moov-client.mjs');
const { invoice, publicInvoice } = await import('../functions/api/providers/parity/moov-onboard.mjs');
const { runParityHandler } = await import('../functions/api/providers/parity/dispatch.mjs');

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const MERCHANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = '9b2f3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d';

const fakeClient = () => {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      if (/FROM public\.payment_provider_accounts/.test(sql)) {
        return { rows: [{ tenant_id: TENANT, provider: 'moov', environment: 'sandbox', provider_account_id: MERCHANT }] };
      }
      return { rows: [] };
    },
  };
};

const recordedFetch = () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    const payload = String(url).includes('/oauth2/token')
      ? { access_token: 'tok', expires_in: 300 }
      : (init.method === 'POST' ? { invoiceID: 'moov-inv-1', status: 'draft' } : [{ invoiceID: 'moov-inv-1' }]);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
};

const run = (body) => {
  resetMoovTokenCache();
  const client = fakeClient();
  const { fetchImpl, calls } = recordedFetch();
  const moovContext = {
    environment: 'sandbox', sandboxPublicKey: 'pk', sandboxSecretKey: 'sk', apiVersion: 'v2024.01.00', fetchImpl,
  };
  return withMoovContext(moovContext, async () => ({
    result: await invoice.run({ client, body, fetchImpl, ctx: { tenantId: TENANT, userId: 'u', environment: 'sandbox', moovContext } }),
    client,
    calls,
  }));
};

test('the lifecycle modules really are unresolvable under the hook', async () => {
  await assert.rejects(import('../functions/api/invoice-actions.mjs'), { code: 'ERR_MODULE_NOT_FOUND' });
});

test('moov-invoice falls back to the legacy create / list port without invoice-actions.mjs', async () => {
  {
    const { result, calls } = await run({ action: 'list' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.invoices, [{ invoiceID: 'moov-inv-1' }]);
    assert.ok(calls.some((c) => c.method === 'GET' && c.url.endsWith(`/accounts/${MERCHANT}/invoices`)));
  }
  {
    const { result, calls } = await run({ line_items: [{ name: 'Roof', unit_price: 100 }] });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.invoice.invoiceID, 'moov-inv-1');
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/accounts/${MERCHANT}/invoices`)));
  }
});

test('lifecycle-only actions are refused (not turned into a legacy create) without invoice-actions.mjs', async () => {
  for (const action of ['send', 'resend', 'cancel', 'delete', 'sync', 'recover', 'create_and_send', 'preflight']) {
    const { result, calls, client } = await run({ action, invoice_id: '55555555-5555-4555-8555-555555555555', line_items: [{ name: 'x', unit_price: 1 }] });
    assert.equal(result.statusCode, 503, action);
    assert.equal(result.error, 'invoice_lifecycle_unavailable', action);
    assert.equal(calls.length, 0, action);
    assert.equal(client.calls.length, 0, action);
  }
});

test('public invoice refuses cleanly without public-invoice.mjs / invoice-actions.mjs', async () => {
  const wrapped = await runParityHandler('public-invoice', {
    headers: {},
    body: JSON.stringify({ token: TOKEN }),
    requestContext: { http: { method: 'POST' } },
  }, { createClient: () => { throw new Error('no DB expected'); } });
  assert.equal(wrapped.statusCode, 503);
  assert.equal(wrapped.error, 'public_invoice_unavailable');

  const client = fakeClient();
  const direct = await publicInvoice.run({ client, body: { token: TOKEN } });
  assert.equal(direct.statusCode, 503);
  assert.equal(direct.error, 'public_invoice_unavailable');
  assert.equal(client.calls.length, 0);
});
