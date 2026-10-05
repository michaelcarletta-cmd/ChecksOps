/**
 * Public invoice page lookup. Token-only. No Cognito. No Moov. No money movement.
 */
import pg from 'pg';
import { parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';
import { loadPublicInvoiceByToken } from './invoice-actions.mjs';

const { Client } = pg;

const publicClient = async (deps = {}) => {
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || ((config) => new Client(config));
  const credentials = await loadCredentials();
  const client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 8000 }));
  await client.connect();
  return client;
};

export const handlePublicInvoice = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || body.invoice_id || '').trim();
  if (!token) {
    return { ok: false, statusCode: 400, error: 'Invoice token is required', spoofFieldsIgnored: spoof };
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
