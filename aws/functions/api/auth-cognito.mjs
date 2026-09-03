import { WEBAUTHN_AUTH_ROUTES, WEBAUTHN_STAGING } from './auth-webauthn.mjs';

const POOL_ID = () => process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = () => process.env.COGNITO_CLIENT_ID;
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';

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

const emailOf = (value) => String(value || '').trim().toLowerCase();
const codeOf = (value) => String(value || '').trim().replace(/\s+/g, '');

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

/**
 * Native Cognito passwordless start.
 *
 * Uses choice-based USER_AUTH with EMAIL_OTP. This route intentionally does
 * not accept a password. PreventUserExistenceErrors on the app client remains
 * the enumeration boundary; callers get a generic failure if the account is
 * not eligible for EMAIL_OTP.
 *
 * Production ChecksOps remains unchanged. This is staging Cognito only.
 */
export const handleAuthPasswordlessStart = async (event) => {
  const body = parseBody(event);
  const email = emailOf(body.email || body.username);
  if (!email) return { ok: false, statusCode: 400, error: 'missing_email' };
  try {
    const result = await cognitoJson('InitiateAuth', {
      AuthFlow: 'USER_AUTH',
      ClientId: CLIENT_ID(),
      AuthParameters: {
        USERNAME: email,
        PREFERRED_CHALLENGE: 'EMAIL_OTP',
      },
    });

    if (result.AuthenticationResult) {
      return {
        ok: true,
        statusCode: 200,
        completed: true,
        authentication: authenticationOf(result),
      };
    }

    const challenge = result.ChallengeName || null;
    if (challenge !== 'EMAIL_OTP') {
      return {
        ok: false,
        statusCode: 409,
        error: 'email_otp_unavailable',
        challenge,
        availableChallenges: Array.isArray(result.AvailableChallenges) ? result.AvailableChallenges : [],
        message: 'This staging Cognito account is not currently eligible for passwordless email OTP.',
      };
    }

    return {
      ok: true,
      statusCode: 200,
      completed: false,
      challenge: 'EMAIL_OTP',
      session: result.Session,
      email,
      delivery: {
        destination: result.ChallengeParameters?.CODE_DELIVERY_DESTINATION || null,
        deliveryMedium: 'EMAIL',
      },
      passwordUsed: false,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'passwordless_start_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

/** Completes native Cognito EMAIL_OTP and returns normal Cognito JWTs. */
export const handleAuthPasswordlessVerify = async (event) => {
  const body = parseBody(event);
  const email = emailOf(body.email || body.username);
  const session = String(body.session || '').trim();
  const code = codeOf(body.code || body.otp || body.emailOtp || body.answer);
  if (!email || !session || !code) {
    return { ok: false, statusCode: 400, error: 'missing_passwordless_fields' };
  }
  try {
    const result = await cognitoJson('RespondToAuthChallenge', {
      ClientId: CLIENT_ID(),
      ChallengeName: 'EMAIL_OTP',
      Session: session,
      ChallengeResponses: {
        USERNAME: email,
        EMAIL_OTP_CODE: code,
      },
    });
    const authentication = authenticationOf(result);
    if (!authentication) {
      return {
        ok: false,
        statusCode: 409,
        error: 'passwordless_challenge_incomplete',
        challenge: result.ChallengeName || null,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      completed: true,
      authentication,
      passwordUsed: false,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'passwordless_verify_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

/** Legacy staging password flow retained only until passwordless rollout is proven. */
export const handleAuthLogin = async (event) => {
  const body = parseBody(event);
  const email = emailOf(body.email || body.username);
  const password = body.password;
  if (!email || !password) {
    return { ok: false, statusCode: 400, error: 'missing_credentials' };
  }
  try {
    const result = await cognitoJson('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID(),
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      return {
        ok: true,
        statusCode: 200,
        challenge: 'NEW_PASSWORD_REQUIRED',
        session: result.Session,
        email,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      challenge: null,
      authentication: authenticationOf(result),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 401,
      error: 'login_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

export const handleAuthChallenge = async (event) => {
  const body = parseBody(event);
  const email = emailOf(body.email || body.username);
  const session = body.session;
  const newPassword = body.newPassword || body.password;
  if (!email || !session || !newPassword) {
    return { ok: false, statusCode: 400, error: 'missing_challenge_fields' };
  }
  try {
    const result = await cognitoJson('RespondToAuthChallenge', {
      ClientId: CLIENT_ID(),
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    });
    return {
      ok: true,
      statusCode: 200,
      authentication: authenticationOf(result),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.statusCode || 400,
      error: 'challenge_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

export const handleAuthRefresh = async (event) => {
  const body = parseBody(event);
  const refreshToken = body.refreshToken;
  if (!refreshToken) return { ok: false, statusCode: 400, error: 'missing_refresh_token' };
  try {
    const result = await cognitoJson('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID(),
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    });
    return {
      ok: true,
      statusCode: 200,
      authentication: authenticationOf(result, refreshToken),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 401,
      error: 'refresh_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

export const handleAuthForgot = async (event) => {
  const body = parseBody(event);
  const email = emailOf(body.email || body.username);
  if (!email) return { ok: false, statusCode: 400, error: 'missing_email' };
  if (email !== TESTER_EMAIL) {
    return {
      ok: true,
      statusCode: 200,
      sent: false,
      suppressed: true,
      message: 'Staging forgot-password is limited to the controlled Tester mailbox',
    };
  }
  try {
    const result = await cognitoJson('ForgotPassword', {
      ClientId: CLIENT_ID(),
      Username: email,
    });
    return {
      ok: true,
      statusCode: 200,
      sent: true,
      email,
      delivery: {
        destination: result.CodeDeliveryDetails?.Destination || null,
        deliveryMedium: result.CodeDeliveryDetails?.DeliveryMedium || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      error: 'forgot_password_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

export const handleAuthConfirmForgot = async (event) => {
  const body = parseBody(event);
  const email = emailOf(body.email || body.username);
  const code = String(body.code || body.confirmationCode || '').trim();
  const password = body.password || body.newPassword;
  if (!email || !code || !password) {
    return { ok: false, statusCode: 400, error: 'missing_confirm_fields' };
  }
  if (email !== TESTER_EMAIL) {
    return { ok: false, statusCode: 403, error: 'tester_mailbox_only' };
  }
  try {
    await cognitoJson('ConfirmForgotPassword', {
      ClientId: CLIENT_ID(),
      Username: email,
      ConfirmationCode: code,
      Password: password,
    });
    return { ok: true, statusCode: 200, confirmed: true, email };
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      error: 'confirm_forgot_failed',
      message: String(error.message || error).slice(0, 200),
    };
  }
};

export const handleAuthLogout = async (event) => {
  const body = parseBody(event);
  const accessToken = body.accessToken;
  if (accessToken) {
    try {
      await cognitoJson('GlobalSignOut', { AccessToken: accessToken });
    } catch {
      // Best-effort. ID tokens remain valid until exp.
    }
  }
  return { ok: true, statusCode: 200, signedOut: true };
};

export const AUTH_ROUTES = {
  '/auth/passwordless/start': handleAuthPasswordlessStart,
  '/auth/passwordless/verify': handleAuthPasswordlessVerify,
  '/auth/email/start': handleAuthPasswordlessStart,
  '/auth/email/verify': handleAuthPasswordlessVerify,
  '/auth/login': handleAuthLogin,
  '/auth/challenge': handleAuthChallenge,
  '/auth/refresh': handleAuthRefresh,
  '/auth/forgot': handleAuthForgot,
  '/auth/confirm-forgot': handleAuthConfirmForgot,
  '/auth/logout': handleAuthLogout,
  ...WEBAUTHN_AUTH_ROUTES,
};

export const PASSWORDLESS_AUTH = {
  userPoolIdConfigured: Boolean(POOL_ID()),
  clientIdConfigured: Boolean(CLIENT_ID()),
  authFlow: 'USER_AUTH',
  preferredChallenge: 'EMAIL_OTP',
  passwordAcceptedByPasswordlessRoutes: false,
  webAuthn: WEBAUTHN_STAGING,
};
