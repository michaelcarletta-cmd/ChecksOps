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
import { USER_ROLES_SQL } from './identity.mjs';

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

const isAdmin = async (client, userId) => {
  const roles = (await safeQuery(client, USER_ROLES_SQL, [userId])).rows
    .map((row) => String(row.role || '').toLowerCase());
  if (roles.includes('admin')) return true;
  const master = (await safeQuery(client, 'SELECT public.is_master_owner() AS is_master')).rows[0];
  return master?.is_master === true;
};

export const softwareTokenEnrolled = (user = {}) => {
  const list = user.UserMFASettingList || user.userMFASettingList || [];
  return list.includes('SOFTWARE_TOKEN_MFA');
};

export const runAdminResetTotp = async ({
  client, mapping, body, spoof, cognitoClient, poolId,
}) => {
  if (!await isAdmin(client, mapping.application_user_id)) {
    return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };
  }
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  if (!UUID_RE.test(userId)) {
    return { ok: false, statusCode: 400, error: 'invalid_user_id', spoofFieldsIgnored: spoof };
  }

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
