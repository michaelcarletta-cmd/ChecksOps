/**
 * Cognito software-token MFA helpers for financial step-up preparation.
 * Does NOT enable preferred MFA at login (EMAIL_OTP remains first factor).
 * Does NOT set AWS_FINANCIAL_PERMISSIONS_ACTIVATED. Money stays off.
 */
import { flagTrue } from './ops-readiness.mjs';

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
  return String(body.accessToken || body.access_token || '').trim();
};

const otpauthUri = (secret, email) => {
  const label = encodeURIComponent(email || 'ChecksOps');
  const issuer = encodeURIComponent('ChecksOps');
  return `otpauth://totp/${issuer}:${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&digits=6&period=30`;
};

export const handleMfaStatus = async (event) => {
  const accessToken = accessTokenOf(event);
  if (!accessToken) return { ok: false, statusCode: 400, error: 'missing_access_token', ...financialGate() };
  try {
    const user = await cognitoJson('GetUser', { AccessToken: accessToken });
    const list = user.UserMFASettingList || [];
    const preferred = user.PreferredMfaSetting || null;
    const software = list.includes('SOFTWARE_TOKEN_MFA');
    return {
      ok: true,
      statusCode: 200,
      totpEnrolled: software,
      preferredMfa: preferred,
      factors: software ? [{ id: 'software-token', factorType: 'totp', status: 'verified' }] : [],
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
  const code = String(body.code || body.userCode || '').replace(/\s+/g, '');
  if (!accessToken || !/^\d{6}$/.test(code)) {
    return { ok: false, statusCode: 400, error: 'missing_verify_fields', ...financialGate() };
  }
  try {
    const result = await cognitoJson('VerifySoftwareToken', {
      AccessToken: accessToken,
      UserCode: code,
      FriendlyDeviceName: body.friendlyName || 'ChecksOps authenticator',
    });
    const success = String(result.Status || '').toUpperCase() === 'SUCCESS';
    return {
      ok: success,
      statusCode: success ? 200 : 401,
      verified: success,
      enrollment: true,
      preferredMfaEnabled: false,
      remaining: 'Preferred MFA is intentionally off so EMAIL_OTP login is unchanged. Financial flags stay false.',
      ...financialGate(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 401,
      error: 'mfa_verify_failed',
      message: String(error.message || error).slice(0, 200),
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

export const MFA_AUTH_ROUTES = {
  '/auth/mfa/status': handleMfaStatus,
  '/auth/mfa/associate': handleMfaAssociate,
  '/auth/mfa/verify': handleMfaVerify,
  '/auth/mfa/set-preference': handleMfaSetPreference,
};

export const MFA_PREP = {
  userPoolIdConfigured: Boolean(POOL_ID()),
  clientIdConfigured: Boolean(CLIENT_ID()),
  preferredMfaEnabled: false,
  financialPermissionsActivated: false,
};
