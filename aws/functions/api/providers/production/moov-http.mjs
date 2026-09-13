import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import { refuseKycOrCapabilityWrite } from './moov-capability-policy.mjs';
import {
  PRODUCTION_MOOV_API_VERSION,
  PRODUCTION_MOOV_HOST,
  PRODUCTION_MOOV_ORIGIN,
} from './moov-secrets.mjs';

const ACCOUNT_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export class ProductionMoovError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ProductionMoovError';
    this.status = status;
    this.body = body;
  }
}

/** GET allowlist: account, capabilities, banks, wallets, payment methods, sweeps. No KYC files. */
export const PRODUCTION_MOOV_GET_PATH_RE = new RegExp(
  `^/accounts/${ACCOUNT_UUID}`
  + '(?:'
    + '|/capabilities'
    + '|/wallets(?:/' + ACCOUNT_UUID + ')?'
    + '|/wallets/' + ACCOUNT_UUID + '/sweeps(?:/' + ACCOUNT_UUID + ')?'
    + '|/bank-accounts(?:/' + ACCOUNT_UUID + ')?'
    + '|/payment-methods(?:/' + ACCOUNT_UUID + ')?'
    + '|/transfers/' + ACCOUNT_UUID
  + ')?$',
  'i',
);

export const PRODUCTION_MOOV_TRANSFER_POST_RE = new RegExp(
  `^/accounts/${ACCOUNT_UUID}/transfers$`,
  'i',
);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const assertProductionMoovGet = ({ method = 'GET', path } = {}) => {
  const verb = String(method || 'GET').toUpperCase();
  if (WRITE_METHODS.has(verb) || verb !== 'GET') {
    const error = new ProductionMoovError('Production Moov GET allowlist is GET only', 403, {
      error: 'read_only_method_denied',
      method: verb,
      path: path || null,
    });
    error.code = 'read_only_method_denied';
    throw error;
  }
  if (!PRODUCTION_MOOV_GET_PATH_RE.test(String(path || ''))) {
    const error = new ProductionMoovError('Path is not on the production Moov GET allowlist', 403, {
      error: 'read_only_path_denied',
      method: verb,
      path: path || null,
    });
    error.code = 'read_only_path_denied';
    throw error;
  }
};

export const assertProductionMoovTransferPost = ({ method = 'POST', path } = {}) => {
  const kyc = refuseKycOrCapabilityWrite({ method, path });
  if (kyc) {
    const error = new ProductionMoovError(kyc.message, 403, kyc);
    error.code = kyc.error;
    throw error;
  }
  const verb = String(method || '').toUpperCase();
  if (verb !== 'POST') {
    const error = new ProductionMoovError('Production Moov money writes allow POST transfers only', 403, {
      error: 'transfer_method_denied',
      method: verb,
      path: path || null,
    });
    error.code = 'transfer_method_denied';
    throw error;
  }
  if (!PRODUCTION_MOOV_TRANSFER_POST_RE.test(String(path || ''))) {
    const error = new ProductionMoovError('Production Moov money writes cannot target this path', 403, {
      error: 'transfer_path_denied',
      method: verb,
      path: path || null,
    });
    error.code = 'transfer_path_denied';
    throw error;
  }
};

const tokenCache = new Map();

export const resetProductionMoovTokenCache = () => tokenCache.clear();

export async function productionMoovToken({ credentials, scopes, fetchImpl = fetch }) {
  const scope = (scopes || []).join(' ');
  const cacheKey = `${credentials.origin}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const basic = Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64');
  const res = await fetchImpl(`${credentials.host || PRODUCTION_MOOV_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: credentials.origin || PRODUCTION_MOOV_ORIGIN,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new ProductionMoovError('Could not authenticate with the payment provider', res.status, json ?? text);
  }
  const token = json?.access_token;
  const ttl = Number(json?.expires_in ?? 300) * 1000;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl });
  return token;
}

const scopesForPath = (path, method) => {
  const match = String(path || '').match(new RegExp(`^/accounts/(${ACCOUNT_UUID})`, 'i'));
  const id = match?.[1];
  if (!id) return ['/ping.read'];
  if (/\/transfers$/i.test(path) && String(method).toUpperCase() === 'POST') {
    return [`/accounts/${id}/transfers.write`];
  }
  if (/\/capabilities/i.test(path)) return [`/accounts/${id}/capabilities.read`];
  if (/\/wallets/i.test(path)) return [`/accounts/${id}/wallets.read`];
  if (/\/bank-accounts/i.test(path)) return [`/accounts/${id}/bank-accounts.read`];
  if (/\/payment-methods/i.test(path)) return [`/accounts/${id}/payment-methods.read`];
  if (/\/transfers\//i.test(path)) return [`/accounts/${id}/transfers.read`];
  return [`/accounts/${id}/profile.read`];
};

export async function productionMoovFetch({
  credentials,
  path,
  method = 'GET',
  body,
  idempotencyKey,
  fetchImpl = fetch,
  allowTransferPost = false,
}) {
  const verb = String(method || 'GET').toUpperCase();
  if (allowTransferPost && verb === 'POST') {
    assertProductionMoovTransferPost({ method: verb, path });
  } else {
    assertProductionMoovGet({ method: verb, path });
  }
  const token = await productionMoovToken({
    credentials,
    scopes: scopesForPath(path, verb),
    fetchImpl,
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: credentials.origin || PRODUCTION_MOOV_ORIGIN,
    'x-moov-version': credentials.apiVersion || PRODUCTION_MOOV_API_VERSION,
  };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  try {
    const res = await fetchImpl(`${credentials.host || PRODUCTION_MOOV_HOST}${path}`, {
      method: verb,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      throw new ProductionMoovError(
        json?.error || json?.message || `Moov ${path} failed`,
        res.status,
        json ?? text,
      );
    }
    return json;
  } catch (error) {
    if (error instanceof ProductionMoovError) throw error;
    if (isProviderNetworkError(error)) {
      const wrapped = new ProductionMoovError(providerEgressFailure('moov').message, 502, {
        error: 'provider_egress_failure',
      });
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

export const listOf = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.capabilities)) return value.capabilities;
  if (Array.isArray(value?.paymentMethods)) return value.paymentMethods;
  if (Array.isArray(value?.wallets)) return value.wallets;
  if (Array.isArray(value?.bankAccounts)) return value.bankAccounts;
  return [];
};
