/**
 * Two-factor for production wallet funding: once per login.
 *
 * A successful financial TOTP step-up for action `wallet.fund` is recorded in
 * financial_stepup_log with the login it was entered in. Every later funding
 * request from the same login (token refreshes keep the same login) reuses it.
 * Signing out and back in starts a new login, which asks for a code again.
 */
export const WALLET_FUND_TOTP_ACTION = 'wallet.fund';

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
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, tenantId, WALLET_FUND_TOTP_ACTION, loginSession],
  )).rows[0] || null;
}
