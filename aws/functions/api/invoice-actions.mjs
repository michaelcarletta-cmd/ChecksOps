/**
 * Tenant Payments → Invoices action contract.
 *
 * Local-durable document workflow for the existing Invoices UI.
 * Does not call Moov, ACH, wallet, or transfer APIs.
 * Does not mark an invoice paid because it was sent.
 * Provider payment IDs stay null until a separately authorized provider sync.
 */
import { randomUUID } from 'node:crypto';
import { fail, jsonResult, membershipsOf, resolveTenant } from './providers/parity/caller.mjs';

export const INVOICE_ACTIONS = new Set([
  'create',
  'create_and_send',
  'send',
  'resend',
  'cancel',
  'delete',
  'sync',
]);

export const TERMINAL_PAID = new Set(['paid']);
export const DELETE_ALLOWED = new Set(['draft', 'canceled']);
export const CANCEL_BLOCKED = new Set(['paid', 'canceled']);
export const RESEND_BLOCKED = new Set(['paid', 'canceled']);
export const LOCAL_MERCHANT = 'local';

/** RFC 4122 UUID v4. Node `randomUUID()` is CSPRNG; variant/version bits leave 122 bits of entropy. */
export const PUBLIC_INVOICE_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PUBLIC_INVOICE_RESPONSE_KEYS = Object.freeze([
  'id',
  'public_token',
  'invoice_number',
  'customer_name',
  'customer_email',
  'description',
  'line_items',
  'total_amount',
  'paid_amount',
  'status',
  'invoice_date',
  'due_date',
  'payment_link_url',
  'sent_at',
  'paid_at',
  'created_at',
]);

export const PUBLIC_TENANT_RESPONSE_KEYS = Object.freeze([
  'name',
  'slug',
  'logo_url',
  'primary_color',
  'secondary_color',
  'custom_domain',
  'invoice_letterhead_url',
  'invoice_footer_note',
  'invoice_default_terms',
  'invoice_accent_color',
  'invoice_theme',
]);

export const PUBLIC_INVOICE_FORBIDDEN_KEYS = Object.freeze([
  'tenant_id',
  'environment',
  'moov_account_id',
  'moov_invoice_id',
  'customer_id',
  'customer_moov_account_id',
  'provider_metadata',
  'created_by',
  'last_synced_at',
  'bank_account',
  'routing_number',
  'account_number',
  'wallet_id',
  'transfer_id',
]);

export function generatePublicToken() {
  return randomUUID();
}

export function isPublicInvoiceToken(value) {
  return PUBLIC_INVOICE_TOKEN_RE.test(String(value || '').trim());
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeLineItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return 'At least one line item is required';
  const items = [];
  for (const row of raw) {
    const name = String(row?.name ?? '').trim();
    const unit = Number(row?.unit_price);
    const qty = Number(row?.quantity ?? 1);
    if (!name) return 'Every line item needs a description';
    if (!Number.isFinite(unit) || unit <= 0) return `Enter a price greater than zero for "${name}"`;
    if (!Number.isFinite(qty) || qty <= 0) return `Enter a quantity greater than zero for "${name}"`;
    items.push({
      name,
      unit_price: Math.round(unit * 100) / 100,
      quantity: Math.round(qty),
    });
  }
  if (items.length > 50) return 'An invoice can have at most 50 line items';
  return items;
}

export const invoiceTotal = (items) =>
  Math.round(items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) * 100) / 100;

export function canSendStatus(status) {
  return status === 'draft' || status === 'unpaid' || status === 'overdue' || status === 'sent';
}

export function canResendStatus(status) {
  return !RESEND_BLOCKED.has(status);
}

export function canCancelStatus(status) {
  return !CANCEL_BLOCKED.has(status);
}

export function canDeleteStatus(status) {
  return DELETE_ALLOWED.has(status);
}

export function applySendTransition(row, { now = new Date().toISOString() } = {}) {
  const status = String(row?.status || 'draft');
  if (TERMINAL_PAID.has(status)) {
    return { error: 'This invoice is already paid', statusCode: 400 };
  }
  if (status === 'canceled') {
    return { error: 'A canceled invoice cannot be sent', statusCode: 400 };
  }
  return {
    status: 'unpaid',
    sent_at: row.sent_at || now,
    paid_amount: Number(row.paid_amount || 0),
    paid_at: row.paid_at || null,
    public_token: row.public_token || generatePublicToken(),
    emailed: false,
  };
}

export function applyCancelTransition(row) {
  const status = String(row?.status || '');
  if (status === 'paid') return { error: 'A paid invoice cannot be canceled', statusCode: 400 };
  if (status === 'canceled') {
    return { status: 'canceled', idempotent: true, paid_amount: Number(row.paid_amount || 0) };
  }
  return { status: 'canceled', idempotent: false, paid_amount: Number(row.paid_amount || 0) };
}

export function applySyncTransition(row, provider = null) {
  if (!provider) {
    return {
      status: row.status,
      paid_amount: Number(row.paid_amount || 0),
      paid_at: row.paid_at || null,
      invented_paid: false,
      liveProviderCalled: false,
    };
  }
  const nextStatus = provider.status || row.status;
  const paidAmount = provider.paid_amount == null ? Number(row.paid_amount || 0) : Number(provider.paid_amount);
  return {
    status: nextStatus,
    paid_amount: paidAmount,
    paid_at: provider.paid_at ?? row.paid_at ?? null,
    invented_paid: false,
    liveProviderCalled: true,
  };
}

const publicInvoiceSelect = `
  id, public_token, invoice_number, customer_name, customer_email, description,
  line_items, total_amount, paid_amount, status, invoice_date, due_date,
  payment_link_url, sent_at, paid_at, created_at, tenant_id
`;

const tenantBrandingSelect = `
  name, slug, logo_url, primary_color, secondary_color, custom_domain,
  invoice_letterhead_url, invoice_footer_note, invoice_default_terms,
  invoice_accent_color, invoice_theme
`;

export function shapePublicInvoice(row) {
  return {
    id: row.id,
    public_token: row.public_token,
    invoice_number: row.invoice_number,
    customer_name: row.customer_name,
    customer_email: row.customer_email,
    description: row.description,
    line_items: Array.isArray(row.line_items) ? row.line_items : [],
    total_amount: Number(row.total_amount ?? 0),
    paid_amount: Number(row.paid_amount ?? 0),
    status: row.status,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
    payment_link_url: row.payment_link_url,
    sent_at: row.sent_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
  };
}

export function shapePublicTenant(row) {
  return {
    name: row.name,
    slug: row.slug,
    logo_url: row.logo_url,
    primary_color: row.primary_color,
    secondary_color: row.secondary_color,
    custom_domain: row.custom_domain,
    invoice_letterhead_url: row.invoice_letterhead_url,
    invoice_footer_note: row.invoice_footer_note,
    invoice_default_terms: row.invoice_default_terms,
    invoice_accent_color: row.invoice_accent_color,
    invoice_theme: row.invoice_theme,
  };
}

export async function resolveInvoiceTenant({ client, userId, body }) {
  const memberships = await membershipsOf(client, userId);
  const tenant = await resolveTenant(client, { userId, body, memberships, requireAdmin: false });
  if (tenant.error) return tenant;
  if (!tenant.tenantId) return fail('tenant_id is required', 400);
  return { tenantId: tenant.tenantId, isAdmin: tenant.isAdmin, memberships };
}

async function loadInvoiceRow(client, { invoiceId, tenantId }) {
  if (!invoiceId) return null;
  const row = (await client.query(
    `SELECT * FROM public.moov_invoices WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [invoiceId, tenantId],
  )).rows[0];
  return row || null;
}

async function upsertLocalCustomer(client, {
  tenantId,
  environment,
  customerName,
  customerEmail,
  customerType,
  userId,
}) {
  const existing = (await client.query(
    `SELECT id, moov_account_id FROM public.moov_invoice_customers
     WHERE tenant_id = $1::uuid AND environment = $2 AND lower(email) = lower($3)
     LIMIT 1`,
    [tenantId, environment, customerEmail],
  )).rows[0];
  if (existing) return existing;
  const localAccountId = `local:${customerEmail}`;
  const saved = (await client.query(
    `INSERT INTO public.moov_invoice_customers
      (tenant_id, environment, display_name, email, customer_type, moov_account_id, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
     RETURNING id, moov_account_id`,
    [tenantId, environment, customerName, customerEmail, customerType, localAccountId, userId],
  )).rows[0];
  return saved;
}

function invoiceNumber() {
  return `INV-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function runInvoiceAction({
  client,
  body = {},
  tenantId,
  userId,
  environment = 'sandbox',
  liveProvider = false,
} = {}) {
  if (liveProvider === true) {
    return fail('Invoice provider live calls are not authorized in this workstream', 403, {
      error: 'invoice_provider_not_authorized',
      liveProviderCalled: false,
    });
  }

  const action = String(body.action || '').trim();
  if (!action) return fail('action is required', 400);
  if (!INVOICE_ACTIONS.has(action)) return fail(`Unknown action "${action}"`, 400);
  if (!tenantId) return fail('tenant_id is required', 400);

  if (action === 'create' || action === 'create_and_send') {
    const customerName = String(body.customer_name ?? '').trim();
    const customerEmail = String(body.customer_email ?? '').trim().toLowerCase();
    if (customerName.length < 2) return fail('Customer name is required', 400);
    if (!EMAIL_RE.test(customerEmail)) return fail('A valid customer email is required', 400);
    const items = normalizeLineItems(body.line_items);
    if (typeof items === 'string') return fail(items, 400);
    const amount = invoiceTotal(items);
    const customerType = body.customer_type === 'individual' ? 'individual' : 'business';
    const description = body.description ? String(body.description).slice(0, 500) : null;
    const customer = await upsertLocalCustomer(client, {
      tenantId,
      environment,
      customerName,
      customerEmail,
      customerType,
      userId,
    });
    const now = new Date().toISOString();
    const sendNow = action === 'create_and_send';
    const publicToken = generatePublicToken();
    const row = (await client.query(
      `INSERT INTO public.moov_invoices (
         tenant_id, environment, moov_account_id, moov_invoice_id, invoice_number,
         customer_id, customer_name, customer_email, customer_moov_account_id,
         description, line_items, total_amount, paid_amount, status,
         invoice_date, due_date, payment_link_url, public_token, sent_at, paid_at,
         last_synced_at, provider_metadata, created_by
       ) VALUES (
         $1::uuid, $2, $3, NULL, $4,
         $5::uuid, $6, $7, $8,
         $9, $10::jsonb, $11, 0, $12,
         $13, $14, NULL, $15::uuid, $16::timestamptz, NULL,
         now(), '{}'::jsonb, $17::uuid
       ) RETURNING *`,
      [
        tenantId,
        environment,
        LOCAL_MERCHANT,
        invoiceNumber(),
        customer?.id || null,
        customerName,
        customerEmail,
        customer?.moov_account_id || `local:${customerEmail}`,
        description,
        JSON.stringify(items),
        amount,
        sendNow ? 'unpaid' : 'draft',
        body.invoice_date || null,
        body.due_date || null,
        publicToken,
        sendNow ? now : null,
        userId,
      ],
    )).rows[0];
    return jsonResult({
      success: true,
      invoice: row,
      emailed: false,
      liveProviderCalled: false,
      provider_warning: sendNow
        ? 'Customer email is not sent until the payment-provider invoice path is separately authorized. Share the invoice page link.'
        : null,
    });
  }

  if (action === 'send' || action === 'resend') {
    const row = await loadInvoiceRow(client, { invoiceId: body.invoice_id, tenantId });
    if (!row) return fail('Invoice not found', 404);
    if (action === 'resend' && !canResendStatus(row.status) && row.status !== 'draft') {
      if (row.status === 'paid') return fail('This invoice is already paid', 400);
      if (row.status === 'canceled') return fail('A canceled invoice cannot be resent', 400);
    }
    const next = applySendTransition(row);
    if (next.error) return fail(next.error, next.statusCode);
    const updated = (await client.query(
      `UPDATE public.moov_invoices
       SET status = $2, sent_at = $3::timestamptz, public_token = COALESCE(public_token, $4::uuid),
           last_synced_at = now()
       WHERE id = $1::uuid AND tenant_id = $5::uuid
       RETURNING *`,
      [row.id, next.status, next.sent_at, next.public_token, tenantId],
    )).rows[0];
    return jsonResult({
      success: true,
      invoice: updated,
      emailed: false,
      liveProviderCalled: false,
      idempotent: row.status === 'unpaid' && action === 'resend',
      provider_warning: 'Customer email is not sent until the payment-provider invoice path is separately authorized. Share the invoice page link.',
    });
  }

  if (action === 'cancel') {
    const row = await loadInvoiceRow(client, { invoiceId: body.invoice_id, tenantId });
    if (!row) return fail('Invoice not found', 404);
    const next = applyCancelTransition(row);
    if (next.error) return fail(next.error, next.statusCode);
    const updated = (await client.query(
      `UPDATE public.moov_invoices
       SET status = 'canceled', last_synced_at = now()
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       RETURNING *`,
      [row.id, tenantId],
    )).rows[0];
    return jsonResult({
      success: true,
      invoice: updated,
      liveProviderCalled: false,
      idempotent: next.idempotent === true,
    });
  }

  if (action === 'delete') {
    const row = await loadInvoiceRow(client, { invoiceId: body.invoice_id, tenantId });
    if (!row) return fail('Invoice not found', 404);
    if (!canDeleteStatus(row.status)) {
      return fail('Only canceled or draft invoices can be deleted', 400);
    }
    await client.query(
      `DELETE FROM public.moov_invoices WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [row.id, tenantId],
    );
    return jsonResult({
      success: true,
      deleted: true,
      liveProviderCalled: false,
    });
  }

  if (action === 'sync') {
    const params = [tenantId, environment];
    let sql = `SELECT id, status, paid_amount, paid_at, moov_invoice_id
               FROM public.moov_invoices
               WHERE tenant_id = $1::uuid AND environment = $2`;
    if (body.invoice_id) {
      params.push(body.invoice_id);
      sql += ` AND id = $3::uuid`;
    } else {
      sql += ` AND status NOT IN ('paid','canceled','void')`;
    }
    sql += ' ORDER BY created_at DESC NULLS LAST LIMIT 100';
    const rows = (await client.query(sql, params)).rows;
    let synced = 0;
    for (const row of rows) {
      const next = applySyncTransition(row, null);
      await client.query(
        `UPDATE public.moov_invoices SET last_synced_at = now()
         WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = $3 AND paid_amount = $4`,
        [row.id, tenantId, next.status, next.paid_amount],
      );
      synced += 1;
    }
    return jsonResult({
      success: true,
      synced,
      liveProviderCalled: false,
      invented_paid: false,
    });
  }

  return fail(`Unknown action "${action}"`, 400);
}

export async function loadPublicInvoiceByToken(client, token) {
  const value = String(token || '').trim();
  if (!value) return fail('Invoice token is required', 400);
  if (!isPublicInvoiceToken(value)) return fail('Invoice not found', 404);
  const invoice = (await client.query(
    `SELECT ${publicInvoiceSelect}
     FROM public.moov_invoices
     WHERE public_token = $1::uuid
     LIMIT 1`,
    [value.toLowerCase()],
  )).rows[0];
  if (!invoice) return fail('Invoice not found', 404);
  const tenant = (await client.query(
    `SELECT ${tenantBrandingSelect} FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
    [invoice.tenant_id],
  )).rows[0];
  if (!tenant) return fail('Organization not found', 404);
  return jsonResult({
    success: true,
    invoice: shapePublicInvoice(invoice),
    tenant: shapePublicTenant(tenant),
    liveProviderCalled: false,
  });
}
