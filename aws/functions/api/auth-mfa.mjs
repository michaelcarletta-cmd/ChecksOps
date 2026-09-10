/**
 * Cognito software-token MFA helpers for financial step-up preparation.
 * Does NOT enable preferred MFA at login (EMAIL_OTP remains first factor).
 * Does NOT set AWS_FINANCIAL_PERMISSIONS_ACTIVATED. Money stays off.
 */
import { flagTrue } from './ops-readiness.mjs';
import { evaluatePrivilegedEnrollment, privilegedAuthPolicy } from './privileged-auth.mjs';
import { normalizeTotpCode, totpUserFailureMessage } from './auth-totp-code.mjs';

const POOL_ID = () => process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = () => process.env.COGNITO_CLIENT_ID;

const parseBody = (event) => {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { return JSON.parse(raw); } catch { return {}; }
};

const cognitoJson = async (target, payload) => {
  const response = await fetch('https://cognito-idp.us-east-1.amazonaws.com/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 200) }; }
  if (!response.ok) {
    const name = body.__type || body.code || 'CognitoError';
    const message = body.message || body.Message || name;
    const error = new Error(message);
    error.name = String(name).split('#').pop();
    error.statusCode = response.status === 400 ? 400 : 401;
    throw error;
  }
  return body;
};

const financialGate = () => ({
  financialPermissionsActivated: flagTrue('AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
  providerExecutionEnabled: flagTrue('AWS_PROVIDER_EXECUTION_ENABLED'),
  cognitoMfaPreferred: flagTrue('AWS_COGNITO_MFA_PREFERRED'),
  moneyMovementUnlocked: false,
});

const accessTokenOf = (event) => {
  const body = parseBody(event);
  const fromBody = String(body.accessToken || body.access_token || '').trim();
  if (fromBody) return fromBody;
  const headers = event?.headers || {};
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization');
  const header = match ? String(match[1] || '') : '';
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : '';
};

const otpauthUri = (secret, email) => {
  const label = encodeURIComponent(email || 'ChecksOps');
  const issuer = encodeURIComponent('ChecksOps');
  return `otpauth://totp/${issuer}:${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&digits=6&period=30`;
};

/**
 * Cognito enrollment is UserMFASettingList, not PreferredMfaSetting.
 * VerifySoftwareToken SUCCESS associates a token; SOFTWARE_TOKEN_MFA is only
 * listed after SetUserMFAPreference({ Enabled: true }). PreferredMfa may stay false.
 */
export const evaluateCognitoTotpEnrollment = (user = {}) => {
  const list = user.UserMFASettingList || user.userMFASettingList || [];
  const preferred = user.PreferredMfaSetting || user.preferredMfaSetting || null;
  return {
    totpEnrolled: Array.isArray(list) && list.includes('SOFTWARE_TOKEN_MFA'),
    preferredMfa: preferred || null,
    userMfaSettingList: Array.isArray(list) ? list : [],
  };
};

const enableSoftwareTokenWithoutPreferred = async (accessToken) => {
  await cognitoJson('SetUserMFAPreference', {
    AccessToken: accessToken,
    SoftwareTokenMfaSettings: {
      Enabled: true,
      PreferredMfa: false,
    },
  });
};

export const handleMfaStatus = async (event) => {
  const accessToken = accessTokenOf(event);
  if (!accessToken) return { ok: false, statusCode: 400, error: 'missing_access_token', ...financialGate() };
  try {
    const user = await cognitoJson('GetUser', { AccessToken: accessToken });
    const { totpEnrolled, preferredMfa } = evaluateCognitoTotpEnrollment(user);
    let passkeyCount = 0;
    try {
      const listed = await cognitoJson('ListWebAuthnCredentials', { AccessToken: accessToken });
      passkeyCount = Array.isArray(listed.Credentials) ? listed.Credentials.length : 0;
    } catch {
      passkeyCount = 0;
    }
    return {
      ok: true,
      statusCode: 200,
      totpEnrolled,
      passkeyCount,
      preferredMfa,
      factors: totpEnrolled ? [{ id: 'software-token', factorType: 'totp', status: 'verified' }] : [],
      privilegedAuth: privilegedAuthPolicy(),
      enrollment: evaluatePrivilegedEnrollment({ totpEnrolled, passkeyCount }),
      ...financialGate(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'mfa_status_failed',
      message: String(error.message || error).slice(0, 200),
      ...financialGate(),
    };
  }
};

export const handleMfaAssociate = async (event) => {
  const accessToken = accessTokenOf(event);
  const body = parseBody(event);
  if (!accessToken) return { ok: false, statusCode: 400, error: 'missing_access_token', ...financialGate() };
  try {
    const result = await cognitoJson('AssociateSoftwareToken', { AccessToken: accessToken });
    const secret = result.SecretCode || null;
    return {
      ok: true,
      statusCode: 200,
      id: 'software-token',
      totp: {
        secret,
        qr_code: null,
        otpauth_uri: secret ? otpauthUri(secret, body.email || null) : null,
      },
      ...financialGate(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'mfa_associate_failed',
      message: String(error.message || error).slice(0, 200),
      ...financialGate(),
    };
  }
};

export const handleMfaVerify = async (event) => {
  const accessToken = accessTokenOf(event);
  const body = parseBody(event);
  const normalized = normalizeTotpCode(body.code ?? body.userCode);
  if (!accessToken || !normalized.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: !accessToken ? 'missing_access_token' : normalized.error,
      message: totpUserFailureMessage({ message: normalized.error || 'missing_verify_fields' }),
      ...financialGate(),
    };
  }
  const code = normalized.code;
  try {
    const result = await cognitoJson('VerifySoftwareToken', {
      AccessToken: accessToken,
      UserCode: code,
      FriendlyDeviceName: body.friendlyName || 'ChecksOps authenticator',
    });
    const success = String(result.Status || '').toUpperCase() === 'SUCCESS';
    if (!success) {
      return {
        ok: false,
        statusCode: 401,
        verified: false,
        enrollment: false,
        preferredMfaEnabled: false,
        ...financialGate(),
      };
    }
    try {
      await enableSoftwareTokenWithoutPreferred(accessToken);
    } catch (error) {
      return {
        ok: false,
        statusCode: error.statusCode || 400,
        error: 'mfa_enable_without_preferred_failed',
        verified: true,
        enrollment: false,
        preferredMfaEnabled: false,
        message: 'Authenticator code was accepted but SOFTWARE_TOKEN_MFA was not enabled. Preferred MFA was not set.',
        ...financialGate(),
      };
    }
    const user = await cognitoJson('GetUser', { AccessToken: accessToken });
    const enrollment = evaluateCognitoTotpEnrollment(user);
    let recorded = false;
    if (enrollment.totpEnrolled && (body.action_key || body.actionKey)) {
      const log = await recordStepUpLog(event, body).catch(() => null);
      recorded = Boolean(log?.ok);
    }
    return {
      ok: enrollment.totpEnrolled,
      statusCode: enrollment.totpEnrolled ? 200 : 409,
      verified: true,
      enrollment: enrollment.totpEnrolled,
      recorded,
      preferredMfaEnabled: false,
      preferredMfa: enrollment.preferredMfa,
      remaining: 'SOFTWARE_TOKEN_MFA is enabled without preferring it so EMAIL_OTP login is unchanged. Financial flags stay false.',
      ...financialGate(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 401,
      error: 'mfa_verify_failed',
      message: totpUserFailureMessage(error),
      ...financialGate(),
    };
  }
};

export const handleMfaSetPreference = async () => ({
  ok: false,
  statusCode: 403,
  error: 'cognito_preferred_mfa_disabled',
  message: 'Refusing SetUserMFAPreference. Enabling preferred SOFTWARE_TOKEN_MFA would change EMAIL_OTP login and is not part of this readiness PR.',
  ...financialGate(),
});

const recordStepUpLog = async (event, body, extra = {}) => {
  const { withIdentityWrite } = await import('./data.mjs');
  const { TENANT_MEMBERSHIP_SQL } = await import('./identity.mjs');
  const { membershipForTenant } = await import('./financial-ownership.mjs');
  const {
    CHECKALT_TOTP_ACTION,
    serverAmountCentsFromCheck,
  } = await import('./providers/production/checkalt-authz.mjs');
  return withIdentityWrite(event, async ({ client, mapping, spoof }) => {
    const actionKey = String(body.action_key || body.actionKey || CHECKALT_TOTP_ACTION);
    const checkId = extra.checkId || body.check_intake_item_id || body.check_id || null;
    if (!checkId) {
      return {
        ok: false,
        statusCode: 400,
        error: 'check_intake_item_id is required',
        message: 'Financial TOTP must be bound to a server-side check. Browser tenant_id is ignored.',
        spoofFieldsIgnored: spoof,
      };
    }
    const check = (await client.query(
      `SELECT id, tenant_id, amount, status FROM public.check_intake_items WHERE id = $1::uuid`,
      [checkId],
    )).rows[0];
    if (!check) {
      return { ok: false, statusCode: 404, error: 'Check not found', spoofFieldsIgnored: spoof };
    }
    const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
    if (!membershipForTenant(memberships, check.tenant_id)) {
      return {
        ok: false,
        statusCode: 403,
        error: 'cross_tenant_denied',
        message: 'TOTP step-up tenant is taken from the check. Browser tenant_id is ignored.',
        spoofFieldsIgnored: spoof,
      };
    }
    const amountCents = serverAmountCentsFromCheck(check);
    if (!Number.isInteger(amountCents)) {
      return {
        ok: false,
        statusCode: 400,
        error: 'invalid_amount',
        message: 'Server-derived check amount is required. Browser amount is ignored.',
        spoofFieldsIgnored: spoof,
      };
    }
    const row = (await client.query(
      `INSERT INTO public.financial_stepup_log
        (user_id, tenant_id, action_key, factor_type, succeeded, metadata)
       VALUES ($1::uuid, $2::uuid, $3, 'totp', true, $4::jsonb)
       RETURNING id, created_at`,
      [
        mapping.application_user_id,
        check.tenant_id,
        actionKey,
        JSON.stringify({
          check_id: check.id,
          amount_cents: amountCents,
          operation: CHECKALT_TOTP_ACTION,
          source: 'cognito_totp_step_up',
        }),
      ],
    )).rows[0];
    return {
      ok: true,
      statusCode: 200,
      recorded: true,
      stepup_id: row.id,
      check_id: check.id,
      tenant_id: check.tenant_id,
      amount_cents: amountCents,
      applicationUserId: mapping.application_user_id,
      spoofFieldsIgnored: spoof,
    };
  });
};

export const handleMfaStepUp = async (event) => {
  const accessToken = accessTokenOf(event);
  const body = parseBody(event);
  const normalized = normalizeTotpCode(body.code ?? body.userCode);
  if (!accessToken || !normalized.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: !accessToken ? 'missing_access_token' : normalized.error,
      message: totpUserFailureMessage({ message: normalized.error || 'missing_verify_fields' }),
      ...financialGate(),
    };
  }
  const code = normalized.code;
  try {
    const user = await cognitoJson('GetUser', { AccessToken: accessToken });
    const enrolled = evaluateCognitoTotpEnrollment(user).totpEnrolled;
    if (!enrolled) {
      return {
        ok: false,
        statusCode: 403,
        error: 'totp_not_enrolled',
        message: 'Cognito TOTP is not enrolled. Dual-control from a distinct owner/admin/manager is required.',
        ...financialGate(),
      };
    }
    const result = await cognitoJson('VerifySoftwareToken', {
      AccessToken: accessToken,
      UserCode: code,
      FriendlyDeviceName: body.friendlyName || 'ChecksOps financial step-up',
    });
    const success = String(result.Status || '').toUpperCase() === 'SUCCESS';
    if (!success) {
      return {
        ok: false,
        statusCode: 401,
        error: 'mfa_step_up_failed',
        verified: false,
        message: totpUserFailureMessage({ name: 'CodeMismatchException' }),
        ...financialGate(),
      };
    }
    const recorded = await recordStepUpLog(event, body);
    if (!recorded?.ok) {
      return {
        ok: false,
        statusCode: recorded?.statusCode || 401,
        error: recorded?.error || 'stepup_log_failed',
        verified: true,
        recorded: false,
        message: 'TOTP was valid but the server-side step-up log was not recorded. Production CheckAlt will refuse.',
        ...financialGate(),
      };
    }
    return {
      ok: true,
      statusCode: 200,
      verified: true,
      recorded: true,
      stepup_id: recorded.stepup_id,
      factorType: 'totp',
      ...financialGate(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 401,
      error: 'mfa_step_up_failed',
      message: totpUserFailureMessage(error),
      ...financialGate(),
    };
  }
};

export const MFA_AUTH_ROUTES = {
  '/auth/mfa/status': handleMfaStatus,
  '/auth/mfa/associate': handleMfaAssociate,
  '/auth/mfa/verify': handleMfaVerify,
  '/auth/mfa/step-up': handleMfaStepUp,
  '/auth/mfa/set-preference': handleMfaSetPreference,
};

export const MFA_PREP = {
  userPoolIdConfigured: Boolean(POOL_ID()),
  clientIdConfigured: Boolean(CLIENT_ID()),
  preferredMfaEnabled: false,
  financialPermissionsActivated: false,
};
