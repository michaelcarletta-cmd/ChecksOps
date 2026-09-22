export const APP_USER_ID_GUC = 'request.app_user_id';
export const APP_USER_EMAIL_GUC = 'request.jwt.claim.email';

export const cognitoClaimsFromEvent = (event) => {
  const jwt = event?.requestContext?.authorizer?.jwt?.claims
    || event?.requestContext?.authorizer?.claims
    || null;
  if (!jwt || typeof jwt !== 'object') return null;
  const sub = jwt.sub || jwt.username || null;
  if (!sub) return null;
  return {
    sub: String(sub),
    email: jwt.email ? String(jwt.email) : null,
    tokenUse: jwt.token_use || jwt.tokenUse || null,
    iss: jwt.iss ? String(jwt.iss) : null,
  };
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
  return {
    sub: String(payload.sub),
    email: payload.email ? String(payload.email) : null,
    tokenUse: payload.token_use || 'id',
    iss: payload.iss ? String(payload.iss) : `https://cognito-idp.us-east-1.amazonaws.com/${poolId}`,
  };
};

export const refuseSubAsApplicationId = (applicationUserId, cognitoSub) => {
  if (!applicationUserId || !cognitoSub) return;
  if (String(applicationUserId) === String(cognitoSub)) {
    throw new Error('refusing identity mapping where application_user_id equals cognito_sub');
  }
};
