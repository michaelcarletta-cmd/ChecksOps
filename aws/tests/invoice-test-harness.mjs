import { randomUUID } from 'node:crypto';

export const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const FREEDOM_PROD = '60922058-7eca-4889-81dd-5720d7b9de96';
export const PLATFORM = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
export const STAGING_TENANT = 'a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074';
export const STAGING_ACCOUNT = '11111111-2222-4333-8444-555555555555';
export const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';

export const accountRow = (tenantId, environment, providerAccountId) => ({
  tenant_id: tenantId,
  provider: 'moov',
  environment,
  provider_account_id: providerAccountId,
  onboarding_status: 'verified',
  can_receive_payments: true,
});

export const ctxOf = (tenantId, environment, userId = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91') => ({
  tenantId,
  environment,
  userId,
  isAdmin: false,
  moovContext: { sandboxPlatformAccountId: PLATFORM, productionPlatformAccountId: PLATFORM },
});

export const lineItems = [{ name: 'INV3 fixture', unit_price: 1.5, quantity: 2 }];

const compact = (sql) => String(sql || '').replace(/\s+/g, ' ');

export function invoiceStore(seed = {}) {
  return {
    accounts: seed.accounts || [],
    tenants: seed.tenants || [],
    customers: seed.customers || [],
    invoices: seed.invoices || [],
    events: seed.events || [],
  };
}

export function fakeInvoiceClient(store) {
  return {
    query: async (sql, params = []) => {
      const text = compact(sql);
      if (text.includes('FROM public.payment_provider_accounts')) {
        const tenantId = params[0];
        const environment = params[1];
        const match = store.accounts.find((row) => row.tenant_id === tenantId && row.environment === environment);
        return { rows: match ? [match] : [] };
      }
      if (text.includes('invoice_letterhead_url')) {
        const match = store.tenants.find((row) => row.id === params[0]);
        return { rows: match ? [match] : [{}] };
      }
      if (text.includes('FROM public.moov_invoice_customers')) {
        const [tenantId, environment, email] = params;
        const match = store.customers.find((row) => (
          row.tenant_id === tenantId
          && row.environment === environment
          && String(row.email).toLowerCase() === String(email).toLowerCase()
        ));
        return { rows: match ? [match] : [] };
      }
      if (text.includes('INSERT INTO public.moov_invoice_customers')) {
        const row = {
          id: randomUUID(),
          tenant_id: params[0],
          environment: params[1],
          display_name: params[2],
          email: params[3],
          phone: params[4],
          customer_type: params[5],
          moov_account_id: params[6],
          created_by: params[7],
        };
        store.customers.push(row);
        return { rows: [row] };
      }
      if (text.includes('INSERT INTO public.moov_invoices')) {
        const row = {
          id: randomUUID(),
          tenant_id: params[0],
          environment: params[1],
          moov_account_id: params[2],
          moov_invoice_id: params[3],
          invoice_number: params[4],
          customer_id: params[5],
          customer_name: params[6],
          customer_email: params[7],
          customer_moov_account_id: params[8],
          description: params[9],
          line_items: JSON.parse(params[10] || '[]'),
          total_amount: params[11],
          paid_amount: params[12],
          status: params[13],
          invoice_date: params[14],
          due_date: params[15],
          payment_link_url: params[16],
          public_token: params[17],
          sent_at: params[18],
          claim_id: params[19],
          provider_metadata: JSON.parse(params[20] || '{}'),
          created_by: params[21],
        };
        store.invoices.push(row);
        return { rows: [row] };
      }
      if (text.includes('FROM public.moov_invoices WHERE id =') && text.includes('tenant_id')) {
        const match = store.invoices.find((row) => row.id === params[0] && row.tenant_id === params[1]);
        return { rows: match ? [match] : [] };
      }
      if (text.includes('FROM public.moov_invoices') && text.includes('moov_invoice_id IS NOT NULL')) {
        let rows = store.invoices.filter((row) => (
          row.tenant_id === params[0]
          && row.environment === params[1]
          && row.moov_invoice_id
        ));
        if (text.includes('AND id = $3')) {
          rows = rows.filter((row) => row.id === params[2]);
        } else {
          rows = rows.filter((row) => !['paid', 'canceled', 'void'].includes(row.status)).slice(0, 100);
        }
        return { rows };
      }
      if (text.includes('UPDATE public.moov_invoices') && text.includes("status = 'canceled'")) {
        const row = store.invoices.find((item) => item.id === params[0] && item.tenant_id === params[1]);
        if (!row) return { rows: [] };
        row.status = 'canceled';
        return { rows: [row] };
      }
      if (text.includes('UPDATE public.moov_invoices')) {
        const row = store.invoices.find((item) => item.id === params[0] && item.tenant_id === params[params.length - 1]);
        if (!row) return { rows: [] };
        if (text.includes('invoice_number')) {
          row.status = params[1];
          row.invoice_number = params[2];
          row.payment_link_url = params[3];
          row.sent_at = params[4];
          row.provider_metadata = JSON.parse(params[5] || '{}');
        } else {
          row.status = params[1];
          row.invoice_number = params[2];
          row.total_amount = params[3];
          row.paid_amount = params[4];
          row.payment_link_url = params[5];
          row.sent_at = params[6];
          row.paid_at = params[7];
          row.provider_metadata = JSON.parse(params[8] || '{}');
        }
        return { rows: [row] };
      }
      if (text.includes('DELETE FROM public.moov_invoices')) {
        store.invoices = store.invoices.filter((row) => !(row.id === params[0] && row.tenant_id === params[1]));
        return { rows: [] };
      }
      if (text.includes('INSERT INTO public.payment_event_log')) {
        store.events.push({
          environment: params[0],
          tenant_id: params[1],
          event_type: params[2],
          new_status: params[3],
          previous_status: params[4],
          provider_metadata: params[8],
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

export function recordingFetch(options = {}) {
  const calls = [];
  const invoiceById = new Map();
  let customers = 0;
  let invoices = 0;
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    let parsed = null;
    try { parsed = init.body ? JSON.parse(init.body) : null; } catch { parsed = init.body || null; }
    calls.push({ url: href, method, body: parsed, headers: init.headers || {} });

    if (href.includes('/oauth2/token')) {
      return jsonOk({ access_token: 'fixture-token', expires_in: 3600 });
    }
    if (options.errorFor && options.errorFor({ url: href, method, body: parsed })) {
      const err = options.errorFor({ url: href, method, body: parsed });
      return jsonRes(err.status || 400, err.body ?? { error: '' });
    }
    if (method === 'POST' && /\/accounts$/.test(href.replace(/\?.*$/, ''))) {
      customers += 1;
      return jsonOk({ accountID: `cust-${customers}` });
    }
    if (method === 'POST' && href.includes('/invoices') && !/invoices\/[^/]+$/.test(href)) {
      invoices += 1;
      const created = {
        invoiceID: `inv-${invoices}`,
        invoiceNumber: `INV-${invoices}`,
        status: 'draft',
        totalAmount: { valueDecimal: '3.00' },
        paidAmount: { valueDecimal: '0.00' },
        paymentLinkURL: `https://moov.example/pay/inv-${invoices}`,
      };
      invoiceById.set(created.invoiceID, created);
      return jsonOk(created);
    }
    if (method === 'PATCH' && /\/invoices\/([^/?]+)/.test(href)) {
      const id = href.match(/\/invoices\/([^/?]+)/)[1];
      const current = invoiceById.get(id) || { invoiceID: id };
      const next = {
        ...current,
        status: parsed?.status || 'unpaid',
        sentOn: '2026-09-28T18:00:00.000Z',
        paymentLinkURL: current.paymentLinkURL || `https://moov.example/pay/${id}`,
      };
      invoiceById.set(id, next);
      return jsonOk(next);
    }
    if (method === 'GET' && /\/invoices\/([^/?]+)/.test(href)) {
      const id = href.match(/\/invoices\/([^/?]+)/)[1];
      return jsonOk(invoiceById.get(id) || { invoiceID: id, status: 'unpaid', paidAmount: { valueDecimal: '0' } });
    }
    if (method === 'DELETE' && href.includes('/invoices/')) {
      return jsonOk({});
    }
    if (method === 'GET' && href.includes('/invoices')) {
      return jsonOk([]);
    }
    return jsonOk({});
  };
  return { calls, fetchImpl, invoiceById };
}

const jsonOk = (payload) => jsonRes(200, payload);
const jsonRes = (status, payload) => {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => text,
    headers: { get: () => null },
  };
};

export const sandboxMoovCtx = (fetchImpl) => ({
  environment: 'sandbox',
  sandboxPublicKey: 'pk_sandbox',
  sandboxSecretKey: 'sk_sandbox',
  sandboxOrigin: 'https://checksops.com',
  apiVersion: 'v2024.01.00',
  fetchImpl,
});
