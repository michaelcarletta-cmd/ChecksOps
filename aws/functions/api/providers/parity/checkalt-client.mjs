/**
 * Faithful Node port of supabase/functions/_shared/checkalt.ts.
 * Staging overlay (intentional AWS isolation, not a FinCapture semantic change):
 * - Auth body is still { userName, password } (production shape).
 * - Auth path is still /public/fincapture/authenticate.
 * - Host is forced to https://uatapi.checkalt.com when production flags are false.
 * - FI API login comes from CHECKALT_UAT_* never CHECKALT_USERNAME/PASSWORD.
 * - JWT is not written back onto production checkalt_config.
 * - Tenant depositor is NEVER the API login; it is checkalt_tenant_accounts.sso_user_id
 *   or, on staging, an isolated UAT row that does not overwrite production registrations.
 */
import { CHECKALT_UAT_HOST, merchantHeaderForCheckAltUat } from '../../sandbox-credentials.mjs';

export const CHECKALT_AUTH_PATH = '/public/fincapture/authenticate';

export function extractSsoKey(userAccountInfo, accountNumber) {
  const list = userAccountInfo?.accountDataList ?? [];
  for (const acct of list) {
    if (acct.accountNumber === accountNumber && acct.ssoKey) return acct.ssoKey;
  }
  if (list.length === 1 && list[0]?.ssoKey) return list[0].ssoKey;
  return null;
}

export function mapDepositStatus(code, currentStatus) {
  switch (Number(code)) {
    case 1: return 'pending';
    case 2: return 'submitted';
    case 3: return 'cleared';
    case 4: return 'rejected';
    case 5: return 'suspended';
    case 6: return 'duplicate';
    default: return currentStatus;
  }
}

const parseAuthToken = (text) => {
  const raw = String(text || '').trim().replace(/^"|"$/g, '');
  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw);
      return data?.token ?? data?.jwt ?? data?.accessToken ?? data?.access_token ?? null;
    } catch {
      return null;
    }
  }
  return raw.includes('.') ? raw : null;
};

export async function getCheckAltJwt({ cfg, credentials, fetchImpl = fetch, jwtCache = null }) {
  if (jwtCache?.token && jwtCache.expiresAt && new Date(jwtCache.expiresAt).getTime() - Date.now() > 60_000) {
    return jwtCache.token;
  }
  if (cfg.cached_jwt && cfg.cached_jwt_expires_at && credentials.allowConfigJwt) {
    const exp = new Date(cfg.cached_jwt_expires_at).getTime();
    if (exp - Date.now() > 60_000) return cfg.cached_jwt;
  }
  const username = credentials.username;
  const password = credentials.password;
  if (!username || !password) throw new Error('CHECKALT_USERNAME / CHECKALT_PASSWORD not configured');
  if (!cfg.base_url) throw new Error('checkalt_config.base_url not set');
  if (!cfg.merchant) throw new Error('checkalt_config.merchant not set');

  const baseUrl = String(cfg.base_url).replace(/\/$/, '');
  const resp = await fetchImpl(`${baseUrl}${CHECKALT_AUTH_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      merchant: cfg.merchant,
    },
    body: JSON.stringify({ userName: username, password }),
  });
  const raw = (await resp.text()).trim();
  if (!resp.ok) throw new Error(`CheckAlt auth failed [${resp.status}]: ${raw.slice(0, 200)}`);
  const jwt = parseAuthToken(raw);
  if (!jwt || !jwt.includes('.')) throw new Error('CheckAlt auth response missing token');

  let expiresAt = new Date(Date.now() + 50 * 60_000).toISOString();
  try {
    const parts = jwt.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload?.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
    }
  } catch { /* ignore */ }
  if (jwtCache) {
    jwtCache.token = jwt;
    jwtCache.expiresAt = expiresAt;
  }
  return jwt;
}

export async function checkAltFetch({
  cfg,
  credentials,
  path,
  body,
  fetchImpl = fetch,
  jwt,
  jwtCache = null,
}) {
  if (!cfg.merchant) throw new Error('checkalt_config.merchant not set');
  const token = jwt || await getCheckAltJwt({ cfg, credentials, fetchImpl, jwtCache });
  const baseUrl = String(cfg.base_url || '').replace(/\/$/, '');
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    Authorization: `Bearer ${String(token).replace(/^"|"$/g, '')}`,
    merchant: cfg.merchant,
    'Content-Type': 'application/json',
  };
  return fetchImpl(url, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

export async function getUserAccountInfo({ cfg, credentials, ssoUserId, fetchImpl = fetch, jwtCache = null }) {
  if (!cfg.fi_key) throw new Error('checkalt_config.fi_key not set');
  const resp = await checkAltFetch({
    cfg,
    credentials,
    path: '/fincapture/useraccount/getUserAccountInformation',
    body: { fiKey: cfg.fi_key, userId: ssoUserId },
    fetchImpl,
    jwtCache,
  });
  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  return { ok: resp.ok, json, raw };
}

export async function getDepositAccountInfo({
  cfg, credentials, ssoUserId, accountNumber, fetchImpl = fetch, jwtCache = null,
}) {
  if (!cfg.fi_key) throw new Error('checkalt_config.fi_key not set');
  const resp = await checkAltFetch({
    cfg,
    credentials,
    path: '/fincapture/useraccount/getDepositAccountInformation',
    body: { fiKey: cfg.fi_key, userId: ssoUserId, accountNumber },
    fetchImpl,
    jwtCache,
  });
  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  return { ok: resp.ok, json, raw };
}

export async function getDepositItemStatus({
  cfg, credentials, tenant, referenceNumber, fetchImpl = fetch, jwtCache = null,
}) {
  if (!cfg.fi_key) throw new Error('checkalt_config.fi_key not set');
  const resp = await checkAltFetch({
    cfg,
    credentials,
    path: '/fincapture/deposit/item',
    body: {
      fiKey: cfg.fi_key,
      ssoKey: tenant.sso_user_id,
      referenceNumber: Number(referenceNumber),
    },
    fetchImpl,
    jwtCache,
  });
  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  return { ok: resp.ok, json, raw };
}

export function uatConfigOverlay(dbConfig, uatCredentials) {
  return {
    ...dbConfig,
    base_url: CHECKALT_UAT_HOST,
    merchant: merchantHeaderForCheckAltUat(uatCredentials.merchant || dbConfig?.merchant),
    fi_key: uatCredentials.fiKey || dbConfig?.fi_key || null,
    cached_jwt: null,
    cached_jwt_expires_at: null,
  };
}

export function buildRegisterPayload({ fiKey, ssoUserId, firstName, lastName, email, depositAccountNumber }) {
  return {
    fiKey,
    ssorequest: true,
    SSORequest: true,
    isSSORequest: true,
    userID: ssoUserId,
    userId: ssoUserId,
    firstName,
    lastName,
    emailAddress: email,
    accountDataList: [{ accountNumber: depositAccountNumber }],
  };
}

/**
 * Exact /fincapture/deposit/process body produced by
 * supabase/functions/checkalt-submit-deposit after image prep.
 * Lovable does not send checkNumber, routing, businessUnit, testDeposit, or
 * a data: prefix on the images.
 */
export const LOVABLE_PROCESS_BODY_KEYS = Object.freeze([
  'fiKey',
  'ssoKey',
  'depositAccountNumber',
  'captureDateTime',
  'userAmount',
  'frontImage',
  'rearImage',
  'performRiskAssessment',
]);

export function buildDepositProcessBody({
  fiKey,
  ssoKey,
  depositAccountNumber,
  captureDateTime,
  userAmount,
  frontImage,
  rearImage,
  performRiskAssessment = true,
}) {
  return {
    fiKey,
    ssoKey,
    depositAccountNumber,
    captureDateTime,
    userAmount,
    frontImage,
    ...(rearImage ? { rearImage } : {}),
    performRiskAssessment,
  };
}
