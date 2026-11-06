/**
 * Login MFA: an authenticator (TOTP) code after every sign-in, for every user.
 *
 * Owner, 2026-11-06: "Login MFA - yes for everyone", with the design "Email code +
 * authenticator". Cognito cannot require MFA while users sign in with EMAIL_OTP, so the
 * application enforces it. Sign-in stays EMAIL_OTP or a passkey; afterwards the user enters a
 * code from the authenticator they already use for money actions (financial-totp.mjs), through
 * /auth/mfa/step-up with action_key 'login.mfa'. The step-up is written to
 * public.financial_stepup_log against this login (loginSessionBinding: sub + origin_jti, so it
 * survives token refresh and ends at sign-out), with no tenant.
 *
 * withIdentity (data.mjs) then refuses every identity-backed request of a login with no such
 * row, except the routes a user needs to enroll and pass the check. Off unless the Lambda's
 * AWS_LOGIN_MFA_REQUIRED is 'true', so the code can ship before it is switched on, staging first.
 *
 * Version 1 also asks passkey sign-ins for the code.
 */
import { flagTrue } from './ops-readiness.mjs';

export const LOGIN_MFA_ACTION = 'login.mfa';
export const LOGIN_MFA_FLAG = 'AWS_LOGIN_MFA_REQUIRED';

/** Routes a signed-in user can call before passing the login check. */
export const LOGIN_MFA_EXEMPT_PATHS = new Set([
  '/auth/mfa/status',
  '/auth/mfa/associate',
  '/auth/mfa/verify',
  '/auth/mfa/step-up',
  '/identity/me',
  '/identity/session',
]);

export const loginMfaRequired = () => flagTrue(LOGIN_MFA_FLAG);

/** The request path with the API stage prefix removed (same rule as index.mjs requestPath). */
export const loginMfaRequestPath = (event) => {
  const rawPath = event?.rawPath || event?.requestContext?.http?.path || '/';
  const stage = event?.requestContext?.stage;
  let path = String(rawPath).split('?')[0] || '/';
  if (stage && stage !== '$default') {
    const prefix = `/${stage}`;
    if (path === prefix) path = '/';
    else if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
};

export const LOGIN_MFA_STEPUP_SQL = `SELECT id, created_at
  FROM public.financial_stepup_log
  WHERE user_id = $1::uuid
    AND action_key = $2
    AND succeeded IS TRUE
    AND factor_type = 'totp'
    AND (metadata->>'source') = 'app_financial_totp'
    AND (metadata->>'login_session') = $3
  ORDER BY created_at DESC
  LIMIT 1`;

/** Passed logins, per Lambda container. Only a pass is cached; a refusal is always re-read. */
const PASS_CACHE_TTL_MS = 5 * 60 * 1000;
const PASS_CACHE_MAX = 2000;
const passCache = new Map();

export const resetLoginMfaCache = () => passCache.clear();

const cacheKey = (userId, loginSession) => `${userId}|${loginSession}`;

const cachedPass = (key, nowMs) => {
  const at = passCache.get(key);
  if (at === undefined) return false;
  if (nowMs - at > PASS_CACHE_TTL_MS) {
    passCache.delete(key);
    return false;
  }
  return true;
};

const rememberPass = (key, nowMs) => {
  if (passCache.size >= PASS_CACHE_MAX) passCache.clear();
  passCache.set(key, nowMs);
};

/** This login's login.mfa step-up row, or null. */
export const loadLoginMfaStepUp = async (client, { userId, loginSession }) => {
  if (!userId || !loginSession) return null;
  return (await client.query(LOGIN_MFA_STEPUP_SQL, [userId, LOGIN_MFA_ACTION, loginSession])).rows[0] || null;
};

const resolveLoginSession = async (claims) => {
  const { loginSessionBinding } = await import('./providers/production/moov-fund-authz.mjs');
  return loginSessionBinding(claims);
};

/**
 * Whether this login has passed the authenticator check: { required, satisfied, loginSession }.
 * required is false when the flag is off.
 */
export const loginMfaState = async ({ client, mapping, claims }, deps = {}) => {
  const required = (deps.required ?? loginMfaRequired)();
  const loginSession = await (deps.resolveLoginSession || resolveLoginSession)(claims);
  const userId = mapping?.application_user_id || null;
  if (!userId || !loginSession) return { required, satisfied: false, loginSession: null };
  const nowMs = deps.nowMs ?? Date.now();
  const key = cacheKey(userId, loginSession);
  if (cachedPass(key, nowMs)) return { required, satisfied: true, loginSession };
  const row = await loadLoginMfaStepUp(client, { userId, loginSession });
  if (row) rememberPass(key, nowMs);
  return { required, satisfied: Boolean(row), loginSession };
};

/**
 * The gate withIdentity runs before a route's handler. Returns null to let the request through,
 * or the refusal to return.
 */
export const enforceLoginMfa = async ({ event, client, mapping, claims, spoof }, deps = {}) => {
  if (!(deps.required ?? loginMfaRequired)()) return null;
  const path = loginMfaRequestPath(event);
  if (LOGIN_MFA_EXEMPT_PATHS.has(path)) return null;
  const state = await loginMfaState({ client, mapping, claims }, { ...deps, required: () => true });
  if (state.satisfied) return null;
  return {
    ok: false,
    statusCode: 403,
    error: state.loginSession ? 'login_mfa_required' : 'login_session_unbound',
    message: state.loginSession
      ? 'Enter the code from your authenticator app to continue.'
      : 'Sign out and sign back in, then try again.',
    spoofFieldsIgnored: spoof,
  };
};
