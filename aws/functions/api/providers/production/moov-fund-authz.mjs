/**
 * Two-factor for production money actions: a code entered in this login
 * within the last 15 minutes.
 *
 * A successful financial TOTP step-up for action `wallet.fund` is recorded in
 * financial_stepup_log with the login it was entered in. A later funding,
 * send or bank-details request from the same login reuses it while it is at
 * most FINANCIAL_STEPUP_MAX_AGE_SECONDS old; after that the server answers
 * totp_required again and the app asks for a new code. Signing out and back
 * in starts a new login, which also asks for a code again.
 */
export const WALLET_FUND_TOTP_ACTION = 'wallet.fund';

/**
 * Owner decision 2026-10-31 (security audit 2026-10-29 finding 7): every money
 * action (Check Alt deposit submit and approve, wallet funding, sends) needs a
 * step-up verified within the last 15 minutes. No amount threshold.
 */
export const FINANCIAL_STEPUP_MAX_AGE_SECONDS = 15 * 60;

/**
 * The freshness condition every money gate adds to its step-up lookup (the
 * approach admin-reset-totp.mjs takes for team.reset_totp). The verified-at
 * time is the row's created_at: the server writes the row (insertAppStepUpLog,
 * behind the SQL 97 writer guard) in the request that verified the code, the
 * column takes its database default, and the table is append-only (SQL 106).
 * The database clock decides, never the token's iat or auth_time. `param` is
 * the 1-based placeholder that carries FINANCIAL_STEPUP_MAX_AGE_SECONDS.
 */
export const financialStepUpFreshSql = (param, column = 'created_at') => (
  `${column} > now() - make_interval(secs => $${param}::int)`
);

const SAFE_SESSION = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * The login a Cognito ID token belongs to. `origin_jti` is fixed for the life
 * of a sign-in, including refreshed tokens; `auth_time` is the fallback.
 * Returns null when neither is present, so callers fail closed.
 */
export function loginSessionBinding(claims = {}) {
  const sub = String(claims?.sub || '').trim();
  if (!sub) return null;
  const origin = String(claims?.origin_jti || '').trim();
  if (origin && SAFE_SESSION.test(origin)) return `${sub}:jti:${origin}`;
  const authTime = String(claims?.auth_time ?? '').trim();
  if (/^\d{9,12}$/.test(authTime)) return `${sub}:auth:${authTime}`;
  return null;
}

/**
 * The caller's wallet.fund step-up for this tenant in this login, verified
 * within FINANCIAL_STEPUP_MAX_AGE_SECONDS, or null. Wallet funding, sends and
 * bank-detail changes answer totp_required on null.
 */
export async function loadSessionFundStepUp(client, { userId, tenantId, loginSession }) {
  if (!userId || !tenantId || !loginSession) return null;
  return (await client.query(
    `SELECT id, created_at
     FROM public.financial_stepup_log
     WHERE user_id = $1::uuid
       AND tenant_id = $2::uuid
       AND action_key = $3
       AND succeeded IS TRUE
       AND factor_type = 'totp'
       AND (metadata->>'source') = 'app_financial_totp'
       AND (metadata->>'login_session') = $4
       AND ${financialStepUpFreshSql(5)}
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, tenantId, WALLET_FUND_TOTP_ACTION, loginSession, FINANCIAL_STEPUP_MAX_AGE_SECONDS],
  )).rows[0] || null;
}
