/**
 * Resolve a pay-setup token against live production (Supabase), not stale RDS.
 * RDS copies omit secure_token and RLS hides recipient rows from the Lambda role.
 * Auth: CHECKSOPS_DB_BRIDGE_TOKEN (migration token). Never returns the token.
 */
export const PRODUCTION_RECIPIENT_BRIDGE_URL =
  process.env.CHECKSOPS_DB_BRIDGE_URL
  || 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';

export const productionRecipientBridgeConfigured = () => Boolean(String(
  process.env.CHECKSOPS_DB_BRIDGE_TOKEN || '',
).trim());

const ANON = process.env.CHECKSOPS_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';

export async function resolveProductionRecipientByToken({
  token,
  fetchImpl = fetch,
  bridgeUrl = PRODUCTION_RECIPIENT_BRIDGE_URL,
  bridgeToken = process.env.CHECKSOPS_DB_BRIDGE_TOKEN,
} = {}) {
  const secret = String(bridgeToken || '').trim();
  if (!secret) {
    return { ok: false, configured: false, error: 'recipient_lookup_unconfigured', statusCode: 503 };
  }
  const response = await fetchImpl(bridgeUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-checksops-migration-token': secret,
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify({ action: 'recipient_session_resolve', token }),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status === 404 || json.error === 'This link is not valid.' || json.error === 'not_found') {
    return { ok: false, configured: true, error: 'This link is not valid.', statusCode: 404 };
  }
  if (!response.ok || json.ok !== true || !json.recipient) {
    return {
      ok: false,
      configured: true,
      error: json.error || 'recipient_lookup_failed',
      statusCode: response.status >= 400 ? response.status : 503,
      message: json.message || 'Could not resolve this payment-setup link.',
    };
  }
  return {
    ok: true,
    configured: true,
    recipient: json.recipient,
    tenant: json.tenant || null,
  };
}
