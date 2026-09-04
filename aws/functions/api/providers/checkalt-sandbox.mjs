import { createHash } from 'node:crypto';
import { formatCheckAltUserAmount, dollarsToIntegerCents, validateProviderCents } from './amounts.mjs';
import {
  CHECKALT_UAT_HOST,
  CHECKALT_UAT_MERCHANT_EXPECTED,
  isApprovedCheckAltMerchant,
  isApprovedCheckAltUatUrl,
  isProviderNetworkError,
  merchantHeaderForCheckAltUat,
  providerEgressFailure,
} from '../sandbox-credentials.mjs';
import { SANDBOX_MIN_CENTS } from './moov-sandbox.mjs';

/**
 * CheckAlt FinCapture `userAmount` is integer cents with no decimal point.
 *
 * Authoritative evidence (do not treat as dollars):
 * 1. Production `checkalt-submit-deposit` records CheckAlt support guidance:
 *    send integer cents (`$123.45 → 12345`). A dollar pass-through caused
 *    "RDC Amount Mismatch" against OCR cents on the image.
 * 2. ChecksOps `providers/amounts.mjs` and T6 certification use the same map.
 *
 * Adapter conversion is 1:1: ChecksOps integer cents === CheckAlt `userAmount`.
 */
export const CHECKALT_USER_AMOUNT = {
  provider: 'checkalt',
  environment: 'uat',
  field: 'userAmount',
  scale: 'integer_cents',
  evidence: [
    'checkalt-submit-deposit CheckAlt support: integer cents, no decimal point',
    'RDC Amount Mismatch when dollars were sent',
    'T6 certification 123.45 → 12345',
  ],
  examples: [
    { dollars: 0.01, checksOpsCents: 1, userAmount: 1 },
    { dollars: 1.0, checksOpsCents: 100, userAmount: 100 },
    { dollars: 123.45, checksOpsCents: 12345, userAmount: 12345 },
  ],
};

/**
 * Production CheckAlt authenticates at /public/fincapture/authenticate with
 * exactly { userName, password }. UAT validation uses that same contract first.
 * The vendor-provided jwtauth endpoint remains a UAT-only fallback on 404.
 */
export const CHECKALT_UAT_AUTH_PATH = '/public/fincapture/authenticate';
export const CHECKALT_UAT_AUTH_PATH_FALLBACK = '/public/jwtauth/authenticate';
export const CHECKALT_UAT_AUTH_PATHS = [CHECKALT_UAT_AUTH_PATH, CHECKALT_UAT_AUTH_PATH_FALLBACK];

export const extractCheckAltSsoAndAccount = (userData = {}, depositData = {}) => {
  const list = Array.isArray(userData?.accountDataList)
    ? userData.accountDataList
    : (Array.isArray(depositData?.accountDataList) ? depositData.accountDataList : []);
  const pickSso = (row = {}) => (
    row.ssoKey || row.SSOKey || row.SsoKey || row.sso_key || row.userSsoKey || row.ssoUserId || null
  );
  const first = list[0] || {};
  const ssoKey = pickSso(first) || pickSso(userData) || pickSso(depositData) || list.map(pickSso).find(Boolean) || null;
  const depositAccountNumber = first.accountNumber
    || first.AccountNumber
    || first.depositAccountNumber
    || depositData?.accountNumber
    || depositData?.depositAccountNumber
    || depositData?.accountDataList?.[0]?.accountNumber
    || null;
  return {
    ssoKey,
    depositAccountNumber,
    accountCount: list.length,
    hasSsoKey: Boolean(ssoKey),
    hasDepositAccount: Boolean(depositAccountNumber),
    accountObjectKeys: first && typeof first === 'object' ? Object.keys(first).sort() : [],
    userObjectKeys: userData && typeof userData === 'object' ? Object.keys(userData).sort() : [],
  };
};

/** Redact deposit/account numbers for API responses (never log full values). */
export const redactAccountNumber = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.length <= 4) return '[redacted]';
  return `${raw.slice(0, 2)}…${raw.slice(-2)}`;
};

export const fingerprintAccountNumber = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
};

export const collectCheckAltAccountNumbers = (userData = {}) => {
  const list = Array.isArray(userData?.accountDataList) ? userData.accountDataList : [];
  return list
    .map((row) => row?.accountNumber || row?.AccountNumber || row?.depositAccountNumber || null)
    .filter(Boolean)
    .map((value) => String(value));
};

export const extractCheckAltBusUnit = (payload = {}) => {
  const row = payload?.accountDataList?.[0] || payload || {};
  return {
    busUnitId: row.busUnitId || row.BusUnitId || row.businessUnitId || row.business_unit_id
      || payload.busUnitId || payload.businessUnitId || payload.business_unit || null,
    busUnitName: row.busUnitName || row.BusUnitName || row.businessUnitName || row.business_unit_name
      || payload.busUnitName || payload.businessUnitName || payload.businessUnit || null,
  };
};

/**
 * Documented FinCapture discovery: getUserAccountInformation account numbers are
 * fed into getDepositAccountInformation. Never invent numbers; never use sample 123456789
 * unless that exact value appears in the UAT API response.
 */
export const summarizeDiscoveredDepositAccounts = (discoveries = []) => discoveries.map((row) => ({
  accountNumberRedacted: redactAccountNumber(row.accountNumber),
  accountFingerprint: fingerprintAccountNumber(row.accountNumber),
  isSample123456789: String(row.accountNumber || '') === '123456789',
  depositLookupOk: row.ok === true,
  depositHttpStatus: row.httpStatus || null,
  depositMessage: row.message || null,
  hasSsoKey: Boolean(row.ssoKey),
  busUnitId: row.busUnitId || null,
  busUnitName: row.busUnitName || null,
  objectKeys: row.objectKeys || [],
}));

export const extractCheckAltAmountEcho = (data = {}) => ({
  echoedUserAmount: data?.userAmount ?? data?.UserAmount ?? null,
  echoedAmount: data?.amount ?? null,
  echoedAmountCents: data?.amountCents ?? data?.amount_cents ?? null,
  status: data?.status ?? data?.statusCode ?? null,
  statusDescription: data?.statusDescription || data?.message || null,
});

export const extractCheckAltReference = (data = {}) => {
  const raw = data?.referenceNumber ?? data?.checkalt_reference ?? data?.reference ?? null;
  return raw == null ? null : String(raw);
};

export const extractCheckAltStatus = (data = {}) => (
  data?.statusDescription || data?.status || data?.statusCode || data?.itemStatus || null
);

/** Minimal valid PNG. Not a check image. Labeled non-negotiable test fixture. */
export const SYNTHETIC_VOID_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const convertChecksOpsCentsToCheckAltUserAmount = (cents) => {
  const validated = validateProviderCents(cents);
  if (validated.error) return validated;
  const formatted = formatCheckAltUserAmount(validated.cents / 100);
  return {
    userAmount: formatted.userAmount,
    scale: CHECKALT_USER_AMOUNT.scale,
    checksOpsCents: validated.cents,
    sourceDollars: validated.cents / 100,
  };
};

export const assertCheckAltSandboxCredentials = (credentials) => {
  if (!credentials) {
    return {
      ok: false,
      statusCode: 409,
      error: 'sandbox_credentials_unavailable',
      provider: 'checkalt',
      message: 'CHECKALT_UAT_* credentials are not configured. Production CHECKALT_* keys will not be substituted. CheckAlt production execution stays disabled.',
      limitation: 'uat_keys_missing',
    };
  }
  if (credentials.environment !== 'uat' && credentials.environment !== 'sandbox') {
    return {
      ok: false,
      statusCode: 403,
      error: 'production_credentials_refused',
      provider: 'checkalt',
      message: 'CheckAlt adapter refuses non-UAT credentials.',
    };
  }
  if (!isApprovedCheckAltUatUrl(credentials.baseUrl) || credentials.baseUrl !== CHECKALT_UAT_HOST) {
    return {
      ok: false,
      statusCode: 403,
      error: 'uat_host_refused',
      provider: 'checkalt',
      approvedHost: CHECKALT_UAT_HOST,
      message: 'CheckAlt HTTP is allowed only to https://uatapi.checkalt.com.',
    };
  }
  const merchant = String(credentials.merchant || '').toLowerCase();
  if (merchant && !isApprovedCheckAltMerchant(credentials.merchant)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'uat_merchant_refused',
      provider: 'checkalt',
      message: 'CheckAlt UAT merchant must be the approved test merchant.',
    };
  }
  return { ok: true };
};

export const buildCheckAltSandboxDeposit = ({ amountCents = SANDBOX_MIN_CENTS, reference } = {}) => {
  const converted = convertChecksOpsCentsToCheckAltUserAmount(amountCents);
  if (converted.error) return converted;
  return {
    ...converted,
    reference: reference || null,
    negotiableCheck: false,
    imageIncluded: true,
    imageKind: 'synthetic_void_png',
    unit: CHECKALT_USER_AMOUNT,
  };
};

const parseAuthToken = (text) => {
  const raw = String(text || '').trim().replace(/^"|"$/g, '');
  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw);
      const token = data?.token || data?.jwt || data?.accessToken || data?.access_token;
      return { token: token || null, json: data };
    } catch {
      return { token: null, json: null };
    }
  }
  return { token: raw.includes('.') ? raw : null, json: null };
};

export const checkAltSandboxAuthenticate = async ({ credentials, fetchImpl = fetch } = {}) => {
  const gate = assertCheckAltSandboxCredentials(credentials);
  if (!gate.ok) return gate;
  const merchant = merchantHeaderForCheckAltUat(credentials.merchant);
  const headers = {
    'Content-Type': 'application/json',
    merchant,
  };
  const body = JSON.stringify({
    userName: credentials.username || credentials.userId,
    password: credentials.password,
  });
  let last = null;
  try {
    for (const authPath of CHECKALT_UAT_AUTH_PATHS) {
      const response = await fetchImpl(`${CHECKALT_UAT_HOST}${authPath}`, {
        method: 'POST',
        headers,
        body,
      });
      const text = await response.text();
      last = { response, text, authPath };
      if (response.ok) {
        const parsed = parseAuthToken(text);
        if (parsed.token) {
          return {
            ok: true,
            tokenPresent: true,
            httpStatus: response.status,
            rawToken: parsed.token,
            authPath,
          };
        }
      }
      if (response.status !== 404) {
        return {
          ok: false,
          statusCode: response.status,
          error: 'checkalt_uat_auth_failed',
          provider: 'checkalt',
          httpStatus: response.status,
          authPath,
        };
      }
    }
  } catch (error) {
    if (isProviderNetworkError(error)) return providerEgressFailure('checkalt');
    throw error;
  }
  return {
    ok: false,
    statusCode: last?.response?.status || 502,
    error: 'checkalt_uat_auth_failed',
    provider: 'checkalt',
    httpStatus: last?.response?.status || 502,
    authPath: last?.authPath || CHECKALT_UAT_AUTH_PATH,
  };
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
  try {
    const response = await fetchImpl(`${CHECKALT_UAT_HOST}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(jwt).replace(/^"|"$/g, '')}`,
        merchant: merchantHeaderForCheckAltUat(credentials.merchant),
      },
      body: JSON.stringify(body || {}),
    });
    let json = null;
    const text = await response.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const textSnippet = String(text || '').replace(/\s+/g, ' ').slice(0, 240);
      return {
        ok: false,
        statusCode: response.status,
        error: 'checkalt_uat_http_failed',
        provider: 'checkalt',
        httpStatus: response.status,
        path,
        message: json?.message || json?.statusDescription || json?.error || json?.title || textSnippet || null,
        providerResponseKeys: json && typeof json === 'object' ? Object.keys(json).sort() : [],
      };
    }
    return { ok: true, statusCode: response.status, data: json };
  } catch (error) {
    if (isProviderNetworkError(error)) return providerEgressFailure('checkalt', { path });
    throw error;
  }
};

export const buildCheckAltUatDepositBody = ({
  credentials,
  amountCents = SANDBOX_MIN_CENTS,
  reference,
  ssoKey,
  depositAccountNumber,
} = {}) => {
  const deposit = buildCheckAltSandboxDeposit({ amountCents, reference });
  if (deposit.error) return deposit;
  if (!ssoKey || !depositAccountNumber) {
    return {
      error: 'account_unregistered',
      statusCode: 409,
      provider: 'checkalt',
      message: 'CheckAlt UAT deposit requires a registered FinCapture depositor ssoKey and approved UAT deposit account. The API login is never substituted as the depositor.',
      negotiableCheck: false,
    };
  }
  return {
    request: {
      fiKey: credentials?.fiKey || null,
      ssoKey,
      depositAccountNumber,
      captureDateTime: new Date().toISOString(),
      userAmount: deposit.userAmount,
      frontImage: SYNTHETIC_VOID_PNG_B64,
      rearImage: SYNTHETIC_VOID_PNG_B64,
      performRiskAssessment: true,
      testDeposit: true,
    },
    meta: deposit,
  };
};

export { dollarsToIntegerCents };
