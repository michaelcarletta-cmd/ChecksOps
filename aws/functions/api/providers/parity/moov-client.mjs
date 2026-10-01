/**
 * Faithful Node port of supabase/functions/_shared/moovClient.ts.
 * Credentials are injected per request. Production keys are never used unless
 * AWS production execution flags are all true (they stay false on staging).
 * Pinned API version: v2024.01.00
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const MOOV_HOSTS = {
  sandbox: 'https://api.moov.io',
  production: 'https://api.moov.io',
};

export const MOOV_PINNED_VERSION = 'v2024.01.00';

const envStore = new AsyncLocalStorage();

export function bindMoovEnvironment(env) {
  const normalized = String(env || '').toLowerCase();
  if (!MOOV_HOSTS[normalized]) return;
  envStore.enterWith(normalized);
}

export function withMoovEnvironment(env, fn) {
  const normalized = String(env || '').toLowerCase();
  return MOOV_HOSTS[normalized] ? envStore.run(normalized, fn) : fn();
}

export function moovEnvironment() {
  const ctx = getMoovContext();
  const env = (envStore.getStore() || ctx?.environment || 'sandbox').toLowerCase();
  if (!MOOV_HOSTS[env]) {
    throw new Error(`MOOV_ENVIRONMENT must be "sandbox" or "production", got "${env}"`);
  }
  return env;
}

export function moovIsSandbox() {
  return moovEnvironment() === 'sandbox';
}

export function moovHost() {
  return MOOV_HOSTS[moovEnvironment()];
}

const credStore = new AsyncLocalStorage();

export function withMoovContext(context, fn) {
  return credStore.run(context, () => withMoovEnvironment(context.environment, fn));
}

export function getMoovContext() {
  return credStore.getStore() || null;
}

function credentialsFor(env) {
  const ctx = getMoovContext();
  if (!ctx) return {};
  if (env === 'sandbox') {
    return { key: ctx.sandboxPublicKey, secret: ctx.sandboxSecretKey };
  }
  return { key: ctx.productionPublicKey, secret: ctx.productionSecretKey };
}

export function moovConfigured(env) {
  const { key, secret } = credentialsFor(env ?? moovEnvironment());
  return !!(key && secret);
}

function credentials() {
  const env = moovEnvironment();
  const { key, secret } = credentialsFor(env);
  if (!key || !secret) {
    const prefix = env === 'sandbox' ? 'MOOV_SANDBOX_' : 'MOOV_';
    throw new Error(
      `Moov is not configured for the ${env} environment. ${prefix}PUBLIC_KEY and ${prefix}SECRET_KEY must be set.`,
    );
  }
  return { key, secret };
}

export function moovOrigin() {
  const ctx = getMoovContext();
  const sandbox = moovEnvironment() === 'sandbox' ? ctx?.sandboxOrigin : null;
  const raw = sandbox || ctx?.allowedOrigin || ctx?.appUrl || 'https://checksops.com';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://checksops.com';
  }
}

export class MoovError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'MoovError';
    this.status = status;
    this.body = body;
  }
}

const tokenCache = new Map();

export const resetMoovTokenCache = () => tokenCache.clear();

export async function moovToken(scopes, requestOrigin, fetchImpl = fetch) {
  const scope = scopes.join(' ');
  const origin = requestOrigin ?? moovOrigin();
  const cacheKey = `${moovEnvironment()}|${origin}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const { key, secret } = credentials();
  const basic = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetchImpl(`${moovHost()}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new MoovError('Could not authenticate with the payment provider', res.status, body ?? text);
  }
  const token = body?.access_token;
  const ttl = Number(body?.expires_in ?? 300) * 1000;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl });
  return token;
}

export const scopes = {
  accountsWrite: () => ['/accounts.write'],
  accountsRead: () => ['/accounts.read'],
  accountRead: (id) => [`/accounts/${id}/profile.read`],
  accountWrite: (id) => [`/accounts/${id}/profile.write`],
  capabilitiesRead: (id) => [`/accounts/${id}/capabilities.read`],
  capabilitiesWrite: (id) => [`/accounts/${id}/capabilities.write`],
  bankAccountsRead: (id) => [`/accounts/${id}/bank-accounts.read`],
  bankAccountsWrite: (id) => [`/accounts/${id}/bank-accounts.write`],
  paymentMethodsRead: (id) => [`/accounts/${id}/payment-methods.read`],
  transfersWrite: (id) => [`/accounts/${id}/transfers.write`],
  transfersRead: (id) => [`/accounts/${id}/transfers.read`],
  representativesWrite: (id) => [`/accounts/${id}/representatives.write`],
  representativesRead: (id) => [`/accounts/${id}/representatives.read`],
  filesRead: (id) => [`/accounts/${id}/files.read`],
  filesWrite: (id) => [`/accounts/${id}/files.write`],
  dropBankLink: (id) => [
    `/accounts/${id}/bank-accounts.write`,
    `/accounts/${id}/bank-accounts.read`,
    `/accounts/${id}/profile.read`,
    `/accounts/${id}/profile.write`,
  ],
  dropTos: (id) => [
    `/accounts/${id}/profile.write`,
    `/accounts/${id}/profile.read`,
    '/ping.read',
  ],
};

const facilitatorCache = new Map();
export const resetFacilitatorCache = () => facilitatorCache.clear();

export async function facilitatorAccountId(hintAccountId, fetchImpl = fetch) {
  const env = moovEnvironment();
  const ctx = getMoovContext();
  const fromEnv = env === 'sandbox' ? ctx?.sandboxPlatformAccountId : ctx?.productionPlatformAccountId;
  if (fromEnv) return fromEnv;
  const cached = facilitatorCache.get(env);
  if (cached) return cached;
  if (!hintAccountId) throw new Error('Facilitator account id is not configured.');
  const methods = await moovFetch(`/accounts/${hintAccountId}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(hintAccountId),
    fetchImpl,
  }).catch(() => []);
  const partner = (methods ?? [])
    .map((m) => m?.wallet?.partnerAccountID ?? m?.wallet?.partnerAccountId)
    .find(Boolean);
  const resolved = partner ?? hintAccountId;
  facilitatorCache.set(env, resolved);
  return resolved;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function idempotencyUuid(seed) {
  if (UUID_RE.test(seed)) return seed;
  const digest = createHash('sha256').update(String(seed || '')).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Buffer.from(digest).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function moovFetch(path, opts = {}) {
  const fetchImpl = opts.fetchImpl || getMoovContext()?.fetchImpl || fetch;
  const token = await moovToken(opts.scopes, undefined, fetchImpl);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: moovOrigin(),
    'x-moov-version': opts.apiVersion ?? getMoovContext()?.apiVersion ?? MOOV_PINNED_VERSION,
  };
  if (opts.idempotencyKey) headers['X-Idempotency-Key'] = await idempotencyUuid(opts.idempotencyKey);
  if (opts.onBehalfOf) headers['X-Account-ID'] = opts.onBehalfOf;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

  const res = await fetchImpl(`${moovHost()}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    let msg = json?.error ?? json?.message ?? text ?? `Moov ${path} failed`;
    if (json?.errors) {
      const details = Object.entries(json.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
      msg = `${msg} (${details})`;
    }
    let userMessage = typeof msg === 'string' ? msg : JSON.stringify(msg);
    if (res.status === 401) userMessage = 'Authentication failed with the payment provider. Please check credentials or origin white-listing.';
    if (res.status === 403) userMessage = 'Action forbidden. This account may lack the required permissions or capabilities.';
    if (res.status === 404) userMessage = 'Resource not found on the payment provider.';
    if (res.status === 429) userMessage = 'Rate limit exceeded. Please try again in a moment.';
    throw new MoovError(userMessage, res.status, json ?? text);
  }
  return json;
}

export function normalizeTransferStatus(moovStatus) {
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

export function normalizeOnboardingStatus(input) {
  if (input.disabled) return 'suspended';
  const v = String(input.verificationStatus ?? '').toLowerCase();
  const caps = input.capabilities ?? [];
  const enabled = caps.filter((c) => c.status === 'enabled');
  if (v === 'failed' || v === 'resubmit') return 'restricted';
  if (caps.some((c) => c.status === 'pending')) return 'verification_pending';
  if (caps.some((c) => c.status === 'errored')) return 'additional_information_required';
  if (v === 'verified' && enabled.length > 0) return 'active';
  if (caps.length === 0) return 'onboarding_incomplete';
  if (v === 'pending' || v === 'review') return 'verification_pending';
  return 'onboarding_incomplete';
}

export { capabilityFlags } from './moov-capabilities.mjs';

export function safeLastFour(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export async function pendingCapabilities(accountId, fetchImpl = fetch) {
  const caps = await moovFetch(`/accounts/${accountId}/capabilities`, {
    method: 'GET',
    scopes: scopes.capabilitiesRead(accountId),
    fetchImpl,
  });
  return (caps ?? []).filter((c) => c.status !== 'enabled').map((c) => c.capability);
}

export function lastMoovRequestHeaders(opts = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: moovOrigin(),
    'x-moov-version': opts.apiVersion ?? getMoovContext()?.apiVersion ?? MOOV_PINNED_VERSION,
  };
}
