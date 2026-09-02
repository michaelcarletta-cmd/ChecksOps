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
    const auth = result.AuthenticationResult || {};
    return {
      ok: true,
      statusCode: 200,
      challenge: null,
      authentication: {
        idToken: auth.IdToken,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        expiresIn: auth.ExpiresIn,
        tokenType: auth.TokenType || 'Bearer',
      },
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
    const auth = result.AuthenticationResult || {};
    return {
      ok: true,
      statusCode: 200,
      authentication: {
        idToken: auth.IdToken,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        expiresIn: auth.ExpiresIn,
        tokenType: auth.TokenType || 'Bearer',
      },
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
    const auth = result.AuthenticationResult || {};
    return {
      ok: true,
      statusCode: 200,
      authentication: {
        idToken: auth.IdToken,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken || refreshToken,
        expiresIn: auth.ExpiresIn,
        tokenType: auth.TokenType || 'Bearer',
      },
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
  '/auth/login': handleAuthLogin,
  '/auth/challenge': handleAuthChallenge,
  '/auth/refresh': handleAuthRefresh,
  '/auth/forgot': handleAuthForgot,
  '/auth/confirm-forgot': handleAuthConfirmForgot,
  '/auth/logout': handleAuthLogout,
};
