export const APP_USER_ID_GUC = 'request.app_user_id';
export const APP_USER_EMAIL_GUC = 'request.jwt.claim.email';

const claimValue = (source, ...keys) => {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return null;
};

const normalizeAuthClaims = (raw) => {
  const sub = claimValue(raw, 'sub', 'username');
  if (!sub) return null;
  return {
    sub: String(sub),
    email: claimValue(raw, 'email') ? String(claimValue(raw, 'email')) : null,
    tokenUse: claimValue(raw, 'token_use', 'tokenUse'),
    originJti: claimValue(raw, 'origin_jti', 'originJti')
      ? String(claimValue(raw, 'origin_jti', 'originJti'))
      : null,
    authTime: claimValue(raw, 'auth_time', 'authTime')
      ? String(claimValue(raw, 'auth_time', 'authTime'))
      : null,
    iat: claimValue(raw, 'iat'),
    jti: claimValue(raw, 'jti') ? String(claimValue(raw, 'jti')) : null,
  };
};

/**
 * Bind financial TOTP to this Cognito login, not to a browser flag and not to
 * Cognito SOFTWARE_TOKEN_MFA. origin_jti (or sub+auth_time) changes on a new
 * login and survives access/id token refresh.
 */
export const loginSessionIdFromClaims = (claims) => {
  if (!claims?.sub) return null;
  const origin = claims.originJti || claims.origin_jti;
  if (origin) return `origin_jti:${origin}`;
  const authTime = claims.authTime || claims.auth_time;
  if (authTime !== undefined && authTime !== null && String(authTime) !== '') {
    return `auth_time:${claims.sub}:${authTime}`;
  }
  return null;
};

export const cognitoClaimsFromEvent = (event) => {
  const jwt = event?.requestContext?.authorizer?.jwt?.claims
    || event?.requestContext?.authorizer?.claims
    || null;
  return normalizeAuthClaims(jwt);
};

export const bearerToken = (event) => {
  const header = event?.headers?.authorization || event?.headers?.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

export const verifyCognitoIdToken = async (token) => {
  const poolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!poolId || !clientId) {
    throw new Error('COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID is not configured');
  }
  const { CognitoJwtVerifier } = await import('aws-jwt-verify');
  const verifier = CognitoJwtVerifier.create({
    userPoolId: poolId,
    tokenUse: 'id',
    clientId,
  });
  const payload = await verifier.verify(token);
  return normalizeAuthClaims({
    ...payload,
    token_use: payload.token_use || 'id',
  });
};

export const refuseSubAsApplicationId = (applicationUserId, cognitoSub) => {
  if (!applicationUserId || !cognitoSub) return;
  if (String(applicationUserId) === String(cognitoSub)) {
    throw new Error('refusing identity mapping where application_user_id equals cognito_sub');
  }
};
