/**
 * Cognito native WebAuthn (passkey) routes.
 * Production Supabase SimpleWebAuthn is untouched.
 *
 * Default RP ID / origin is the staging pool (staging.checksops.com).
 * A future production pool may set COGNITO_WEBAUTHN_ORIGIN / COGNITO_WEBAUTHN_RP_ID.
 * Registration requires an already-authenticated Cognito access token (EMAIL_OTP first).
 */

const POOL_ID = () => process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = () => process.env.COGNITO_CLIENT_ID;
export const DEFAULT_WEBAUTHN_ORIGIN = 'https://staging.checksops.com';
export const DEFAULT_WEBAUTHN_RP_ID = 'staging.checksops.com';

export const configuredWebAuthnOrigin = () => {
  const raw = String(process.env.COGNITO_WEBAUTHN_ORIGIN || DEFAULT_WEBAUTHN_ORIGIN).trim().replace(/\/$/, '');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return DEFAULT_WEBAUTHN_ORIGIN;
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_WEBAUTHN_ORIGIN;
  }
};

export const configuredWebAuthnRpId = () => {
  const explicit = String(process.env.COGNITO_WEBAUTHN_RP_ID || '').trim().toLowerCase();
  if (explicit) return explicit;
  try {
    return new URL(configuredWebAuthnOrigin()).hostname;
  } catch {
    return DEFAULT_WEBAUTHN_RP_ID;
  }
};

export const isAllowedWebAuthnOrigin = (requestOrigin, allowedOrigin = configuredWebAuthnOrigin()) => (
  String(requestOrigin || '').replace(/\/$/, '') === allowedOrigin
);

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

const parseBody = (event) => {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { return JSON.parse(raw); } catch { return {}; }
};

const headerOf = (event, name) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]),
  );
  return lower[String(name).toLowerCase()] || null;
};

const bearerAccessToken = (event) => {
  const header = headerOf(event, 'authorization') || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

const emailOf = (value) => String(value || '').trim().toLowerCase();

const authenticationOf = (result, refreshTokenFallback = null) => {
  const auth = result?.AuthenticationResult || {};
  if (!auth.IdToken || !auth.AccessToken) return null;
  return {
    idToken: auth.IdToken,
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken || refreshTokenFallback || null,
    expiresIn: auth.ExpiresIn,
    tokenType: auth.TokenType || 'Bearer',
  };
};

const originAllowed = (event) => isAllowedWebAuthnOrigin(headerOf(event, 'origin'));

const requireStagingOrigin = (event) => {
  if (!originAllowed(event)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'staging_https_origin_required',
      message: `Passkeys are only available from ${configuredWebAuthnOrigin()}`,
      rpId: configuredWebAuthnRpId(),
    };
  }
  return null;
};

/**
 * Cognito ListWebAuthnCredentials returns CreatedAt as UNIX epoch seconds
 * (often fractional). Never pass raw seconds through to Date() consumers —
 * JS Date(number) treats values as milliseconds and renders ~Jan 1970.
 * Cognito does not expose last-used on this API.
 */
export const normalizeWebAuthnCreatedAt = (value) => {
  if (value == null || value === '') return null;
  let date = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    date = new Date(ms);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return null;
      const ms = numeric > 1e12 ? numeric : numeric * 1000;
      date = new Date(ms);
    } else {
      date = new Date(trimmed);
    }
  } else {
    return null;
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  // Guard against epoch / nonsense (seconds misread as ms).
  if (date.getUTCFullYear() < 2000) return null;
  return date.toISOString();
};

/** Map one Cognito WebAuthnCredentialDescription to a safe API credential. */
export const mapWebAuthnCredential = (row = {}) => {
  const friendlyName = String(
    row.FriendlyCredentialName
      || row.friendlyCredentialName
      || row.FriendlyName
      || row.friendlyName
      || '',
  ).trim() || null;
  const attachment = String(
    row.AuthenticatorAttachment || row.authenticatorAttachment || '',
  ).trim() || null;
  const transports = row.AuthenticatorTransports || row.authenticatorTransports;
  return {
    credentialId: row.CredentialId || row.credentialId || null,
    friendlyName,
    relyingPartyId: row.RelyingPartyId || row.relyingPartyId || configuredWebAuthnRpId(),
    createdAt: normalizeWebAuthnCreatedAt(row.CreatedAt ?? row.createdAt),
    authenticatorAttachment: attachment,
    authenticatorTransports: Array.isArray(transports) ? transports : [],
    // Cognito ListWebAuthnCredentials does not return last-used metadata.
    lastUsedAt: null,
  };
};

/** Start Cognito WebAuthn registration for an already-authenticated user. */
export const handleAuthPasskeyRegisterOptions = async (event) => {
  const blocked = requireStagingOrigin(event);
  if (blocked) return blocked;
  const accessToken = bearerAccessToken(event);
  if (!accessToken) return { ok: false, statusCode: 401, error: 'missing_access_token' };
  try {
    const result = await cognitoJson('StartWebAuthnRegistration', { AccessToken: accessToken });
    return {
      ok: true,
      statusCode: 200,
      rpId: configuredWebAuthnRpId(),
      origin: configuredWebAuthnOrigin(),
      // Cognito returns CredentialCreationOptions under CredentialCreationOptions or similar
      options: result.CredentialCreationOptions || result.credentialCreationOptions || result,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'passkey_register_options_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

/** Complete Cognito WebAuthn registration with the browser attestation. */
export const handleAuthPasskeyRegisterVerify = async (event) => {
  const blocked = requireStagingOrigin(event);
  if (blocked) return blocked;
  const accessToken = bearerAccessToken(event);
  const body = parseBody(event);
  const credential = body.credential || body.attestation || body.response;
  if (!accessToken) return { ok: false, statusCode: 401, error: 'missing_access_token' };
  if (!credential) return { ok: false, statusCode: 400, error: 'missing_credential' };
  try {
    await cognitoJson('CompleteWebAuthnRegistration', {
      AccessToken: accessToken,
      Credential: credential,
    });
    return {
      ok: true,
      statusCode: 200,
      registered: true,
      rpId: configuredWebAuthnRpId(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'passkey_register_verify_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

/** List Cognito-registered passkeys for the signed-in user. */
export const handleAuthPasskeyList = async (event) => {
  const blocked = requireStagingOrigin(event);
  if (blocked) return blocked;
  const accessToken = bearerAccessToken(event);
  if (!accessToken) return { ok: false, statusCode: 401, error: 'missing_access_token' };
  try {
    const result = await cognitoJson('ListWebAuthnCredentials', { AccessToken: accessToken });
    const credentials = result.Credentials || result.credentials || [];
    return {
      ok: true,
      statusCode: 200,
      credentials: credentials.map((row) => mapWebAuthnCredential(row)),
      rpId: configuredWebAuthnRpId(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'passkey_list_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

/** Delete one Cognito passkey credential. */
export const handleAuthPasskeyDelete = async (event) => {
  const blocked = requireStagingOrigin(event);
  if (blocked) return blocked;
  const accessToken = bearerAccessToken(event);
  const body = parseBody(event);
  const credentialId = String(body.credentialId || body.credential_id || '').trim();
  if (!accessToken) return { ok: false, statusCode: 401, error: 'missing_access_token' };
  if (!credentialId) return { ok: false, statusCode: 400, error: 'missing_credential_id' };
  try {
    await cognitoJson('DeleteWebAuthnCredential', {
      AccessToken: accessToken,
      CredentialId: credentialId,
    });
    return { ok: true, statusCode: 200, deleted: true };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'passkey_delete_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

/** Begin Cognito USER_AUTH with preferred WEB_AUTHN challenge. */
export const handleAuthPasskeyAuthenticateStart = async (event) => {
  const blocked = requireStagingOrigin(event);
  if (blocked) return blocked;
  const body = parseBody(event);
  const email = emailOf(body.email || body.username);
  if (!email) return { ok: false, statusCode: 400, error: 'missing_email' };
  try {
    const result = await cognitoJson('InitiateAuth', {
      AuthFlow: 'USER_AUTH',
      ClientId: CLIENT_ID(),
      AuthParameters: {
        USERNAME: email,
        PREFERRED_CHALLENGE: 'WEB_AUTHN',
      },
    });
    if (result.AuthenticationResult) {
      return {
        ok: true,
        statusCode: 200,
        completed: true,
        authentication: authenticationOf(result),
        passwordUsed: false,
      };
    }
    const challenge = result.ChallengeName || null;
    if (challenge !== 'WEB_AUTHN') {
      return {
        ok: false,
        statusCode: 409,
        error: 'webauthn_unavailable',
        challenge,
        availableChallenges: Array.isArray(result.AvailableChallenges) ? result.AvailableChallenges : [],
        message: 'Passkey sign-in is not available for this account. Use email verification code instead.',
      };
    }
    let credentialRequestOptions = null;
    try {
      credentialRequestOptions = result.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS
        ? JSON.parse(result.ChallengeParameters.CREDENTIAL_REQUEST_OPTIONS)
        : null;
    } catch {
      credentialRequestOptions = null;
    }
    return {
      ok: true,
      statusCode: 200,
      completed: false,
      challenge: 'WEB_AUTHN',
      session: result.Session,
      email,
      options: credentialRequestOptions,
      rpId: configuredWebAuthnRpId(),
      passwordUsed: false,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'passkey_authenticate_start_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

/** Complete Cognito WEB_AUTHN challenge and return JWTs. */
export const handleAuthPasskeyAuthenticateVerify = async (event) => {
  const blocked = requireStagingOrigin(event);
  if (blocked) return blocked;
  const body = parseBody(event);
  const email = emailOf(body.email || body.username);
  const session = String(body.session || '').trim();
  const credential = body.credential || body.assertion || body.response;
  if (!email || !session || !credential) {
    return { ok: false, statusCode: 400, error: 'missing_passkey_auth_fields' };
  }
  try {
    const result = await cognitoJson('RespondToAuthChallenge', {
      ClientId: CLIENT_ID(),
      ChallengeName: 'WEB_AUTHN',
      Session: session,
      ChallengeResponses: {
        USERNAME: email,
        CREDENTIAL: typeof credential === 'string' ? credential : JSON.stringify(credential),
      },
    });
    const authentication = authenticationOf(result);
    if (!authentication) {
      return {
        ok: false,
        statusCode: 409,
        error: 'passkey_challenge_incomplete',
        challenge: result.ChallengeName || null,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      completed: true,
      authentication,
      passwordUsed: false,
      rpId: configuredWebAuthnRpId(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'passkey_authenticate_verify_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

export const WEBAUTHN_AUTH_ROUTES = {
  '/auth/passkey/register/options': handleAuthPasskeyRegisterOptions,
  '/auth/passkey/register/verify': handleAuthPasskeyRegisterVerify,
  '/auth/passkey/list': handleAuthPasskeyList,
  '/auth/passkey/delete': handleAuthPasskeyDelete,
  '/auth/passkey/authenticate/start': handleAuthPasskeyAuthenticateStart,
  '/auth/passkey/authenticate/verify': handleAuthPasskeyAuthenticateVerify,
};

export const WEBAUTHN_STAGING = {
  get enabled() { return Boolean(POOL_ID()) && Boolean(CLIENT_ID()); },
  get rpId() { return configuredWebAuthnRpId(); },
  get requiredOrigin() { return configuredWebAuthnOrigin(); },
  registrationRequiresAuthenticatedSession: true,
  emailOtpFallback: true,
};
