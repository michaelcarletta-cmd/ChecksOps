import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import {
  PRODUCTION_MOOV_API_VERSION,
  PRODUCTION_MOOV_HOST,
  PRODUCTION_MOOV_ORIGIN,
} from './moov-secrets.mjs';
import { productionMoovOnboardingWritesAllowed } from './moov-holds.mjs';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export const redactMoovText = (value) => String(value || '').replace(UUID_RE, '{id}');

export const fingerprintMoovId = (value) => {
  const match = String(value || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) return null;
  const id = match[0].toLowerCase();
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
};

export const PRODUCTION_MOOV_OAUTH_HEADER_NAMES = Object.freeze([
  'Authorization',
  'Content-Type',
  'Origin',
]);

export const PRODUCTION_MOOV_GET_HEADER_NAMES = Object.freeze([
  'Authorization',
  'Content-Type',
  'Accept',
  'Origin',
  'x-moov-version',
]);

const claimValue = (payload, keys) => {
  for (const key of keys) {
    if (payload?.[key] != null && payload[key] !== '') return payload[key];
  }
  return null;
};

export function inspectAccessTokenMetadata(token) {
  const raw = String(token || '');
  const info = {
    present: Boolean(raw),
    length: raw.length,
    looks_like_jwt: raw.split('.').length === 3,
    starts_with_eyJ: raw.startsWith('eyJ'),
    leading_whitespace: raw.length > 0 && raw[0].trim() === '',
    trailing_whitespace: raw.length > 0 && raw[raw.length - 1].trim() === '',
  };
  if (!info.looks_like_jwt) return info;
  try {
    const payload = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8'));
    const account = claimValue(payload, ['accountID', 'account_id', 'accountId', 'account']);
    info.claim_keys = Object.keys(payload).sort();
    const scope = claimValue(payload, ['scope', 'scp']);
    info.scope = scope ? redactMoovText(String(scope)) : null;
    info.aud = claimValue(payload, ['aud', 'audience']) || null;
    info.iss = payload.iss || null;
    info.origin_claim = claimValue(payload, ['origin', 'allowed_origin', 'allowedOrigin']) || null;
    info.token_type_claim = claimValue(payload, ['token_type', 'typ', 'tokenType']) || null;
    info.account_fp = fingerprintMoovId(account);
    info.aid_fp = fingerprintMoovId(payload.aid);
    info.caid_fp = fingerprintMoovId(payload.caid);
    info.sid_fp = fingerprintMoovId(payload.sid);
    if (payload.cam != null) info.cam = payload.cam;
    if (payload.ct != null) info.ct = payload.ct;
    info.aip_fp = fingerprintMoovId(payload.aip);
    if (Array.isArray(payload.auds)) {
      info.auds = payload.auds.map((value) => redactMoovText(String(value)));
    }
    info.exp_seconds_remaining = payload.exp
      ? Number(payload.exp) - Math.floor(Date.now() / 1000)
      : null;
  } catch {
    info.jwt_decode_failed = true;
  }
  return info;
}

export function oauthResponseMetadata(json, status, requestedScope, { cacheHit = false } = {}) {
  const keys = json && typeof json === 'object'
    ? Object.keys(json).filter((key) => !/token/i.test(key))
    : [];
  return {
    http: status,
    cache_hit: cacheHit === true,
    token_type: json?.token_type || json?.tokenType || null,
    expires_in: json?.expires_in ?? json?.expiresIn ?? null,
    scope_returned: json?.scope ? redactMoovText(String(json.scope)) : null,
    audience: json?.audience || json?.aud || null,
    requested_scope: redactMoovText(requestedScope || ''),
    response_keys: keys,
    has_access_token: Boolean(json?.access_token),
    token: inspectAccessTokenMetadata(json?.access_token),
  };
}

const publicGetFailure = (response, json, text) => {
  const headers = response?.headers;
  const headerGet = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
  const bodyKeys = json && typeof json === 'object' ? Object.keys(json).slice(0, 30) : [];
  return {
    www_authenticate: headerGet('www-authenticate') || headerGet('WWW-Authenticate') || null,
    request_id: headerGet('x-request-id') || headerGet('X-Request-Id') || null,
    content_type: headerGet('content-type') || null,
    moov_version_echo: headerGet('x-moov-version') || headerGet('X-Moov-Version') || null,
    body_keys: bodyKeys,
    body_bytes: text ? String(text).length : 0,
    provider_error: publicMoovErrorBody(json),
  };
};

export const publicMoovErrorBody = (body) => {
  if (body == null) return null;
  if (typeof body !== 'object') {
    return { error: redactMoovText(String(body)).slice(0, 160) };
  }
  const code = body.error || body.errorCode || body.error_code || body.code || null;
  return {
    error: code ? redactMoovText(String(code)).slice(0, 160) : null,
  };
};

export class ProductionMoovError extends Error {
  constructor(message, status, body) {
    super(redactMoovText(message));
    this.name = 'ProductionMoovError';
    this.status = status;
    this.body = body;
  }
}

const tokenCache = new Map();

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** GET paths allowed in read mode. OAuth token POST is handled separately. */
export const PRODUCTION_MOOV_READ_PATH_RE = new RegExp(
  '^/accounts/[^/?#]+'
  + '(?:'
    + '|/capabilities(?:/[A-Za-z0-9._-]+)?'
    + '|/wallets(?:/[^/?#]+)?'
    + '|/bank-accounts(?:/[^/?#]+)?'
    + '|/payment-methods(?:/[^/?#]+)?'
    + '|/transfers/[^/?#]+'
    + '|/underwriting'
    + '|/files(?:/[^/?#]+)?'
    + '|/representatives(?:/[^/?#]+)?'
  + ')?$',
);

/** Paths production onboarding mode may POST/PATCH/PUT. Never transfers. */
export const PRODUCTION_MOOV_ONBOARD_PATH_RE = new RegExp(
  '^/accounts(?:'
    + '|/[^/?#]+(?:'
      + '|/capabilities'
      + '|/underwriting'
      + '|/representatives(?:/[^/?#]+)?'
      + '|/files'
      + '|/bank-accounts(?:/[^/?#]+(?:/micro-deposits)?)?'
      + '|/tos-acceptances'
    + ')'
  + ')?$',
);

export const isProductionMoovOnboardPath = (path) => PRODUCTION_MOOV_ONBOARD_PATH_RE.test(String(path || ''));

export const isProductionMoovReadPath = (path) => PRODUCTION_MOOV_READ_PATH_RE.test(String(path || ''));

export const assertReadOnlyMoovRequest = ({ method = 'GET', path } = {}) => {
  const verb = String(method || 'GET').toUpperCase();
  if (WRITE_METHODS.has(verb)) {
    const error = new ProductionMoovError(
      'Read-only Moov authorization cannot POST, PUT, PATCH, or DELETE',
      403,
      { error: 'read_only_method_denied', method: verb, path: path || null },
    );
    error.code = 'read_only_method_denied';
    throw error;
  }
  if (verb !== 'GET') {
    const error = new ProductionMoovError(
      'Read-only Moov authorization allows GET only',
      403,
      { error: 'read_only_method_denied', method: verb, path: path || null },
    );
    error.code = 'read_only_method_denied';
    throw error;
  }
  if (!isProductionMoovReadPath(path)) {
    const error = new ProductionMoovError(
      'Path is not on the production Moov GET allowlist',
      403,
      { error: 'read_only_path_denied', method: verb, path: path || null },
    );
    error.code = 'read_only_path_denied';
    throw error;
  }
};

const assertProductionCredentials = (credentials, { mode } = {}) => {
  if (!credentials || credentials.environment !== 'production') {
    throw new ProductionMoovError('Production Moov credentials are required', 503, { error: 'production_secret_missing' });
  }
  if (credentials.host && credentials.host !== PRODUCTION_MOOV_HOST) {
    throw new ProductionMoovError('Unapproved Moov host', 503, { error: 'production_host_refused' });
  }
  if (credentials.origin !== PRODUCTION_MOOV_ORIGIN) {
    throw new ProductionMoovError('Unapproved Moov origin', 503, { error: 'production_origin_refused' });
  }
  if (!credentials.publicKey || !credentials.secretKey) {
    throw new ProductionMoovError('Production Moov credentials incomplete', 503, { error: 'production_secret_missing' });
  }
  if (mode === 'execute' && !credentials.platformAccountId) {
    throw new ProductionMoovError('Production Moov facilitator account is required', 503, { error: 'production_secret_missing' });
  }
  if (String(credentials.publicKey).startsWith('MOOV_SANDBOX')
    || String(credentials.secretKey).includes('SANDBOX')) {
    throw new ProductionMoovError('Sandbox credentials refused', 503, { error: 'sandbox_credential_contamination' });
  }
};

export async function productionMoovTokenDetailed({ credentials, scopes = ['/accounts.read'], fetchImpl = fetch, mode } = {}) {
  assertProductionCredentials(credentials, { mode });
  const scope = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
  const cacheKey = `${credentials.publicKey}|${credentials.origin}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return {
      token: cached.token,
      cacheHit: true,
      meta: {
        ...oauthResponseMetadata({
          access_token: cached.token,
          token_type: 'Bearer',
          scope,
        }, 200, scope, { cacheHit: true }),
        origin_sent: PRODUCTION_MOOV_ORIGIN,
        oauth_headers: [...PRODUCTION_MOOV_OAUTH_HEADER_NAMES],
        authorization_scheme: 'Basic',
      },
    };
  }

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
  const meta = {
    ...oauthResponseMetadata(json, response.status, scope, { cacheHit: false }),
    origin_sent: PRODUCTION_MOOV_ORIGIN,
    oauth_headers: [...PRODUCTION_MOOV_OAUTH_HEADER_NAMES],
    authorization_scheme: 'Basic',
    content_type: response.headers?.get?.('content-type') || null,
  };
  if (!response.ok) {
    const error = new ProductionMoovError('Could not authenticate with the payment provider', response.status, json ?? text);
    error.oauth = meta;
    throw error;
  }
  const token = json?.access_token;
  const ttl = Number(json?.expires_in ?? 300) * 1000;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl });
  meta.token = inspectAccessTokenMetadata(token);
  return { token, cacheHit: false, meta };
}

export async function productionMoovToken({ credentials, scopes = ['/accounts.read'], fetchImpl = fetch, mode } = {}) {
  const { token } = await productionMoovTokenDetailed({ credentials, scopes, fetchImpl, mode });
  return token;
}

export function assertOnboardMoovRequest({ method = 'GET', path } = {}) {
  const verb = String(method || 'GET').toUpperCase();
  if (verb === 'GET') {
    assertReadOnlyMoovRequest({ method: verb, path });
    return;
  }
  if (!WRITE_METHODS.has(verb)) {
    const error = new ProductionMoovError('Onboard mode allows GET or write verbs only', 403, {
      error: 'onboard_method_denied', method: verb, path: path || null,
    });
    error.code = 'onboard_method_denied';
    throw error;
  }
  if (!isProductionMoovOnboardPath(path)) {
    const error = new ProductionMoovError('Path is not on the production Moov onboarding allowlist', 403, {
      error: 'onboard_path_denied', method: verb, path: path || null,
    });
    error.code = 'onboard_path_denied';
    throw error;
  }
  if (/\/transfers(?:\/|$)/i.test(String(path || ''))) {
    const error = new ProductionMoovError('Onboarding mode cannot create transfers', 403, {
      error: 'onboard_transfer_denied', method: verb, path: path || null,
    });
    error.code = 'onboard_transfer_denied';
    throw error;
  }
}

export async function productionMoovFetch({
  credentials,
  path,
  method = 'GET',
  body,
  idempotencyKey = null,
  scopes,
  fetchImpl = fetch,
  mode,
} = {}) {
  if (mode !== 'read' && mode !== 'execute' && mode !== 'onboard') {
    throw new ProductionMoovError('Moov HTTP mode must be read, onboard, or execute', 500, { error: 'moov_mode_required' });
  }
  const verb = String(method || 'GET').toUpperCase();
  if (mode === 'read') {
    assertReadOnlyMoovRequest({ method: verb, path });
  }
  if (mode === 'onboard') {
    if (!productionMoovOnboardingWritesAllowed()) {
      const error = new ProductionMoovError('Onboarding writes remain dark', 403, { error: 'production_onboarding_blocked' });
      error.code = 'production_onboarding_blocked';
      throw error;
    }
    assertOnboardMoovRequest({ method: verb, path });
  }
  assertProductionCredentials(credentials, { mode });
  const minted = await productionMoovTokenDetailed({ credentials, scopes, fetchImpl, mode });
  const token = minted.token;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: PRODUCTION_MOOV_ORIGIN,
    'x-moov-version': credentials.apiVersion || PRODUCTION_MOOV_API_VERSION,
  };
  if (idempotencyKey) headers['X-Idempotency-Key'] = String(idempotencyKey);
  const response = await fetchImpl(`${PRODUCTION_MOOV_HOST}${path}`, {
    method: verb,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  const diagnosis = {
    oauth: minted.meta,
    cache_hit: minted.cacheHit === true,
    get_headers: [...PRODUCTION_MOOV_GET_HEADER_NAMES],
    authorization_scheme: 'Bearer',
    origin_sent: PRODUCTION_MOOV_ORIGIN,
    api_version: credentials.apiVersion || PRODUCTION_MOOV_API_VERSION,
    ...publicGetFailure(response, json, text),
  };
  if (!response.ok) {
    const error = new ProductionMoovError(
      json?.error || json?.message || `Moov ${redactMoovText(path)} failed`,
      response.status,
      json ?? text,
    );
    error.diagnosis = diagnosis;
    throw error;
  }
  return { ok: true, status: response.status, json, raw: text, diagnosis };
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
