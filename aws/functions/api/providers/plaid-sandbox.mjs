import { PLAID_SANDBOX_HOST } from '../sandbox-credentials.mjs';

export const assertPlaidSandboxCredentials = (credentials) => {
  if (!credentials) {
    return {
      ok: false,
      statusCode: 409,
      error: 'sandbox_credentials_unavailable',
      provider: 'plaid',
      message: 'Plaid sandbox credentials are not configured on AWS. Plaid is not required for the deposit→disburse money path.',
      relevantToMoneyPath: false,
    };
  }
  if (credentials.environment !== 'sandbox' || credentials.host !== PLAID_SANDBOX_HOST) {
    return {
      ok: false,
      statusCode: 403,
      error: 'production_credentials_refused',
      provider: 'plaid',
      message: 'Plaid sandbox adapter refuses production.plaid.com and production credentials.',
    };
  }
  return { ok: true };
};

export const plaidSandboxFetch = async ({
  credentials,
  path,
  body = {},
  fetchImpl = fetch,
} = {}) => {
  const gate = assertPlaidSandboxCredentials(credentials);
  if (!gate.ok) return gate;
  const response = await fetchImpl(`${PLAID_SANDBOX_HOST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: credentials.clientId,
      secret: credentials.secret,
      ...body,
    }),
  });
  let json = null;
  const text = await response.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: 'plaid_sandbox_http_failed',
      provider: 'plaid',
      httpStatus: response.status,
      path,
      plaidError: json?.error_code || null,
    };
  }
  return { ok: true, statusCode: response.status, data: json };
};

export const buildPlaidLinkTokenBody = ({ applicationUserId, tenantId } = {}) => ({
  user: { client_user_id: String(applicationUserId || 'sandbox-user') },
  client_name: 'ChecksOps AWS sandbox',
  products: ['auth'],
  country_codes: ['US'],
  language: 'en',
  webhook: null,
  tenant_from_payload_ignored: tenantId || null,
});
