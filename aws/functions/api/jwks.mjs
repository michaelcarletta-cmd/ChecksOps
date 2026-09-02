const JWKS_TIMEOUT_MS = 8000;

export const cognitoJwksUrl = (poolId = process.env.COGNITO_USER_POOL_ID) => (
  `https://cognito-idp.us-east-1.amazonaws.com/${poolId}/.well-known/jwks.json`
);

export const fetchCognitoJwks = async ({
  poolId = process.env.COGNITO_USER_POOL_ID,
  fetchImpl = fetch,
} = {}) => {
  if (!poolId) throw new Error('COGNITO_USER_POOL_ID is not configured');
  const url = cognitoJwksUrl(poolId);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        url,
        status: response.status,
        elapsedMs,
        error: `jwks_http_${response.status}`,
      };
    }
    const body = await response.json();
    const keys = Array.isArray(body.keys) ? body.keys.length : 0;
    return {
      ok: keys > 0,
      url,
      status: response.status,
      elapsedMs,
      keyCount: keys,
      via: 'cognito-idp.amazonaws.com',
    };
  } catch (error) {
    return {
      ok: false,
      url,
      elapsedMs: Date.now() - started,
      error: String(error?.message || error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
};
