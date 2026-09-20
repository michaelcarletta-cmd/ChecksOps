import { createHash } from 'node:crypto';
import { formatMoovTransferAmount, MOOV_AMOUNT_API, MIN_PROVIDER_AMOUNT_CENTS } from './amounts.mjs';
import { isProviderNetworkError, MOOV_SANDBOX_HOST, providerEgressFailure } from '../sandbox-credentials.mjs';

export const SANDBOX_MIN_CENTS = MIN_PROVIDER_AMOUNT_CENTS;
export const MOOV_SANDBOX_API_VERSION_DEFAULT = 'v2024.01.00';
export const MOOV_SANDBOX_AMOUNT_API = {
  ...MOOV_AMOUNT_API,
  pinnedRequestVersion: MOOV_SANDBOX_API_VERSION_DEFAULT,
  documentedAmountVersions: ['v2026.04.00', 'v2026.07.00'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const redactProviderId = (value) => {
  const raw = String(value || '');
  if (!raw) return null;
  if (raw.length <= 8) return '[redacted]';
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
};

export const idempotencyUuid = (seed) => {
  if (UUID_RE.test(String(seed || ''))) return String(seed);
  const digest = createHash('sha256').update(String(seed || '')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const assertMoovSandboxCredentials = (credentials) => {
  if (!credentials) {
    return {
      ok: false,
      statusCode: 409,
      error: 'sandbox_credentials_unavailable',
      provider: 'moov',
      message: 'MOOV_SANDBOX_PUBLIC_KEY and MOOV_SANDBOX_SECRET_KEY are not configured on AWS. Production Moov keys will not be substituted.',
    };
  }
  if (credentials.environment !== 'sandbox') {
    return {
      ok: false,
      statusCode: 403,
      error: 'production_credentials_refused',
      provider: 'moov',
      message: 'Sandbox adapter refuses non-sandbox Moov credentials.',
    };
  }
  if (!credentials.publicKey || !credentials.secretKey) {
    return {
      ok: false,
      statusCode: 409,
      error: 'sandbox_credentials_unavailable',
      provider: 'moov',
    };
  }
  if (credentials.host && credentials.host !== MOOV_SANDBOX_HOST) {
    return {
      ok: false,
      statusCode: 403,
      error: 'unexpected_moov_host',
      provider: 'moov',
    };
  }
  return { ok: true };
};

const originOf = (credentials) => {
  const raw = credentials.origin || 'https://checksops.com';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'https://checksops.com';
  }
};

const parseBody = async (response) => {
  const text = await response.text();
  if (!text) return { text: '', json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
};

export const moovSandboxToken = async ({ credentials, scopes = ['/accounts.read'], fetchImpl = fetch } = {}) => {
  const gate = assertMoovSandboxCredentials(credentials);
  if (!gate.ok) return gate;
  const basic = Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64');
  try {
    const response = await fetchImpl(`${MOOV_SANDBOX_HOST}/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: originOf(credentials),
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: scopes.join(' '),
      }).toString(),
    });
    const parsed = await parseBody(response);
    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        error: 'moov_sandbox_auth_failed',
        provider: 'moov',
        httpStatus: response.status,
        message: 'Moov sandbox OAuth failed. No production keys were used.',
      };
    }
    return {
      ok: true,
      accessTokenPresent: Boolean(parsed.json?.access_token),
      expiresIn: Number(parsed.json?.expires_in || 0) || null,
      token: parsed.json?.access_token || null,
      tokenType: parsed.json?.token_type || null,
      grantedScope: parsed.json?.scope || null,
    };
  } catch (error) {
    if (isProviderNetworkError(error)) return providerEgressFailure('moov');
    throw error;
  }
};

export const moovSandboxFetch = async ({
  credentials,
  path,
  method = 'GET',
  scopes,
  body,
  idempotencyKey,
  fetchImpl = fetch,
  token,
} = {}) => {
  const gate = assertMoovSandboxCredentials(credentials);
  if (!gate.ok) return gate;
  let bearer = token;
  if (!bearer) {
    const authed = await moovSandboxToken({ credentials, scopes, fetchImpl });
    if (!authed.ok) return authed;
    bearer = authed.token;
  }
  const headers = {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
    Origin: originOf(credentials),
    'x-moov-version': credentials.apiVersion || MOOV_SANDBOX_API_VERSION_DEFAULT,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyUuid(idempotencyKey);
  try {
    const response = await fetchImpl(`${MOOV_SANDBOX_HOST}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await parseBody(response);
    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        error: 'moov_sandbox_http_failed',
        provider: 'moov',
        httpStatus: response.status,
        path,
        message: parsed.json?.error || parsed.json?.message || parsed.json?.title
          || parsed.json?.errorCode || 'Moov sandbox request failed',
        errorCode: parsed.json?.errorCode || parsed.json?.code || null,
        errorTitle: parsed.json?.title || null,
      };
    }
    return { ok: true, statusCode: response.status, data: parsed.json, idempotencyKey: headers['X-Idempotency-Key'] || null };
  } catch (error) {
    if (isProviderNetworkError(error)) return providerEgressFailure('moov', { path });
    throw error;
  }
};

export const collectMoovAccountIds = (payload) => {
  const rows = Array.isArray(payload)
    ? payload
    : (payload?.accounts || payload?.items || payload?.data || []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => row?.accountID || row?.accountId || row?.account_id || row?.id)
    .filter(Boolean)
    .map((id) => String(id));
};

export const collectMoovPaymentMethods = (payload) => {
  const rows = Array.isArray(payload)
    ? payload
    : (payload?.paymentMethods || payload?.items || payload?.data || []);
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    id: row?.paymentMethodID || row?.paymentMethodId || row?.id || null,
    type: row?.paymentMethodType || row?.type || null,
    walletId: row?.wallet?.walletID || row?.walletID || row?.walletId || null,
  })).filter((row) => row.id);
};

export const collectMoovTransferIds = (payload) => {
  const rows = Array.isArray(payload)
    ? payload
    : (payload?.transfers || payload?.items || payload?.data || []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => row?.transferID || row?.transferId || row?.id)
    .filter(Boolean)
    .map((id) => String(id));
};

export const buildMoovSandboxTransferBody = ({
  sourcePaymentMethodId,
  destinationPaymentMethodId,
  amountCents = SANDBOX_MIN_CENTS,
  description = 'AWS sandbox validation',
} = {}) => {
  const formatted = formatMoovTransferAmount(amountCents);
  if (formatted.error) return formatted;
  return {
    source: { paymentMethodID: sourcePaymentMethodId },
    destination: { paymentMethodID: destinationPaymentMethodId },
    amount: formatted.amount,
    description,
  };
};

export const normalizeMoovSandboxTransfer = (payload = {}) => ({
  provider: 'moov',
  environment: 'sandbox',
  provider_transfer_id: payload.transferID || payload.transferId || payload.id || null,
  status: payload.status || null,
  amount_cents: payload.amount?.value ?? null,
  currency: payload.amount?.currency || 'USD',
  redacted_id: redactProviderId(payload.transferID || payload.transferId || payload.id),
});

export const moovSandboxScopes = {
  accountsRead: () => ['/accounts.read'],
  accountRead: (id) => [`/accounts/${id}/profile.read`],
  walletsRead: (id) => [`/accounts/${id}/wallets.read`],
  capabilitiesRead: (id) => [`/accounts/${id}/capabilities.read`],
  bankAccountsRead: (id) => [`/accounts/${id}/bank-accounts.read`],
  paymentMethodsRead: (id) => [`/accounts/${id}/payment-methods.read`],
  transfersWrite: (id) => [`/accounts/${id}/transfers.write`],
  transfersRead: (id) => [`/accounts/${id}/transfers.read`],
};

/** Prefer a fundable sandbox pair (ACH debit → wallet, else wallet → ACH credit). */
export const pickMoovSandboxTransferMethods = (methods = []) => {
  const rows = Array.isArray(methods) ? methods.filter((row) => row?.id) : [];
  const byType = (type) => rows.find((row) => row.type === type) || null;
  const wallet = byType('moov-wallet');
  const debit = byType('ach-debit-fund') || byType('ach-debit-collect');
  const credit = byType('ach-credit-standard') || byType('ach-credit-same-day') || byType('rtp-credit');
  if (debit && wallet && debit.id !== wallet.id) {
    return { source: debit, destination: wallet, pairing: 'ach_debit_to_wallet' };
  }
  if (wallet && credit && wallet.id !== credit.id) {
    return { source: wallet, destination: credit, pairing: 'wallet_to_ach_credit' };
  }
  if (rows[0]?.id && rows[1]?.id && rows[0].id !== rows[1].id) {
    return { source: rows[0], destination: rows[1], pairing: 'first_two_distinct' };
  }
  return { source: null, destination: null, pairing: null };
};
