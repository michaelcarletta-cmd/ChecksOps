import { formatCheckAltUserAmount, dollarsToIntegerCents, validateProviderCents } from './amounts.mjs';
import { looksLikeSandboxHost } from '../sandbox-credentials.mjs';
import { SANDBOX_MIN_CENTS } from './moov-sandbox.mjs';

export const assertCheckAltSandboxCredentials = (credentials) => {
  if (!credentials) {
    return {
      ok: false,
      statusCode: 409,
      error: 'sandbox_credentials_unavailable',
      provider: 'checkalt',
      message: 'No dedicated CheckAlt/FinCapture sandbox URL and credentials are configured. Production CHECKALT_* keys will not be substituted. CheckAlt production execution stays disabled.',
      limitation: 'no_sandbox_fincapture_environment',
    };
  }
  if (credentials.environment !== 'sandbox' || !looksLikeSandboxHost(credentials.baseUrl)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'production_credentials_refused',
      provider: 'checkalt',
      message: 'CheckAlt sandbox adapter refuses production FinCapture hosts and credentials.',
    };
  }
  return { ok: true };
};

export const buildCheckAltSandboxDeposit = ({ amountCents = SANDBOX_MIN_CENTS, reference } = {}) => {
  const validated = validateProviderCents(amountCents);
  if (validated.error) return validated;
  const dollars = validated.cents / 100;
  const formatted = formatCheckAltUserAmount(dollars);
  return {
    userAmount: formatted.userAmount,
    scale: 'integer_cents',
    sourceDollars: dollars,
    reference: reference || null,
    negotiableCheck: false,
    imageIncluded: false,
  };
};

export const checkAltSandboxAuthenticate = async ({ credentials, fetchImpl = fetch } = {}) => {
  const gate = assertCheckAltSandboxCredentials(credentials);
  if (!gate.ok) return gate;
  const response = await fetchImpl(`${credentials.baseUrl}/public/fincapture/authenticate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(credentials.merchant ? { merchant: credentials.merchant } : {}),
    },
    body: JSON.stringify({ userName: credentials.username, password: credentials.password }),
  });
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: 'checkalt_sandbox_auth_failed',
      provider: 'checkalt',
      httpStatus: response.status,
    };
  }
  let tokenPresent = false;
  if (text.includes('.')) tokenPresent = true;
  return { ok: true, tokenPresent, httpStatus: response.status, rawToken: text };
};

export const checkAltSandboxFetch = async ({
  credentials,
  path,
  body,
  fetchImpl = fetch,
  token,
} = {}) => {
  const gate = assertCheckAltSandboxCredentials(credentials);
  if (!gate.ok) return gate;
  let jwt = token;
  if (!jwt) {
    const authed = await checkAltSandboxAuthenticate({ credentials, fetchImpl });
    if (!authed.ok) return authed;
    jwt = authed.rawToken;
  }
  const response = await fetchImpl(`${credentials.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(jwt).replace(/^"|"$/g, '')}`,
      ...(credentials.fiKey ? { fi_key: credentials.fiKey } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  const text = await response.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: 'checkalt_sandbox_http_failed',
      provider: 'checkalt',
      httpStatus: response.status,
      path,
    };
  }
  return { ok: true, statusCode: response.status, data: json };
};

export { dollarsToIntegerCents };
