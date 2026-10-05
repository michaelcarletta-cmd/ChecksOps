/**
 * Provider-backed Invoice lifecycle recovered from INV3/INV6.
 * Create/reuse Moov customer → create Moov invoice → persist moov_invoices
 * with durable moov_invoice_id, payment_link_url, public_token, provider metadata.
 * Send/resend = PATCH { status: 'unpaid' } (the proven customer-email transition).
 * Sync = GET provider invoice and write status/paid_amount/paid_at from provider truth.
 * Does not grant RLS, disable RLS, or fall back to the 5480 local persist path.
 * Does not enable AWS_MOOV_ENABLED or AWS_PROVIDER_EXECUTION_ENABLED.
 */
import { fail, jsonResult } from './providers/parity/caller.mjs';
import { loadMoovAccount, logPaymentEvent, sanitize } from './providers/parity/db.mjs';
import { failClosedMissingAccount, requireMoovProviderEnvironment } from './providers/parity/moov-provider-env.mjs';
import { MoovError, moovFetch } from './providers/parity/moov-client.mjs';
import { generatePublicToken } from './invoice-actions.mjs';

export const INVOICE_API_VERSION = 'v2026.07.00';

export const INVOICE_PROVIDER_ACTIONS = new Set([
  'preflight',
  'list',
  'recover',
  'create',
  'create_and_send',
  'send',
  'resend',
  'sync',
  'cancel',
  'delete',
]);

const invoiceScopes = (accountID, write = false) => [
  `/accounts/${accountID}/invoices.${write ? 'write' : 'read'}`,
];

export function normalizeInvoiceLineItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return 'At least one line item is required';
  const items = [];
  for (const row of raw) {
    const name = String(row?.name ?? '').trim();
    const unit = Number(row?.unit_price);
    const qty = Number(row?.quantity ?? 1);
    if (!name) return 'Every line item needs a description';
    if (!Number.isFinite(unit) || unit <= 0) return `Enter a price greater than zero for "${name}"`;
    if (!Number.isFinite(qty) || qty <= 0) return `Enter a quantity greater than zero for "${name}"`;
    items.push({ name, unit_price: Math.round(unit * 100) / 100, quantity: Math.round(qty) });
  }
  if (items.length > 50) return 'An invoice can have at most 50 line items';
  return items;
}

export const invoiceLineItemsTotal = (items) =>
  Math.round(items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) * 100) / 100;

export const invoiceMoney = (value) => ({ currency: 'USD', valueDecimal: Number(value).toFixed(2) });

const invoiceDecimal = (amount) => (amount?.valueDecimal != null ? Number(amount.valueDecimal) : 0);

export function splitInvoiceCustomerName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? name,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : parts[0] ?? name,
  };
}

const pushInvoiceErrorPart = (parts, value) => {
  if (value == null) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) parts.push(trimmed);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    parts.push(String(value));
    return;
  }
  if (typeof value === 'object') {
    try {
      const encoded = JSON.stringify(sanitize(value));
      if (encoded && encoded !== '{}' && encoded !== '[]') parts.push(encoded.slice(0, 300));
    } catch { /* ignore */ }
  }
};

export function invoiceProviderErrorMessage(error, fallback = 'Payment provider rejected the invoice request') {
  const status = Number(error?.status || error?.statusCode || 0);
  const body = error?.body;
  const parts = [];
  pushInvoiceErrorPart(parts, error?.message);
  if (body && typeof body === 'object') {
    pushInvoiceErrorPart(parts, body.error);
    pushInvoiceErrorPart(parts, body.message);
    if (Array.isArray(body.errors)) {
      for (const item of body.errors) pushInvoiceErrorPart(parts, item);
    } else if (body.errors && typeof body.errors === 'object') {
      for (const [key, value] of Object.entries(body.errors)) {
        pushInvoiceErrorPart(parts, `${key}: ${typeof value === 'string' ? value : JSON.stringify(sanitize(value))}`);
      }
    }
  } else {
    pushInvoiceErrorPart(parts, body);
  }
  const unique = [...new Set(parts.filter(Boolean))];
  const message = unique[0] || (status ? `${fallback} (HTTP ${status})` : fallback);
  return String(message).slice(0, 400);
}

const loadInvoiceBranding = async (client, tenantId) => (
  await client.query(
    `SELECT invoice_letterhead_url, invoice_footer_note, invoice_default_terms
     FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
    [tenantId],
  )
).rows[0] || null;

const loadInvoiceCustomer = async (client, tenantId, environment, email) => (
  await client.query(
    `SELECT id, moov_account_id FROM public.moov_invoice_customers
     WHERE tenant_id = $1::uuid AND environment = $2 AND lower(email) = lower($3)
     LIMIT 1`,
    [tenantId, environment, email],
  )
).rows[0] || null;

const loadInvoiceCustomerByAccount = async (client, tenantId, environment, moovAccountId) => {
  if (!moovAccountId) return null;
  return (await client.query(
    `SELECT id, moov_account_id FROM public.moov_invoice_customers
     WHERE tenant_id = $1::uuid AND environment = $2 AND moov_account_id = $3
     LIMIT 1`,
    [tenantId, environment, moovAccountId],
  )).rows[0] || null;
};

const loadInvoiceByMoovId = async (client, tenantId, moovInvoiceId) => {
  if (!moovInvoiceId) return null;
  return (await client.query(
    `SELECT * FROM public.moov_invoices
     WHERE tenant_id = $1::uuid AND moov_invoice_id = $2
     LIMIT 1`,
    [tenantId, moovInvoiceId],
  )).rows[0] || null;
};

const invoiceItemsFromProvider = (invoice) => {
  const raw = invoice?.lineItems?.items || invoice?.lineItems || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    name: String(item?.name || '').trim(),
    unit_price: invoiceDecimal(item?.basePrice || item?.unitPrice) || Number(item?.unit_price) || 0,
    quantity: Number(item?.quantity || 1),
  })).filter((item) => item.name);
};

const persistInvoiceCustomer = async (client, {
  tenantId, environment, displayName, email, phone, customerType, moovAccountId, userId,
}) => {
  await client.query('SAVEPOINT invoice_customer');
  try {
    const saved = (await client.query(
      `INSERT INTO public.moov_invoice_customers
        (tenant_id, environment, display_name, email, phone, customer_type, moov_account_id, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [tenantId, environment, displayName, email, phone ?? null, customerType, moovAccountId, userId],
    )).rows[0];
    await client.query('RELEASE SAVEPOINT invoice_customer');
    return saved?.id ?? null;
  } catch {
    try { await client.query('ROLLBACK TO SAVEPOINT invoice_customer'); } catch { /* ignore */ }
    const existing = await loadInvoiceCustomer(client, tenantId, environment, email)
      || await loadInvoiceCustomerByAccount(client, tenantId, environment, moovAccountId);
    return existing?.id ?? null;
  }
};

const loadTenantInvoice = async (client, tenantId, invoiceId) => {
  if (!invoiceId) return null;
  return (await client.query(
    `SELECT * FROM public.moov_invoices WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [invoiceId, tenantId],
  )).rows[0] || null;
};

export async function runProviderInvoiceAction({ client, body = {}, ctx = {}, fetchImpl } = {}) {
  try {
    const envRes = requireMoovProviderEnvironment(ctx);
    if (!envRes.ok) {
      return fail(envRes.message || envRes.error, envRes.statusCode || 503, { error: envRes.error });
    }
    const environment = envRes.environment;
    const account = await loadMoovAccount(client, ctx.tenantId, environment);
    const missing = failClosedMissingAccount(account, environment);
    if (missing) return fail(missing.message || missing.error, missing.statusCode, { error: missing.error });
    const merchantAccountId = account.provider_account_id;
    const action = body.action || 'create';
    const userId = ctx.userId || null;

    if (action === 'preflight') {
      return jsonResult({
        success: true,
        preflight: true,
        tenant_id: ctx.tenantId,
        environment,
        merchantAccountId,
        liveProviderCalled: false,
        emailed: false,
        apiVersion: INVOICE_API_VERSION,
      });
    }

    if (!INVOICE_PROVIDER_ACTIONS.has(action)) {
      return fail(`Unknown action "${action}"`, 400);
    }

    if (action === 'list') {
      const data = await moovFetch(`/accounts/${merchantAccountId}/invoices`, {
        scopes: invoiceScopes(merchantAccountId),
        apiVersion: INVOICE_API_VERSION,
        fetchImpl,
      });
      return jsonResult({
        success: true,
        invoices: data,
        liveProviderCalled: true,
        emailed: false,
        apiVersion: INVOICE_API_VERSION,
      });
    }

    if (action === 'recover') {
      const moovInvoiceId = String(body.moov_invoice_id || '').trim();
      if (!moovInvoiceId) return fail('moov_invoice_id is required', 400);
      const already = await loadInvoiceByMoovId(client, ctx.tenantId, moovInvoiceId);
      if (already) {
        return jsonResult({
          success: true,
          invoice: already,
          recovered: false,
          alreadyPresent: true,
          liveProviderCalled: false,
          emailed: false,
          apiVersion: INVOICE_API_VERSION,
        });
      }
      const inv = await moovFetch(`/accounts/${merchantAccountId}/invoices/${moovInvoiceId}`, {
        scopes: invoiceScopes(merchantAccountId),
        apiVersion: INVOICE_API_VERSION,
        fetchImpl,
      });
      if (!inv?.invoiceID || inv.invoiceID !== moovInvoiceId) {
        return fail('Provider invoice mismatch', 409);
      }
      const customerAccountId = inv.customerAccountID;
      if (!customerAccountId) return fail('Invoice has no customer account', 502);
      let customerAccount = null;
      try {
        customerAccount = await moovFetch(`/accounts/${customerAccountId}`, {
          scopes: ['/accounts.read'],
          apiVersion: INVOICE_API_VERSION,
          fetchImpl,
        });
      } catch { /* invoice already carries display name/email */ }
      const customerEmail = String(
        inv.customerEmail
        || customerAccount?.profile?.business?.email
        || customerAccount?.profile?.individual?.email
        || '',
      ).trim().toLowerCase();
      const customerName = String(
        inv.customerDisplayName
        || customerAccount?.profile?.business?.legalBusinessName
        || [customerAccount?.profile?.individual?.name?.firstName, customerAccount?.profile?.individual?.name?.lastName]
          .filter(Boolean).join(' ')
        || customerEmail,
      ).trim();
      if (!customerEmail) return fail('Provider invoice is missing a customer email', 502);
      const customerType = customerAccount?.accountType === 'individual' ? 'individual' : 'business';
      let existing = await loadInvoiceCustomerByAccount(client, ctx.tenantId, environment, customerAccountId)
        || await loadInvoiceCustomer(client, ctx.tenantId, environment, customerEmail);
      let customerRowId = existing?.id ?? null;
      if (!customerRowId) {
        customerRowId = await persistInvoiceCustomer(client, {
          tenantId: ctx.tenantId,
          environment,
          displayName: customerName,
          email: customerEmail,
          phone: null,
          customerType,
          moovAccountId: customerAccountId,
          userId,
        });
      }
      const items = invoiceItemsFromProvider(inv);
      const amount = invoiceDecimal(inv.totalAmount) || invoiceLineItemsTotal(items);
      const row = (await client.query(
        `INSERT INTO public.moov_invoices
          (tenant_id, environment, moov_account_id, moov_invoice_id, invoice_number,
           customer_id, customer_name, customer_email, customer_moov_account_id,
           description, line_items, total_amount, paid_amount, status,
           invoice_date, due_date, payment_link_url, public_token, sent_at,
           claim_id, last_synced_at, provider_metadata, created_by)
         VALUES
          ($1::uuid, $2, $3, $4, $5,
           $6::uuid, $7, $8, $9,
           $10, $11::jsonb, $12, $13, $14,
           $15, $16, $17, $18, $19,
           $20::uuid, now(), $21::jsonb, $22)
         RETURNING *`,
        [
          ctx.tenantId, environment, merchantAccountId, inv.invoiceID,
          inv.invoiceNumber ?? null, customerRowId, customerName, customerEmail,
          customerAccountId, inv.description ? String(inv.description).slice(0, 500) : null,
          JSON.stringify(items),
          invoiceDecimal(inv.totalAmount) || amount,
          invoiceDecimal(inv.paidAmount),
          inv.status ?? 'draft',
          inv.invoiceDate ?? inv.createdOn ?? null,
          inv.dueDate ?? null,
          inv.paymentLinkURL ?? null, generatePublicToken(),
          inv.sentOn ?? null,
          null, JSON.stringify(sanitize(inv)), userId,
        ],
      )).rows[0];
      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId,
        event_type: inv.sentOn ? 'invoice.recovered_sent' : 'invoice.recovered',
        new_status: inv.status ?? 'draft',
        environment,
        provider_metadata: {
          invoiceID: inv.invoiceID,
          invoiceNumber: inv.invoiceNumber,
          recovered: true,
        },
      });
      return jsonResult({
        success: true,
        invoice: row,
        recovered: true,
        alreadyPresent: false,
        liveProviderCalled: true,
        providerWrites: false,
        emailed: false,
        apiVersion: INVOICE_API_VERSION,
      });
    }

    if (action === 'create' || action === 'create_and_send') {
      const customerName = String(body.customer_name ?? '').trim();
      const customerEmail = String(body.customer_email ?? '').trim().toLowerCase();
      if (customerName.length < 2) return fail('Customer name is required', 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
        return fail('A valid customer email is required', 400);
      }
      const items = normalizeInvoiceLineItems(body.line_items);
      if (typeof items === 'string') return fail(items, 400);
      const amount = invoiceLineItemsTotal(items);
      const customerType = body.customer_type === 'individual' ? 'individual' : 'business';
      const description = body.description ? String(body.description).slice(0, 500) : null;
      const branding = await loadInvoiceBranding(client, ctx.tenantId);

      let existing = await loadInvoiceCustomer(client, ctx.tenantId, environment, customerEmail);
      let customerRowId = existing?.id ?? null;
      let customerAccountId = existing?.moov_account_id ?? null;
      let createdCustomer = false;

      if (!customerAccountId) {
        const profile = customerType === 'business'
          ? { business: { legalBusinessName: customerName, email: customerEmail } }
          : { individual: { name: splitInvoiceCustomerName(customerName), email: customerEmail } };
        const created = await moovFetch('/accounts', {
          method: 'POST',
          scopes: ['/accounts.write'],
          apiVersion: INVOICE_API_VERSION,
          fetchImpl,
          body: { accountType: customerType, profile },
        });
        customerAccountId = created?.accountID;
        if (!customerAccountId) return fail('Could not create the customer record', 502);
        createdCustomer = true;
        customerRowId = await persistInvoiceCustomer(client, {
          tenantId: ctx.tenantId,
          environment,
          displayName: customerName,
          email: customerEmail,
          phone: body.customer_phone ?? null,
          customerType,
          moovAccountId: customerAccountId,
          userId,
        });
      }

      const invoice = await moovFetch(`/accounts/${merchantAccountId}/invoices`, {
        method: 'POST',
        scopes: invoiceScopes(merchantAccountId, true),
        apiVersion: INVOICE_API_VERSION,
        fetchImpl,
        body: {
          customerAccountID: customerAccountId,
          ...(description ? { description } : {}),
          ...(body.invoice_date ? { invoiceDate: new Date(body.invoice_date).toISOString() } : {}),
          ...(body.due_date ? { dueDate: new Date(body.due_date).toISOString() } : {}),
          lineItems: {
            items: items.map((item) => ({
              name: item.name,
              basePrice: invoiceMoney(item.unit_price),
              quantity: item.quantity,
            })),
          },
          ...(branding?.invoice_footer_note
            ? { footer: String(branding.invoice_footer_note).slice(0, 1000) }
            : {}),
        },
      });

      let finalInvoice = invoice;
      if (action === 'create_and_send') {
        finalInvoice = await moovFetch(
          `/accounts/${merchantAccountId}/invoices/${invoice.invoiceID}`,
          {
            method: 'PATCH',
            scopes: invoiceScopes(merchantAccountId, true),
            apiVersion: INVOICE_API_VERSION,
            fetchImpl,
            body: { status: 'unpaid' },
          },
        );
      }

      let row = null;
      try {
        row = (await client.query(
          `INSERT INTO public.moov_invoices
            (tenant_id, environment, moov_account_id, moov_invoice_id, invoice_number,
             customer_id, customer_name, customer_email, customer_moov_account_id,
             description, line_items, total_amount, paid_amount, status,
             invoice_date, due_date, payment_link_url, public_token, sent_at,
             claim_id, last_synced_at, provider_metadata, created_by)
           VALUES
            ($1::uuid, $2, $3, $4, $5,
             $6::uuid, $7, $8, $9,
             $10, $11::jsonb, $12, $13, $14,
             $15, $16, $17, $18, $19,
             $20::uuid, now(), $21::jsonb, $22)
           RETURNING *`,
          [
            ctx.tenantId, environment, merchantAccountId, finalInvoice.invoiceID,
            finalInvoice.invoiceNumber ?? null, customerRowId, customerName, customerEmail,
            customerAccountId, description, JSON.stringify(items),
            invoiceDecimal(finalInvoice.totalAmount) || amount,
            invoiceDecimal(finalInvoice.paidAmount),
            finalInvoice.status ?? 'draft',
            body.invoice_date ?? null, body.due_date ?? null,
            finalInvoice.paymentLinkURL ?? null, generatePublicToken(),
            finalInvoice.sentOn ?? (action === 'create_and_send' ? new Date().toISOString() : null),
            body.claim_id ?? null, JSON.stringify(sanitize(finalInvoice)), userId,
          ],
        )).rows[0];
      } catch (insertError) {
        return fail('Invoice was created but could not be saved', 500, {
          liveProviderCalled: true,
          emailed: false,
          moov_invoice_id: finalInvoice.invoiceID || null,
          persistError: String(insertError?.message || insertError).slice(0, 200),
        });
      }

      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId,
        event_type: action === 'create_and_send' ? 'invoice.sent' : 'invoice.created',
        new_status: finalInvoice.status ?? 'draft',
        environment,
        provider_metadata: {
          invoiceID: finalInvoice.invoiceID,
          invoiceNumber: finalInvoice.invoiceNumber,
          customerCreated: createdCustomer,
        },
      });

      const emailed = action === 'create_and_send';
      return jsonResult({
        success: true,
        invoice: row,
        liveProviderCalled: true,
        emailed,
        apiVersion: INVOICE_API_VERSION,
        customerReused: !createdCustomer,
      });
    }

    if (action === 'send' || action === 'resend') {
      const row = await loadTenantInvoice(client, ctx.tenantId, body.invoice_id);
      if (!row) return fail('Invoice not found', 404);
      if (row.tenant_id !== ctx.tenantId) return fail('Invoice not found', 404);
      if (!row.moov_invoice_id) return fail('Invoice is not linked to the payment provider', 400);
      if (action === 'resend') {
        if (row.status === 'paid') return fail('This invoice is already paid', 400);
        if (row.status === 'canceled') return fail('A canceled invoice cannot be resent', 400);
      }
      if (action === 'send' && row.status === 'paid') {
        return fail('This invoice is already paid', 400);
      }
      if (action === 'send' && row.status === 'canceled') {
        return fail('A canceled invoice cannot be sent', 400);
      }
      const sent = await moovFetch(
        `/accounts/${merchantAccountId}/invoices/${row.moov_invoice_id}`,
        {
          method: 'PATCH',
          scopes: invoiceScopes(merchantAccountId, true),
          apiVersion: INVOICE_API_VERSION,
          fetchImpl,
          body: { status: 'unpaid' },
        },
      );
      const updated = (await client.query(
        `UPDATE public.moov_invoices
         SET status = $2,
             invoice_number = $3,
             payment_link_url = $4,
             sent_at = $5,
             last_synced_at = now(),
             provider_metadata = $6::jsonb
         WHERE id = $1::uuid AND tenant_id = $7::uuid
         RETURNING *`,
        [
          row.id,
          sent.status ?? 'unpaid',
          sent.invoiceNumber ?? row.invoice_number,
          sent.paymentLinkURL ?? row.payment_link_url,
          sent.sentOn ?? new Date().toISOString(),
          JSON.stringify(sanitize(sent)),
          ctx.tenantId,
        ],
      )).rows[0];
      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId,
        event_type: action === 'resend' ? 'invoice.resent' : 'invoice.sent',
        previous_status: row.status,
        new_status: sent.status ?? 'unpaid',
        environment,
        provider_metadata: { invoiceID: row.moov_invoice_id },
      });
      return jsonResult({
        success: true,
        invoice: updated,
        liveProviderCalled: true,
        emailed: true,
        idempotent: action === 'resend',
        apiVersion: INVOICE_API_VERSION,
      });
    }

    if (action === 'sync') {
      const params = [ctx.tenantId, environment];
      let sql = `SELECT * FROM public.moov_invoices
        WHERE tenant_id = $1::uuid AND environment = $2 AND moov_invoice_id IS NOT NULL`;
      if (body.invoice_id) {
        sql += ' AND id = $3::uuid';
        params.push(body.invoice_id);
      } else {
        sql += ` AND status NOT IN ('paid', 'canceled', 'void') LIMIT 100`;
      }
      const rows = (await client.query(sql, params)).rows;
      let synced = 0;
      let inventedPaid = false;
      for (const row of rows) {
        if (row.tenant_id !== ctx.tenantId || row.environment !== environment) continue;
        try {
          const inv = await moovFetch(
            `/accounts/${merchantAccountId}/invoices/${row.moov_invoice_id}`,
            { scopes: invoiceScopes(merchantAccountId), apiVersion: INVOICE_API_VERSION, fetchImpl },
          );
          await client.query(
            `UPDATE public.moov_invoices
             SET status = $2,
                 invoice_number = $3,
                 total_amount = $4,
                 paid_amount = $5,
                 payment_link_url = $6,
                 sent_at = $7,
                 paid_at = $8,
                 last_synced_at = now(),
                 provider_metadata = $9::jsonb
             WHERE id = $1::uuid AND tenant_id = $10::uuid`,
            [
              row.id,
              inv.status ?? row.status,
              inv.invoiceNumber ?? row.invoice_number,
              invoiceDecimal(inv.totalAmount) || row.total_amount,
              invoiceDecimal(inv.paidAmount),
              inv.paymentLinkURL ?? row.payment_link_url,
              inv.sentOn ?? row.sent_at,
              inv.paidOn ?? row.paid_at,
              JSON.stringify(sanitize(inv)),
              ctx.tenantId,
            ],
          );
          synced += 1;
        } catch { /* keep remaining rows */ }
      }
      return jsonResult({
        success: true,
        synced,
        liveProviderCalled: rows.length > 0,
        invented_paid: inventedPaid,
        emailed: false,
        apiVersion: INVOICE_API_VERSION,
      });
    }

    if (action === 'cancel') {
      const row = await loadTenantInvoice(client, ctx.tenantId, body.invoice_id);
      if (!row) return fail('Invoice not found', 404);
      if (row.status === 'paid') return fail('A paid invoice cannot be canceled', 400);
      let providerError = null;
      if (row.moov_invoice_id) {
        try {
          await moovFetch(`/accounts/${merchantAccountId}/invoices/${row.moov_invoice_id}`, {
            method: 'DELETE',
            scopes: invoiceScopes(merchantAccountId, true),
            apiVersion: INVOICE_API_VERSION,
            fetchImpl,
          });
        } catch (error) {
          providerError = invoiceProviderErrorMessage(error, 'Provider cancel failed');
        }
      }
      const updated = (await client.query(
        `UPDATE public.moov_invoices
         SET status = 'canceled', last_synced_at = now()
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         RETURNING *`,
        [row.id, ctx.tenantId],
      )).rows[0];
      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId,
        event_type: 'invoice.canceled',
        previous_status: row.status,
        new_status: 'canceled',
        environment,
        provider_metadata: { invoiceID: row.moov_invoice_id, providerError },
      });
      return jsonResult({
        success: true,
        invoice: updated,
        provider_warning: providerError,
        liveProviderCalled: Boolean(row.moov_invoice_id),
        emailed: false,
        apiVersion: INVOICE_API_VERSION,
      });
    }

    if (action === 'delete') {
      const row = await loadTenantInvoice(client, ctx.tenantId, body.invoice_id);
      if (!row) return fail('Invoice not found', 404);
      if (row.status !== 'canceled' && row.status !== 'draft') {
        return fail('Only canceled or draft invoices can be deleted', 400);
      }
      if (row.moov_invoice_id) {
        try {
          await moovFetch(`/accounts/${merchantAccountId}/invoices/${row.moov_invoice_id}`, {
            method: 'DELETE',
            scopes: invoiceScopes(merchantAccountId, true),
            apiVersion: INVOICE_API_VERSION,
            fetchImpl,
          });
        } catch { /* best-effort provider cleanup */ }
      }
      await client.query(
        `DELETE FROM public.moov_invoices WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [row.id, ctx.tenantId],
      );
      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId,
        event_type: 'invoice.deleted',
        previous_status: row.status,
        new_status: 'deleted',
        environment,
        provider_metadata: { invoiceID: row.moov_invoice_id },
      });
      return jsonResult({
        success: true,
        deleted: true,
        liveProviderCalled: Boolean(row.moov_invoice_id),
        emailed: false,
        apiVersion: INVOICE_API_VERSION,
      });
    }

    return fail(`Unknown action "${action}"`, 400);
  } catch (error) {
    if (error instanceof MoovError) {
      return fail(invoiceProviderErrorMessage(error), error.status && error.status >= 400 && error.status < 600 ? error.status : 502, {
        liveProviderCalled: true,
        emailed: false,
      });
    }
    return fail(String(error?.message || error).slice(0, 400), 500, {
      liveProviderCalled: false,
      emailed: false,
    });
  }
}
