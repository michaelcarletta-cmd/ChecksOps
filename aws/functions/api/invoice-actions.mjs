/**
 * Tenant Payments → Invoices public-token and action contract.
 *
 * Provider-backed lifecycle lives in invoice-provider.mjs (INV3/INV6).
 * This module keeps the later token-only public ChecksOps route:
 * CSPRNG UUID v4, exact lookup, fail-closed read-only shaping.
 * Does not persist a local/synthetic invoice (5480 path removed).
 */
import { randomUUID } from 'node:crypto';
import { fail, jsonResult, membershipsOf, resolveTenant } from './providers/parity/caller.mjs';

export const INVOICE_ACTIONS = new Set([
  'preflight',
  'list',
  'recover',
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

export async function runInvoiceAction({
  client,
  body = {},
  tenantId,
  userId,
  environment = 'sandbox',
  fetchImpl,
  ctx,
} = {}) {
  const action = String(body.action || '').trim();
  if (!action) return fail('action is required', 400);
  if (!INVOICE_ACTIONS.has(action)) return fail(`Unknown action "${action}"`, 400);
  const resolvedTenantId = ctx?.tenantId || tenantId;
  if (!resolvedTenantId) return fail('tenant_id is required', 400);
  const { runProviderInvoiceAction } = await import('./invoice-provider.mjs');
  return runProviderInvoiceAction({
    client,
    body,
    fetchImpl,
    ctx: ctx || {
      tenantId: resolvedTenantId,
      userId,
      environment: environment || 'sandbox',
    },
  });
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
