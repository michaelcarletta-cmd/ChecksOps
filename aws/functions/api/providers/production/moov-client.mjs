import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import {
  PRODUCTION_MOOV_API_VERSION,
  PRODUCTION_MOOV_HOST,
  PRODUCTION_MOOV_ORIGIN,
} from './moov-secrets.mjs';

export class ProductionMoovError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ProductionMoovError';
    this.status = status;
    this.body = body;
  }
}

const tokenCache = new Map();

const assertProductionCredentials = (credentials) => {
  if (!credentials || credentials.environment !== 'production') {
    throw new ProductionMoovError('Production Moov credentials are required', 503, { error: 'production_secret_missing' });
  }
  if (credentials.host && credentials.host !== PRODUCTION_MOOV_HOST) {
    throw new ProductionMoovError('Unapproved Moov host', 503, { error: 'production_host_refused' });
  }
  if (credentials.origin !== PRODUCTION_MOOV_ORIGIN) {
    throw new ProductionMoovError('Unapproved Moov origin', 503, { error: 'production_origin_refused' });
  }
  if (!credentials.publicKey || !credentials.secretKey || !credentials.platformAccountId) {
    throw new ProductionMoovError('Production Moov credentials incomplete', 503, { error: 'production_secret_missing' });
  }
  if (String(credentials.publicKey).startsWith('MOOV_SANDBOX')
    || String(credentials.secretKey).includes('SANDBOX')) {
    throw new ProductionMoovError('Sandbox credentials refused', 503, { error: 'sandbox_credential_contamination' });
  }
};

export async function productionMoovToken({ credentials, scopes = ['/accounts.read'], fetchImpl = fetch } = {}) {
  assertProductionCredentials(credentials);
  const scope = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
  const cacheKey = `${credentials.publicKey}|${credentials.origin}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const basic = Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64');
  const response = await fetchImpl(`${PRODUCTION_MOOV_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: PRODUCTION_MOOV_ORIGIN,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!response.ok) {
    throw new ProductionMoovError('Could not authenticate with the payment provider', response.status, json ?? text);
  }
  const token = json?.access_token;
  const ttl = Number(json?.expires_in ?? 300) * 1000;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl });
  return token;
}

export async function productionMoovFetch({
  credentials,
  path,
  method = 'GET',
  body,
  idempotencyKey = null,
  scopes,
  fetchImpl = fetch,
} = {}) {
  assertProductionCredentials(credentials);
  const token = await productionMoovToken({ credentials, scopes, fetchImpl });
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: PRODUCTION_MOOV_ORIGIN,
    'x-moov-version': credentials.apiVersion || PRODUCTION_MOOV_API_VERSION,
  };
  if (idempotencyKey) headers['X-Idempotency-Key'] = String(idempotencyKey);
  const response = await fetchImpl(`${PRODUCTION_MOOV_HOST}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!response.ok) {
    throw new ProductionMoovError(
      json?.error || json?.message || `Moov ${path} failed`,
      response.status,
      json ?? text,
    );
  }
  return { ok: true, status: response.status, json, raw: text };
}

export function normalizeProductionTransferStatus(moovStatus) {
  switch (String(moovStatus ?? '').toLowerCase()) {
    case 'created':
    case 'queued':
      return 'submitted';
    case 'pending':
      return 'pending';
    case 'reversed':
      return 'returned';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return 'processing';
  }
}

export const transferIdOf = (json) => (
  json?.transferID || json?.transferId || json?.id || null
);

export { isProviderNetworkError, providerEgressFailure };
