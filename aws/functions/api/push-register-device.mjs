/**
 * The phones a signed-in user receives ChecksOps push notifications on (route push-register-device).
 *
 * The iOS/Android app (PR 2016, src/components/NativePushRegistration.tsx) asks permission after sign-in, gets the
 * phone's push token from Apple or Google and posts { token, platform } here. The token is kept by SQL 171
 * (aws/workflows/sql/171_device_push_tokens.sql): public.aws_push_register_device(platform, token) for the signed-in
 * user (auth.uid()), and public.aws_push_unregister_device(token) for { action: 'unregister', token } (sign-out or
 * notifications turned off; the app does not send it yet). Both are SECURITY DEFINER, EXECUTE checksops only, and
 * the only way to the table: RLS on, no policy, no grant.
 *
 * Runs as the verified sign-in exactly as external-disbursement.mjs and the Mortgage Desk routes do (withIdentity:
 * request.app_user_id set from the Cognito identity mapping, never from the body), one DEFINER call in a write
 * transaction that commits. The body is checked before any database connection: a request without a sign-in
 * answers 401, a bad token or platform 400. Nothing here sends a notification or reads a token; the token is never
 * logged (at most its sha256 prefix).
 */
import { createHash } from 'node:crypto';
import { ignoredSpoof, parseBody, resolveClaims, withIdentity } from './data.mjs';

export const PUSH_REGISTER_SQL = 'SELECT public.aws_push_register_device($1::text, $2::text) AS id';
export const PUSH_UNREGISTER_SQL = 'SELECT public.aws_push_unregister_device($1::text) AS removed';
export const PUSH_PLATFORMS = Object.freeze(['ios', 'android']);
export const PUSH_TOKEN_MAX = 4096;

const WHITESPACE_RE = /\s/;

const refuse = (statusCode, error, message, spoof) => ({ ok: false, statusCode, error, message, spoofFieldsIgnored: spoof });

/** A short, non-reversible reference to a token for logs (never the token itself). */
export const tokenRef = (token) => createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex').slice(0, 12);

/**
 * The request: { token, platform } registers this phone; { action: 'unregister', token } removes it.
 * The same rules as SQL 171's own checks (platform ios or android; token 1 to 4096 characters, no whitespace).
 */
export function parsePushRequest(body = {}) {
  const action = body?.action == null || body.action === '' ? 'register' : body.action;
  if (action !== 'register' && action !== 'unregister') return { error: 'invalid_action', message: "action must be 'register' or 'unregister'" };
  const token = body?.token;
  if (typeof token !== 'string' || token.length < 1 || token.length > PUSH_TOKEN_MAX || WHITESPACE_RE.test(token)) {
    return { error: 'invalid_token', message: `token must be 1 to ${PUSH_TOKEN_MAX} characters with no spaces` };
  }
  if (action === 'unregister') return { action, token };
  const platform = body?.platform;
  if (typeof platform !== 'string' || !PUSH_PLATFORMS.includes(platform)) {
    return { error: 'invalid_platform', message: "platform must be 'ios' or 'android'" };
  }
  return { action, token, platform };
}

/** SQL 171's refusals -> an API answer; anything else is a 500 without details. */
export function mapPushSqlError(error, spoof) {
  const code = error?.code || null;
  if (code === '42501') return refuse(403, 'not_authorized', 'Sign in to register this device for notifications.', spoof);
  if (code === '22023') {
    const which = /invalid_platform/.test(String(error?.message || '')) ? 'invalid_platform' : 'invalid_token';
    return refuse(400, which, which === 'invalid_platform' ? "platform must be 'ios' or 'android'" : 'The device token is not valid.', spoof);
  }
  if (code === '42883') {
    // SQL 171 is not applied in this environment.
    return refuse(503, 'push_registration_unavailable', 'Notifications are not available yet. Nothing was saved.', spoof);
  }
  return refuse(500, 'push_registration_failed', 'The device could not be saved for notifications.', spoof);
}

const logFailure = (event, request, error) => {
  console.error(JSON.stringify({
    service: 'checksops-api',
    event: 'push_register_device_failed',
    action: request.action,
    platform: request.platform || null,
    tokenRef: tokenRef(request.token),
    sqlstate: error?.code || null,
    requestId: event?.requestContext?.requestId || null,
  }));
};

/** The one DEFINER call, inside withIdentity's transaction (request.app_user_id already set). */
export async function runPushRegisterDevice({ client, body, spoof, request, event }) {
  const parsed = request || parsePushRequest(body);
  if (parsed.error) return refuse(400, parsed.error, parsed.message, spoof);
  try {
    if (parsed.action === 'unregister') {
      const removed = (await client.query(PUSH_UNREGISTER_SQL, [parsed.token])).rows[0]?.removed === true;
      return { ok: true, statusCode: 200, removed, spoofFieldsIgnored: spoof };
    }
    const id = (await client.query(PUSH_REGISTER_SQL, [parsed.platform, parsed.token])).rows[0]?.id || null;
    if (!id) {
      logFailure(event, parsed, { code: 'no_row' });
      return refuse(500, 'push_registration_failed', 'The device could not be saved for notifications.', spoof);
    }
    return { ok: true, statusCode: 200, id, spoofFieldsIgnored: spoof };
  } catch (error) {
    logFailure(event, parsed, error);
    return mapPushSqlError(error, spoof);
  }
}

export async function handlePushRegisterDevice(event, deps = {}) {
  // A sign-in first (401 without one), then the body, then the database.
  const claims = await (deps.resolveClaims || resolveClaims)(event);
  if (!claims.ok) return claims;
  const body = parseBody(event);
  const request = parsePushRequest(body);
  if (request.error) return refuse(400, request.error, request.message, ignoredSpoof(event, body));
  return (deps.withIdentity || withIdentity)(event, (ctx) => runPushRegisterDevice({ ...ctx, request, event }), {
    write: true,
    commit: true,
    ...deps,
  });
}
