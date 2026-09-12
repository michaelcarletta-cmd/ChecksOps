/**
 * Public tokenized routes. The signed URL token is the authorization mechanism.
 * These handlers must not require a Cognito session and must never leak
 * database or implementation errors to the browser.
 */
import pg from 'pg';
import { parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';

const { Client } = pg;

const INVOICE_PUBLIC_COLUMNS = `
  id, public_token, invoice_number, customer_name, customer_email, description,
  line_items, total_amount, paid_amount, status, invoice_date, due_date,
  payment_link_url, sent_at, paid_at, created_at, tenant_id
`;

export const isPlausiblePublicToken = (token) => {
  const value = String(token || '').trim();
  if (value.length < 8 || value.length > 200) return false;
  if (/\s/.test(value)) return false;
  if (/^(undefined|null|nan)$/i.test(value)) return false;
  return /^[A-Za-z0-9._~-]+$/.test(value);
};

export const publicLinkError = (spoof, statusCode, error, message) => ({
  ok: false,
  statusCode,
  error,
  message,
  spoofFieldsIgnored: spoof,
});

const publicDb = async () => {
  const credentials = await loadDatabaseCredentials();
  const client = new Client(buildClientConfig(credentials, { queryTimeoutMillis: 12000 }));
  await client.connect();
  return client;
};

const withPublicClient = async (event, fn) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  let client;
  try {
    client = await publicDb();
    return await fn({ client, body, spoof });
  } catch (error) {
    console.error('[public-tokens]', sanitizePublicError(error));
    return publicLinkError(
      spoof,
      503,
      'link_unavailable',
      'This link is not available right now. Try again shortly or ask the sender for a new one.',
    );
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const loadInvoiceByToken = async (client, token) => {
  const lookup = async (table) => {
    try {
      return (await client.query(
        `SELECT ${INVOICE_PUBLIC_COLUMNS} FROM public.${table} WHERE public_token = $1 LIMIT 1`,
        [token],
      )).rows[0] || null;
    } catch {
      return null;
    }
  };
  return (await lookup('moov_invoices')) || (await lookup('payment_invoices'));
};

const publicInvoiceShape = (row) => ({
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
});

const publicTenantShape = (row) => ({
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
});

export const handlePublicInvoice = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  if (!isPlausiblePublicToken(token)) {
    return publicLinkError(spoof, 400, 'invalid_link', 'This invoice link is invalid or has expired.');
  }
  return withPublicClient(event, async ({ client }) => {
    const invoice = await loadInvoiceByToken(client, token);
    if (!invoice) {
      return publicLinkError(spoof, 404, 'invalid_link', 'This invoice link is invalid or has expired.');
    }
    const tenant = (await client.query(
      `SELECT name, slug, logo_url, primary_color, secondary_color, custom_domain,
              invoice_letterhead_url, invoice_footer_note, invoice_default_terms,
              invoice_accent_color, invoice_theme
       FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
      [invoice.tenant_id],
    )).rows[0];
    if (!tenant) {
      return publicLinkError(spoof, 404, 'invalid_link', 'This invoice link is invalid or has expired.');
    }
    return {
      ok: true,
      statusCode: 200,
      invoice: publicInvoiceShape(invoice),
      tenant: publicTenantShape(tenant),
      spoofFieldsIgnored: spoof,
    };
  });
};

export const handlePublicRecipientSession = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  if (!isPlausiblePublicToken(token)) {
    return publicLinkError(spoof, 400, 'invalid_link', 'This payment setup link is invalid or has expired.');
  }
  return withPublicClient(event, async ({ client }) => {
    const recipient = (await client.query(
      `SELECT id, tenant_id, display_name, provider_account_id, token_expires_at, onboarding_status,
              environment, bank_linked_at, provider_bank_name, provider_last_four, secure_token
       FROM public.external_payment_recipients
       WHERE secure_token = $1
       LIMIT 1`,
      [token],
    )).rows[0];
    if (!recipient) {
      return publicLinkError(spoof, 404, 'invalid_link', 'This payment setup link is invalid or has expired.');
    }
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return publicLinkError(spoof, 410, 'expired_link', 'This link has expired. Ask the sender for a new one.');
    }
    return publicLinkError(
      spoof,
      409,
      'payment_setup_unavailable',
      'This payment setup is not available right now.',
    );
  });
};

