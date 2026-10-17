/**
 * Cognito-native administrative TOTP/MFA reset.
 * Does not call Supabase auth.admin.mfa.deleteFactor.
 * Does not enable preferred MFA, import users, or change the pool MFA setting.
 */
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminUserGlobalSignOutCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { withIdentityWrite } from './data.mjs';
import { loginSessionBinding } from './providers/production/moov-fund-authz.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cognito = () => new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

export const MFA_RESET_PREFERENCE = {
  SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
  SMSMfaSettings: { Enabled: false, PreferredMfa: false },
};

const safeQuery = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch {
    return { rows: [], rowCount: 0 };
  }
};

// Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
// Any member may reset 2FA for a teammate: someone who shares one of the
// caller's tenants (the role column is ignored). Global user_roles admin/staff
// and the master owner get no cross-tenant shortcut.
export const RESET_TOTP_TEAMMATE_SQL = `SELECT 1
  FROM public.tenant_users mine
  JOIN public.tenant_users theirs ON theirs.tenant_id = mine.tenant_id
 WHERE mine.user_id = $1::uuid
   AND theirs.user_id = $2::uuid
 LIMIT 1`;

const managesTeammate = async (client, userId, targetUserId) => (
  (await safeQuery(client, RESET_TOTP_TEAMMATE_SQL, [userId, targetUserId])).rows.length > 0
);

/** The platform owner's mailbox (public.is_platform_owner() is identity-email based). */
const PLATFORM_OWNER_EMAIL = 'checksopsadmin@gmail.com';

/** True when the target application user is the platform owner (identity or profile email). */
export const RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL = `SELECT 1
  FROM public.identity_accounts ia
 WHERE ia.application_user_id = $1::uuid
   AND lower(ia.email) = $2
 UNION ALL
SELECT 1
  FROM public.profiles p
 WHERE p.id = $1::uuid
   AND lower(p.email) = $2
 LIMIT 1`;

/**
 * Step-up for a teammate 2FA reset: the caller's own financial TOTP, entered
 * in this login (financial_stepup_log, recorded by /auth/mfa/step-up with
 * action_key team.reset_totp) within the last few minutes, for a tenant the
 * caller shares with the target.
 */
export const TEAM_RESET_TOTP_ACTION = 'team.reset_totp';
export const TEAM_RESET_TOTP_STEPUP_MAX_AGE_MINUTES = 15;

export const RESET_TOTP_STEPUP_SQL = `SELECT s.id, s.tenant_id
  FROM public.financial_stepup_log s
 WHERE s.user_id = $1::uuid
   AND s.action_key = $3
   AND s.succeeded IS TRUE
   AND s.factor_type = 'totp'
   AND (s.metadata->>'source') = 'app_financial_totp'
   AND (s.metadata->>'login_session') = $4
   AND s.created_at > now() - make_interval(mins => $5::int)
   AND s.tenant_id IN (
     SELECT mine.tenant_id
       FROM public.tenant_users mine
       JOIN public.tenant_users theirs ON theirs.tenant_id = mine.tenant_id
      WHERE mine.user_id = $1::uuid
        AND theirs.user_id = $2::uuid)
   AND NOT EXISTS (
     SELECT 1
       FROM public.financial_stepup_log used
      WHERE used.user_id = s.user_id
        AND used.action_key = $6
        AND (used.metadata->>'stepup_id') = s.id::text)
 ORDER BY s.created_at DESC
 LIMIT 1`;

/**
 * Single use: a reset consumes its step-up. The consumption is an
 * append-only financial_stepup_log row (the table is insert-only) whose
 * source is not app_financial_totp, so it can never itself satisfy a step-up.
 * It commits with the reset; a failed reset leaves the step-up unused.
 */
export const TEAM_RESET_TOTP_CONSUMED_ACTION = 'team.reset_totp.consumed';

/** One reset at a time per caller, so two requests cannot share one step-up. */
export const RESET_TOTP_STEPUP_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('team-reset-totp:' || $1::uuid::text, 0))`;

export const RESET_TOTP_CONSUME_SQL = `INSERT INTO public.financial_stepup_log
  (user_id, tenant_id, action_key, factor_type, succeeded, metadata)
VALUES ($1::uuid, $2::uuid, $3, 'totp', true, $4::jsonb)`;

const loadResetStepUp = async (client, { userId, targetUserId, loginSession }) => {
  if (!loginSession) return null;
  await client.query(RESET_TOTP_STEPUP_LOCK_SQL, [userId]);
  return (await client.query(RESET_TOTP_STEPUP_SQL, [
    userId,
    targetUserId,
    TEAM_RESET_TOTP_ACTION,
    loginSession,
    TEAM_RESET_TOTP_STEPUP_MAX_AGE_MINUTES,
    TEAM_RESET_TOTP_CONSUMED_ACTION,
  ])).rows[0] || null;
};

const consumeResetStepUp = async (client, { userId, targetUserId, stepUp }) => {
  // The server's step-up writer (SQL 97 trigger); same setting as auth-financial-totp.
  await client.query("SELECT set_config('app.stepup_writer', '1', true)");
  try {
    return await client.query(RESET_TOTP_CONSUME_SQL, [
      userId,
      stepUp.tenant_id,
      TEAM_RESET_TOTP_CONSUMED_ACTION,
      JSON.stringify({ stepup_id: String(stepUp.id), target_user_id: targetUserId, source: 'team_reset_totp_consumed' }),
    ]);
  } finally {
    await client.query("SELECT set_config('app.stepup_writer', '0', true)").catch(() => {});
  }
};

export const softwareTokenEnrolled = (user = {}) => {
  const list = user.UserMFASettingList || user.userMFASettingList || [];
  return list.includes('SOFTWARE_TOKEN_MFA');
};

export const runAdminResetTotp = async ({
  client, mapping, claims, body, spoof, cognitoClient, poolId,
}) => {
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  if (!UUID_RE.test(userId)) {
    return { ok: false, statusCode: 400, error: 'invalid_user_id', spoofFieldsIgnored: spoof };
  }
  // Resetting your own 2FA here would let a session that lost its second
  // factor (or a stolen session) drop it without the factor.
  if (userId.toLowerCase() === String(mapping.application_user_id || '').toLowerCase()) {
    return { ok: false, statusCode: 403, error: 'cannot_reset_own_totp', spoofFieldsIgnored: spoof };
  }
  if (!await managesTeammate(client, mapping.application_user_id, userId)) {
    return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };
  }
  if ((await client.query(RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL, [userId, PLATFORM_OWNER_EMAIL])).rows.length) {
    return { ok: false, statusCode: 403, error: 'platform_owner_protected', spoofFieldsIgnored: spoof };
  }
  const stepUp = await loadResetStepUp(client, {
    userId: mapping.application_user_id,
    targetUserId: userId,
    loginSession: loginSessionBinding(claims || {}),
  });
  if (!stepUp) {
    return {
      ok: false,
      statusCode: 401,
      error: 'totp_required',
      actionKey: TEAM_RESET_TOTP_ACTION,
      message: 'Enter your own two-factor code to reset a teammate\'s two-factor.',
      spoofFieldsIgnored: spoof,
    };
  }
  await consumeResetStepUp(client, { userId: mapping.application_user_id, targetUserId: userId, stepUp });

  const account = (await safeQuery(
    client,
    `SELECT application_user_id::text AS application_user_id, email, cognito_sub, status
     FROM public.identity_accounts
     WHERE application_user_id = $1::uuid
     LIMIT 1`,
    [userId],
  )).rows[0];

  if (!account?.email && !account?.cognito_sub) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      removed_count: 0,
      cognitoUserFound: false,
      importedUser: false,
      poolMfaChanged: false,
      spoofFieldsIgnored: spoof,
    };
  }

  const userPoolId = poolId || process.env.COGNITO_USER_POOL_ID;
  const clientApi = cognitoClient || cognito();
  const username = account.email || account.cognito_sub;
  let user;
  try {
    user = await clientApi.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    }));
  } catch (error) {
    const name = String(error?.name || error?.__type || '');
    if (/UserNotFoundException/i.test(name) || error?.$metadata?.httpStatusCode === 400) {
      return {
        ok: true,
        statusCode: 200,
        success: true,
        removed_count: 0,
        cognitoUserFound: false,
        importedUser: false,
        poolMfaChanged: false,
        spoofFieldsIgnored: spoof,
      };
    }
    return {
      ok: false,
      statusCode: 500,
      error: 'factor_lookup_failed',
      message: String(error?.message || error).slice(0, 200),
      spoofFieldsIgnored: spoof,
    };
  }

  const removed = softwareTokenEnrolled(user) ? 1 : 0;
  try {
    await clientApi.send(new AdminSetUserMFAPreferenceCommand({
      UserPoolId: userPoolId,
      Username: user.Username || username,
      ...MFA_RESET_PREFERENCE,
    }));
  } catch (error) {
    return {
      ok: false,
      statusCode: 500,
      error: 'factor_reset_failed',
      message: String(error?.message || error).slice(0, 200),
      spoofFieldsIgnored: spoof,
    };
  }

  try {
    await clientApi.send(new AdminUserGlobalSignOutCommand({
      UserPoolId: userPoolId,
      Username: user.Username || username,
    }));
  } catch {
    // Sign-out is best-effort; reset already applied.
  }

  await safeQuery(
    client,
    `UPDATE public.profiles SET totp_enrolled_at = NULL WHERE id = $1::uuid`,
    [userId],
  );

  return {
    ok: true,
    statusCode: 200,
    success: true,
    removed_count: removed,
    cognitoUserFound: true,
    importedUser: false,
    poolMfaChanged: false,
    preferredMfaEnabled: false,
    spoofFieldsIgnored: spoof,
  };
};

export const handleAdminResetTotp = (event, deps = {}) => (
  withIdentityWrite(event, (ctx) => runAdminResetTotp({
    ...ctx,
    cognitoClient: deps.cognitoClient,
    poolId: deps.poolId || process.env.COGNITO_USER_POOL_ID,
  }), deps)
);
