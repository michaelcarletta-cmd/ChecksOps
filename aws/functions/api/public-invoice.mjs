/**
 * Public invoice page lookup. Token-only. No Cognito. No Moov. No money movement.
 * Read-only: cannot change invoice status, mark paid, or start ACH/wallet/transfer.
 */
import pg from 'pg';
import { parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';
import { isPublicInvoiceToken, loadPublicInvoiceByToken } from './invoice-actions.mjs';

const { Client } = pg;

export const PUBLIC_INVOICE_WRITE_ACTIONS = new Set([
  'create',
  'create_and_send',
  'send',
  'resend',
  'cancel',
  'delete',
  'sync',
  'mark_paid',
  'pay',
  'paid',
  'transfer',
  'disburse',
  'ach',
  'wallet',
  'create_transfer',
  'moov',
]);

const publicClient = async (deps = {}) => {
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || ((config) => new Client(config));
  const credentials = await loadCredentials();
  const client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 8000 }));
  await client.connect();
  return client;
};

const requestMethod = (event) =>
  String(event?.httpMethod || event?.requestContext?.http?.method || 'POST').toUpperCase();

export const handlePublicInvoice = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const method = requestMethod(event);
  if (method !== 'POST') {
    return {
      ok: false,
      statusCode: 405,
      error: 'method_not_allowed',
      message: 'Public invoice lookup accepts POST only',
      spoofFieldsIgnored: spoof,
    };
  }

  const action = String(body.action || body.op || '').trim().toLowerCase();
  if (action && PUBLIC_INVOICE_WRITE_ACTIONS.has(action)) {
    return {
      ok: false,
      statusCode: 405,
      error: 'public_invoice_read_only',
      message: 'Public invoice cannot change invoice status or initiate payment',
      spoofFieldsIgnored: spoof,
    };
  }

  const token = String(body.token || '').trim();
  if (!token) {
    return { ok: false, statusCode: 400, error: 'Invoice token is required', spoofFieldsIgnored: spoof };
  }
  if (!isPublicInvoiceToken(token)) {
    return { ok: false, statusCode: 404, error: 'Invoice not found', spoofFieldsIgnored: spoof };
  }

  let client;
  try {
    client = await publicClient(deps);
    const result = await loadPublicInvoiceByToken(client, token);
    return { ...result, spoofFieldsIgnored: spoof };
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      error: 'invoice_lookup_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
