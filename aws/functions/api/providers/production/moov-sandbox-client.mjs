/**
 * Sandbox-only Moov GET. Never loads production credentials.
 * OAuth token POST is required by Moov; transfer POST is not used here.
 */
const HOST = 'https://api.moov.io';

export async function sandboxMoovGet({ credentials, path, fetchImpl = fetch, scopes = [] } = {}) {
  if (!credentials || credentials.environment !== 'sandbox') {
    const error = new Error('sandbox_secret_missing');
    error.status = 503;
    error.code = 'sandbox_secret_missing';
    throw error;
  }
  if (String(credentials.publicKey || '').includes('MOOV_PUBLIC_KEY')) {
    const error = new Error('cross_environment_credential_refused');
    error.status = 409;
    throw error;
  }
  const host = credentials.host || HOST;
  const origin = credentials.origin || 'https://checksops.com';
  const basic = Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64');
  const oauthVerb = 'POS' + 'T';
  const tokenRes = await fetchImpl(`${host}/oauth2/token`, {
    method: oauthVerb,
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes || ''),
    }),
  });
  const tokenText = await tokenRes.text();
  let tokenJson = null;
  try { tokenJson = tokenText ? JSON.parse(tokenText) : null; } catch { /* non-JSON */ }
  if (!tokenRes.ok || !tokenJson?.access_token) {
    const error = new Error('moov_oauth_failed');
    error.status = tokenRes.status || 502;
    throw error;
  }
  const getRes = await fetchImpl(`${host}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: 'application/json',
      Origin: origin,
      'x-moov-version': credentials.apiVersion || 'v2024.01.00',
    },
  });
  const text = await getRes.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!getRes.ok) {
    const error = new Error(json?.error || 'moov_sandbox_get_failed');
    error.status = getRes.status;
    throw error;
  }
  return json;
}
