/**
 * Application-level financial TOTP handlers.
 * Does not call Cognito software-token or MFA-preference APIs.
 * Login remains EMAIL_OTP / WebAuthn. Money flags stay off.
 */
import { createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { flagTrue } from './ops-readiness.mjs';
import { evaluatePrivilegedEnrollment, privilegedAuthPolicy } from './privileged-auth.mjs';
import { normalizeTotpCode, totpUserFailureMessage } from './auth-totp-code.mjs';
import { getSecretStringFromAws } from './secrets.mjs';
import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from './cognito.mjs';
import { commitWriteTransaction, withIdentityWrite } from './data.mjs';
import { platformBranding } from './email-branding.mjs';
import { renderChecksOpsEmail } from './email-layout.mjs';
import { emailMode, isProductionEmailEnv } from './email-policy.mjs';
import { sendViaSesOrSink } from './email.mjs';
import {
  encryptSecret,
  decryptSecret,
  enrollmentResponseWithoutSecret,
  evaluateFinancialTotpEnrollment,
  generateTotpSecret,
  otpauthUri,
  verifyFinancialTotp,
  wrapKeyFromHex,
} from './financial-totp.mjs';

const parseBody = (event) => {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { return JSON.parse(raw); } catch { return {}; }
};

const financialGate = () => ({
  financialPermissionsActivated: flagTrue('AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
  providerExecutionEnabled: flagTrue('AWS_PROVIDER_EXECUTION_ENABLED'),
  cognitoMfaPreferred: flagTrue('AWS_COGNITO_MFA_PREFERRED'),
  moneyMovementUnlocked: false,
});

const productionEnv = () => {
  const env = String(process.env.CHECKSOPS_ENV || '');
  return env === 'production' || env === 'production-prep';
};

export const parseWrapKeySecret = (raw) => {
  const text = String(raw || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return { key: wrapKeyFromHex(text), keyId: 'financial-totp-v1' };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const hex = parsed?.key || parsed?.wrapKey || parsed?.hex;
  if (!hex) throw new Error('invalid_wrap_key');
  return {
    key: wrapKeyFromHex(hex),
    keyId: String(parsed.keyId || parsed.key_id || 'financial-totp-v1'),
  };
};

export const loadFinancialTotpWrapKey = async (getSecretString = getSecretStringFromAws) => {
  const arn = process.env.FINANCIAL_TOTP_WRAP_KEY_ARN;
  if (arn) return parseWrapKeySecret(await getSecretString(arn));
  if (productionEnv()) {
    const error = new Error('wrap_key_unconfigured');
    error.statusCode = 503;
    throw error;
  }
  if (process.env.FINANCIAL_TOTP_WRAP_KEY) {
    return { key: wrapKeyFromHex(process.env.FINANCIAL_TOTP_WRAP_KEY), keyId: 'financial-totp-v1' };
  }
  const error = new Error('wrap_key_unconfigured');
  error.statusCode = 503;
  throw error;
};

const schemaMissing = (error) => {
  const message = String(error?.message || '');
  return error?.code === '42883' || /does not exist|financial_totp_/i.test(message);
};

const wrapFail = (error) => {
  const missingSchema = schemaMissing(error);
  const missingWrap = error.message === 'wrap_key_unconfigured';
  const missingRate = error.message === 'rate_limit_unavailable';
  return {
    ok: false,
    statusCode: error.statusCode || (missingSchema || missingWrap || missingRate ? 503 : 401),
    error: missingSchema
      ? 'financial_totp_schema_unapplied'
      : (missingWrap ? 'wrap_key_unconfigured' : (missingRate ? 'rate_limit_unavailable' : 'financial_totp_failed')),
    message: missingWrap
      ? 'Financial TOTP wrap key is not configured.'
      : (missingSchema
        ? 'Financial TOTP schema is not applied.'
        : (missingRate
          ? 'Financial TOTP rate-limit storage is unavailable.'
          : totpUserFailureMessage(error))),
    ...financialGate(),
  };
};

/**
 * Every check of a TOTP code (enroll confirm and step-up) draws on one bucket, 5 per 300s per
 * user. Separate buckets gave about 10 guesses per 5 minutes, and enroll confirm checks a code
 * without consuming it (audit finding 7). Starting an enrollment is not a code check and keeps
 * its own bucket.
 */
export const TOTP_CODE_CHECK_RATE_ACTION = 'code_check';

const consumeRate = async (client, userId, action) => {
  const result = await client.query(
    'SELECT allowed, count, retry_after_seconds FROM public.consume_financial_totp_rate_limit($1::uuid, $2, $3::int, $4::int)',
    [userId, action, 5, 300],
  );
  const row = result.rows[0];
  if (!row) {
    const error = new Error('rate_limit_unavailable');
    error.statusCode = 503;
    throw error;
  }
  if (row.allowed !== true) {
    return {
      ok: false,
      statusCode: 429,
      error: 'rate_limited',
      retryAfterSec: Number(row.retry_after_seconds || 1),
      ...financialGate(),
    };
  }
  return { ok: true };
};

/**
 * Commit what this request has done so far (the rate-limit hit; in verifyAgainstStore the SQL 132
 * code-check count) and continue in a new transaction with the same identity. A wrong code makes
 * the request fail and roll back, which would otherwise undo the counts and allow unlimited guessing.
 */
const commitAndContinue = async (client, mapping, claims) => {
  await commitWriteTransaction(client);
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, mapping.email || claims?.email || '']);
};

const statusRow = async (client, userId) => {
  const result = await client.query(
    'SELECT enrolled_at, verified_at FROM public.financial_totp_status($1::uuid)',
    [userId],
  );
  return result.rows[0] || null;
};

/**
 * First-time enrollment needs a fresh email code (security audit 2026-10-29 finding 8; owner
 * 2026-10-31: "First-time financial authenticator enrollment: whether it should require a fresh
 * email code. - yes"). Login is email OTP, so without this whoever holds a session of a member who
 * never enrolled could enroll their own authenticator and pass every financial step-up.
 *
 * - /auth/mfa/associate without an email code, for a user with no verified enrollment (never
 *   enrolled, a pending setup, or reset by a teammate through SQL 133), issues no secret: it emails a
 *   6-digit code to the user's verified email (the identity mapping, else the Cognito id token; never
 *   the request body) and answers 428 email_code_required with a signed emailChallenge.
 * - /auth/mfa/associate with emailChallenge and emailCode checks the code (rate action
 *   'enroll_confirm', 5 per 300 s per user, committed before the compare), then issues the secret
 *   and a signed enrollmentTicket bound to the new pending row.
 * - /auth/mfa/verify of a pending enrollment needs that enrollmentTicket; a verified enrollment's
 *   verify is unchanged. On the first activation the user is emailed that an authenticator was added.
 *
 * No table stores the code: the challenge carries an HMAC of it (key derived from the financial TOTP
 * wrap key with HKDF, so no new secret), the user, the email, an expiry 10 minutes out and the state
 * of the user's enrollment row when it was sent. The code works once: the associate it unlocks
 * replaces that row, so the same challenge no longer matches. Guesses are bounded by the rate limit
 * and the expiry; sends by the existing 'enroll_start' limit (5 per 300 s per user).
 */
export const ENROLL_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const ENROLL_TICKET_TTL_MS = 30 * 60 * 1000;
export const ENROLL_EMAIL_CODE_RATE_ACTION = 'enroll_confirm';
const ENROLL_EMAIL_KEY_INFO = 'checksops financial-totp enroll-email v1';
const ENROLL_EMAIL_PURPOSE = 'enroll_email';
const ENROLL_TICKET_PURPOSE = 'enroll_ticket';

const b64url = (value) => Buffer.from(value).toString('base64url');
const enrollEmailKey = (wrapKey) => Buffer.from(hkdfSync('sha256', wrapKey, Buffer.alloc(0), ENROLL_EMAIL_KEY_INFO, 32));
const emailDigest = (email) => createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
const isoOf = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
/** The state a challenge is bound to: no row, or the pending row by its enrolled_at. */
const enrollmentState = (row) => (row?.enrolled_at ? `pending:${isoOf(row.enrolled_at)}` : 'none');

const signToken = (key, purpose, payload, code = '') => {
  const body = b64url(JSON.stringify({ ...payload, p: purpose }));
  const tag = createHmac('sha256', key).update(`${purpose}|${body}|${code}`).digest();
  return `v1.${body}.${b64url(tag)}`;
};

/** Returns the payload when the token is well formed, of this purpose and its tag matches; else null. */
const openToken = (key, purpose, token, code = '') => {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || parts[1].length > 2048) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || payload.p !== purpose) return null;
  const expected = createHmac('sha256', key).update(`${purpose}|${parts[1]}|${code}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return payload;
};

const enrollmentEmailOf = (mapping, claims) => {
  const email = String(mapping?.email || claims?.email || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
};

const maskEmail = (email) => {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
};

const deliveryOf = (sent) => {
  const primary = sent?.results?.[0] || {};
  if (primary.status === 'failed' || !sent?.results?.length) return 'failed';
  return primary.delivery === 'ses' && primary.status === 'sent' ? 'sent' : 'sunk';
};

export const buildEnrollEmailCodeEmail = ({ code }) => {
  const paragraphs = [
    'Someone signed in to your ChecksOps account is setting up an authenticator app for financial confirmations.',
    `Your setup code is ${code}. It expires in 10 minutes and works once.`,
    'If you did not start this, do not share the code. Sign out of ChecksOps and contact support@checksops.com.',
  ];
  const layout = renderChecksOpsEmail({
    title: 'Your authenticator setup code',
    preview: `Your ChecksOps authenticator setup code is ${code}`,
    paragraphs,
    logoUrl: platformBranding().logoUrl || null,
  });
  return {
    subject: 'Your ChecksOps authenticator setup code',
    html: layout.html,
    text: ['Your authenticator setup code', ...paragraphs].join('\n'),
  };
};

export const buildAuthenticatorEnrolledEmail = ({ enrolledAt }) => {
  const when = (enrolledAt ? new Date(enrolledAt) : new Date()).toISOString().replace('T', ' ').slice(0, 16);
  const paragraphs = [
    `An authenticator app was added to your ChecksOps account on ${when} UTC. It now confirms financial actions such as deposits and wallet funding.`,
    'If this was you, there is nothing else to do.',
    'If this was not you, contact support@checksops.com right away and ask an administrator to reset two-factor authentication.',
  ];
  const layout = renderChecksOpsEmail({
    title: 'An authenticator was added to your account',
    preview: 'An authenticator app was added to your ChecksOps account',
    paragraphs,
    logoUrl: platformBranding().logoUrl || null,
  });
  return {
    subject: 'An authenticator was added to your ChecksOps account',
    html: layout.html,
    text: ['An authenticator was added to your account', ...paragraphs].join('\n'),
  };
};

const mailTo = async (deps, email, message, category) => {
  const platform = platformBranding();
  const mailer = deps.sendViaSesOrSink || sendViaSesOrSink;
  return mailer({
    to: email,
    subject: message.subject,
    html: message.html,
    text: message.text,
    from: platform.from,
    replyTo: platform.replyTo,
    messageCategory: category,
  });
};

const enrollRefusal = (statusCode, error, message, spoof) => ({
  ok: false,
  statusCode,
  error,
  message,
  emailCodeRequired: true,
  spoofFieldsIgnored: spoof,
  ...financialGate(),
});

/** Emails a fresh code and answers 428 with the challenge. The send counts against 'enroll_start'. */
const startEnrollEmailCode = async ({ client, mapping, claims, spoof, wrap, existing, email, deps }) => {
  // Keep the send's rate-limit hit: the 428 answer rolls the request back.
  await commitAndContinue(client, mapping, claims);
  const nowMs = Date.now();
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const expiresMs = nowMs + ENROLL_EMAIL_CODE_TTL_MS;
  const challenge = signToken(enrollEmailKey(wrap.key), ENROLL_EMAIL_PURPOSE, {
    u: mapping.application_user_id,
    e: emailDigest(email),
    s: enrollmentState(existing),
    x: expiresMs,
    n: b64url(randomBytes(12)),
  }, code);
  let delivery;
  try {
    delivery = deliveryOf(await mailTo(deps, email, buildEnrollEmailCodeEmail({ code }), 'financial_totp_enroll_code'));
  } catch {
    delivery = 'failed';
  }
  // Production never answers without a delivered email; nothing about the code leaves the server.
  if (delivery === 'failed' || (delivery !== 'sent' && isProductionEmailEnv())) {
    console.error(JSON.stringify({ service: 'checksops-api', event: 'financial_totp_enroll_code_email_failed', delivery }));
    return enrollRefusal(503, 'email_code_send_failed', 'We could not email your setup code. Try again in a few minutes.', spoof);
  }
  return {
    ...enrollRefusal(428, 'email_code_required', `Enter the 6-digit code we emailed to ${maskEmail(email)} to set up your authenticator.`, spoof),
    emailChallenge: challenge,
    emailHint: maskEmail(email),
    expiresAt: new Date(expiresMs).toISOString(),
    // As homeowner-otp.mjs: a staging sink delivers nothing, so staging shows the code. Never in production.
    stagingDebugCode: !isProductionEmailEnv() && emailMode() === 'sink' && delivery === 'sunk' ? code : undefined,
  };
};

/** Checks the emailed code against its challenge. Returns { ok: true } or the refusal. */
const checkEnrollEmailCode = async ({ client, mapping, claims, spoof, wrap, existing, email, challenge, code }) => {
  // The check (rate action 'enroll_confirm', consumed by the caller) is committed before the code is
  // compared: a wrong code rolls the request back.
  await commitAndContinue(client, mapping, claims);
  const wrong = () => enrollRefusal(401, 'email_code_invalid', 'That email code is not correct. Check the latest email or request a new code.', spoof);
  const normalized = String(code ?? '').trim();
  if (!/^\d{6}$/.test(normalized)) return wrong();
  const payload = openToken(enrollEmailKey(wrap.key), ENROLL_EMAIL_PURPOSE, challenge, normalized);
  if (!payload || payload.u !== mapping.application_user_id || payload.e !== emailDigest(email)) return wrong();
  if (!Number.isFinite(payload.x) || payload.x <= Date.now()) {
    return enrollRefusal(410, 'email_code_expired', 'That email code has expired. Request a new code.', spoof);
  }
  if (payload.s !== enrollmentState(existing)) {
    return enrollRefusal(409, 'email_code_used', 'That email code was already used. Request a new code.', spoof);
  }
  return { ok: true };
};

const enrollmentTicketFor = (wrap, userId, row) => {
  const expiresMs = Date.now() + ENROLL_TICKET_TTL_MS;
  return {
    ticket: signToken(enrollEmailKey(wrap.key), ENROLL_TICKET_PURPOSE, { u: userId, s: enrollmentState(row), x: expiresMs }),
    expiresAt: new Date(expiresMs).toISOString(),
  };
};

const enrollmentTicketValid = (wrap, userId, row, ticket) => {
  const payload = openToken(enrollEmailKey(wrap.key), ENROLL_TICKET_PURPOSE, ticket);
  return Boolean(payload && payload.u === userId && payload.s === enrollmentState(row)
    && Number.isFinite(payload.x) && payload.x > Date.now());
};

/** Tells the user an authenticator was added. Never throws; a failure is logged, not returned as an error. */
const notifyAuthenticatorEnrolled = async ({ mapping, claims, deps }) => {
  const email = enrollmentEmailOf(mapping, claims);
  if (!email) return { sent: false, status: 'no_recipient' };
  try {
    const status = deliveryOf(await mailTo(deps, email, buildAuthenticatorEnrolledEmail({ enrolledAt: new Date() }), 'financial_totp_enrolled'));
    if (status === 'failed') {
      console.error(JSON.stringify({ service: 'checksops-api', event: 'financial_totp_enrolled_email_failed' }));
    }
    return { sent: status !== 'failed', status };
  } catch (error) {
    console.error(JSON.stringify({
      service: 'checksops-api',
      event: 'financial_totp_enrolled_email_failed',
      error: String(error?.message || error).slice(0, 240),
    }));
    return { sent: false, status: 'failed' };
  }
};

const loadEnrollment = async (client, userId) => {
  const result = await client.query(
    `SELECT ciphertext, nonce, key_id, last_used_timestep, verified_at, failed_attempts, locked_until
     FROM public.financial_totp_get_enrollment($1::uuid)`,
    [userId],
  );
  return result.rows[0] || null;
};

/**
 * SQL 132 (aws/workflows/sql/132_financial_totp_code_check_lockout.sql): counts one code check
 * against the enrollment before the code is compared. Ten consecutive checks without a success lock
 * the enrollment for 15 minutes; while locked the database answers allowed false and the code is
 * never compared. financial_totp_mark_verified clears the count and the lock on a correct code.
 *
 * Before SQL 132 is applied in an environment the function does not exist. The check is then not
 * counted and nothing is locked (the behavior before this change; the rate limit still applies),
 * and the request is not a 500: the existence check is a catalog read, so a missing function never
 * aborts the transaction.
 */
export const TOTP_CODE_CHECK_LOCKOUT_FUNCTION = 'public.financial_totp_count_code_check(uuid)';
export const TOTP_CODE_CHECK_LOCKOUT_PRESENT_SQL = 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present';
export const TOTP_CODE_CHECK_LOCKOUT_SQL = 'SELECT allowed, failed_attempts, retry_after_seconds FROM public.financial_totp_count_code_check($1::uuid)';

export const countCodeCheck = async (client, userId) => {
  const present = (await client.query(TOTP_CODE_CHECK_LOCKOUT_PRESENT_SQL, [TOTP_CODE_CHECK_LOCKOUT_FUNCTION])).rows[0]?.present === true;
  if (!present) return { present: false, counted: false, locked: false };
  const row = (await client.query(TOTP_CODE_CHECK_LOCKOUT_SQL, [userId])).rows[0];
  if (!row) return { present: true, counted: false, locked: false, enrolled: false };
  if (row.allowed !== true) {
    return { present: true, counted: false, locked: true, retryAfterSec: Math.max(1, Number(row.retry_after_seconds) || 1) };
  }
  return { present: true, counted: true, locked: false, failedAttempts: Number(row.failed_attempts) };
};

/**
 * The answer to a wrong code. Also the answer while the enrollment is locked (SQL 132), so a locked
 * check reveals nothing about the code.
 */
const codeRejected = () => ({
  ok: false,
  statusCode: 401,
  error: 'mfa_step_up_failed',
  verified: false,
  message: totpUserFailureMessage({ name: 'CodeMismatchException' }),
  ...financialGate(),
});

const listPasskeys = async (accessToken) => {
  if (!accessToken) return 0;
  try {
    const response = await fetch('https://cognito-idp.us-east-1.amazonaws.com/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSCognitoIdentityProviderService.ListWebAuthnCredentials',
      },
      body: JSON.stringify({ AccessToken: accessToken }),
    });
    const body = JSON.parse(await response.text() || '{}');
    return Array.isArray(body.Credentials) ? body.Credentials.length : 0;
  } catch {
    return 0;
  }
};

export const handleMfaStatus = async (event, deps = {}) => {
  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async ({ client, mapping }) => {
    try {
      const row = await statusRow(client, mapping.application_user_id);
      // Cognito MFA list is injected as enabled to prove enrollment ignores it.
      const enrollment = evaluateFinancialTotpEnrollment({
        verifiedAt: row?.verified_at || null,
        userMfaSettingList: ['SOFTWARE_TOKEN_MFA'],
        preferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
      });
      const body = parseBody(event);
      const accessToken = String(body.accessToken || body.access_token || '').trim();
      const passkeyCount = await (deps.listPasskeys || listPasskeys)(accessToken);
      const publicStatus = enrollmentResponseWithoutSecret({
        verifiedAt: row?.verified_at,
        enrolledAt: row?.enrolled_at,
      });
      return {
        ok: true,
        statusCode: 200,
        totpEnrolled: enrollment.totpEnrolled,
        passkeyCount,
        preferredMfa: null,
        factors: enrollment.totpEnrolled ? [{ id: 'financial-totp', factorType: 'totp', status: 'verified' }] : [],
        privilegedAuth: privilegedAuthPolicy(),
        enrollment: evaluatePrivilegedEnrollment({
          totpEnrolled: enrollment.totpEnrolled,
          passkeyCount,
        }),
        source: 'financial_totp_enrollments',
        ...publicStatus,
        ...financialGate(),
      };
    } catch (error) {
      return wrapFail(error);
    }
  }, deps);
};

export const handleMfaAssociate = async (event, deps = {}) => {
  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async ({ client, mapping, claims, body, spoof }) => {
    try {
      // Finding 8: a request without an email code sends one (rate action 'enroll_start'); a request
      // with one checks it (rate action 'enroll_confirm').
      const challenge = body.emailChallenge ?? body.email_challenge;
      const emailCode = body.emailCode ?? body.email_code;
      const withEmailCode = Boolean(challenge) || (emailCode !== undefined && emailCode !== null && emailCode !== '');
      const rate = await consumeRate(client, mapping.application_user_id, withEmailCode ? ENROLL_EMAIL_CODE_RATE_ACTION : 'enroll_start');
      if (!rate.ok) return withEmailCode ? { ...rate, emailCodeRequired: true } : rate;
      const existing = await statusRow(client, mapping.application_user_id);
      if (existing?.verified_at) {
        return {
          ok: false,
          statusCode: 409,
          error: 'enrollment_reset_required',
          message: 'Verified financial TOTP cannot be overwritten. An explicit reset is required.',
          spoofFieldsIgnored: spoof,
          ...financialGate(),
        };
      }
      const wrap = await (deps.loadWrapKey || loadFinancialTotpWrapKey)();
      // Finding 8: no secret is issued until a fresh code sent to the user's verified email is entered.
      const email = enrollmentEmailOf(mapping, claims);
      if (!email) {
        return enrollRefusal(409, 'verified_email_required', 'Your account has no verified email address for the setup code. Contact support@checksops.com.', spoof);
      }
      const gateCtx = { client, mapping, claims, spoof, wrap, existing, email, deps };
      if (!withEmailCode) return startEnrollEmailCode(gateCtx);
      const emailGate = await checkEnrollEmailCode({ ...gateCtx, challenge, code: emailCode });
      if (!emailGate.ok) return emailGate;
      const secret = generateTotpSecret();
      const wrapped = encryptSecret(secret, wrap.key, wrap.keyId);
      await client.query(
        'SELECT public.financial_totp_upsert_enrollment($1::uuid, $2::bytea, $3::bytea, $4)',
        [mapping.application_user_id, wrapped.ciphertext, wrapped.nonce, wrapped.keyId],
      );
      const pending = await statusRow(client, mapping.application_user_id);
      const ticket = enrollmentTicketFor(wrap, mapping.application_user_id, pending);
      return {
        ok: true,
        statusCode: 200,
        id: 'financial-totp',
        totp: {
          secret,
          qr_code: null,
          otpauth_uri: otpauthUri(secret, email),
        },
        enrollmentTicket: ticket.ticket,
        enrollmentTicketExpiresAt: ticket.expiresAt,
        preferredMfaEnabled: false,
        spoofFieldsIgnored: spoof,
        ...financialGate(),
      };
    } catch (error) {
      if (String(error?.message || '') === 'verified_enrollment_exists') {
        return {
          ok: false,
          statusCode: 409,
          error: 'enrollment_reset_required',
          message: 'Verified financial TOTP cannot be overwritten. An explicit reset is required.',
          spoofFieldsIgnored: spoof,
          ...financialGate(),
        };
      }
      return wrapFail(error);
    }
  }, deps);
};

const verifyAgainstStore = async ({ client, mapping, claims, code, wrap, nowMs, consumeTimestep = true }) => {
  const notEnrolled = () => ({ ok: false, statusCode: 403, error: 'totp_not_enrolled', ...financialGate() });
  const row = await loadEnrollment(client, mapping.application_user_id);
  if (!row?.ciphertext) return notEnrolled();
  // SQL 132: count this check and keep the count before the code is compared (a wrong code rolls
  // the request back). While locked, refuse without comparing: the same answer as a wrong code.
  const gate = await countCodeCheck(client, mapping.application_user_id);
  if (gate.present && gate.enrolled === false) return notEnrolled();
  if (gate.counted) await commitAndContinue(client, mapping, claims);
  if (gate.locked || (row.locked_until && new Date(row.locked_until).getTime() > Date.now())) return codeRejected();
  const secret = decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce, key: wrap.key });
  const verified = verifyFinancialTotp({
    secret,
    code,
    nowMs,
    lastUsedTimestep: row.last_used_timestep,
  });
  if (!verified.ok) {
    return verified.error === 'totp_mismatch' ? codeRejected() : { ...codeRejected(), error: verified.error };
  }
  const marked = await client.query(
    'SELECT public.financial_totp_mark_verified($1::uuid, $2::bigint) AS claimed',
    [mapping.application_user_id, consumeTimestep ? verified.timestep : null],
  );
  if (consumeTimestep && marked.rows[0]?.claimed !== true) return codeRejected();
  return { ok: true, timestep: verified.timestep };
};

export const handleMfaVerify = async (event, deps = {}) => {
  const body = parseBody(event);
  const normalized = normalizeTotpCode(body.code ?? body.userCode);
  if (!normalized.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: normalized.error,
      message: totpUserFailureMessage({ message: normalized.error }),
      ...financialGate(),
    };
  }
  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async (ctx) => {
    try {
      const rate = await consumeRate(ctx.client, ctx.mapping.application_user_id, TOTP_CODE_CHECK_RATE_ACTION);
      if (!rate.ok) return rate;
      await commitAndContinue(ctx.client, ctx.mapping, ctx.claims);
      const wrap = await (deps.loadWrapKey || loadFinancialTotpWrapKey)();
      // Finding 8: a pending enrollment is activated only with the ticket the email-code associate
      // issued for that row (a row set up without the email code, before this change, cannot be).
      // A verified enrollment's verify is unchanged.
      const status = await statusRow(ctx.client, ctx.mapping.application_user_id);
      const firstActivation = Boolean(status?.enrolled_at && !status.verified_at);
      if (firstActivation) {
        const ticket = body.enrollmentTicket ?? body.enrollment_ticket;
        if (!enrollmentTicketValid(wrap, ctx.mapping.application_user_id, status, ticket)) {
          return enrollRefusal(403, 'enrollment_email_code_required', 'Restart authenticator setup: a new code will be emailed to you.', ctx.spoof);
        }
      }
      const verified = await verifyAgainstStore({
        client: ctx.client,
        mapping: ctx.mapping,
        claims: ctx.claims,
        code: normalized.code,
        wrap,
        nowMs: deps.nowMs,
        consumeTimestep: false,
      });
      if (!verified.ok) return verified;
      let enrollmentNotice;
      if (firstActivation) {
        // The activation is committed before the user is told about it; the email never undoes it.
        await commitAndContinue(ctx.client, ctx.mapping, ctx.claims);
        enrollmentNotice = await notifyAuthenticatorEnrolled({ mapping: ctx.mapping, claims: ctx.claims, deps });
      }
      return {
        ok: true,
        statusCode: 200,
        verified: true,
        enrollment: true,
        recorded: false,
        enrollmentNotice,
        preferredMfaEnabled: false,
        preferredMfa: null,
        source: 'financial_totp_enrollments',
        remaining: 'Financial TOTP is enrolled without Cognito login MFA. EMAIL_OTP login is unchanged.',
        spoofFieldsIgnored: ctx.spoof,
        ...financialGate(),
      };
    } catch (error) {
      return wrapFail(error);
    }
  }, deps);
};

/**
 * The login a financial step-up is recorded against (moov-fund-authz.mjs
 * loginSessionBinding: sub + origin_jti, or auth_time). Shared by wallet
 * funding and Check Alt: both ask for two-factor once per login.
 */
const resolveLoginSessionBinding = async ({ claims, spoof }) => {
  const { loginSessionBinding } = await import('./providers/production/moov-fund-authz.mjs');
  const loginSession = loginSessionBinding(claims);
  if (!loginSession) {
    return {
      ok: false,
      statusCode: 401,
      error: 'login_session_unbound',
      message: 'Sign out and sign back in, then try again.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  return { ok: true, loginSession };
};

/**
 * Wallet funding step-up is bound to the tenant and the current login, not to
 * an amount: one code per login covers every funding request in that login.
 * A teammate 2FA reset (team.reset_totp) uses the same tenant + login binding;
 * admin-reset-totp also requires it to be recent.
 */
const resolveWalletFundStepUpBinding = async ({ client, mapping, claims, body, spoof }, boundActionKey = null) => {
  const { TENANT_MEMBERSHIP_SQL } = await import('./identity.mjs');
  const { isUuid, membershipForTenant } = await import('./financial-ownership.mjs');
  const { WALLET_FUND_TOTP_ACTION } = await import('./providers/production/moov-fund-authz.mjs');
  const tenantId = String(body.tenant_id || body.tenantId || '').trim();
  if (!isUuid(tenantId)) {
    return { ok: false, statusCode: 400, error: 'tenant_id is required', spoofFieldsIgnored: spoof, ...financialGate() };
  }
  const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  if (!membershipForTenant(memberships, tenantId)) {
    return { ok: false, statusCode: 403, error: 'cross_tenant_denied', spoofFieldsIgnored: spoof, ...financialGate() };
  }
  const session = await resolveLoginSessionBinding({ claims, spoof });
  if (!session.ok) return session;
  return { ok: true, kind: 'login_session', tenantId, loginSession: session.loginSession, actionKey: boundActionKey || WALLET_FUND_TOTP_ACTION };
};

export const resolveFinancialStepUpBinding = async ({ client, mapping, claims, body, spoof }) => {
  const { TENANT_MEMBERSHIP_SQL } = await import('./identity.mjs');
  const { membershipForTenant } = await import('./financial-ownership.mjs');
  const {
    CHECKALT_TOTP_ACTION,
    FINANCIAL_CHECKALT_STEPUP_ACTIONS,
    serverAmountCentsFromCheck,
  } = await import('./providers/production/checkalt-authz.mjs');
  const actionKey = String(body.action_key || body.actionKey || CHECKALT_TOTP_ACTION);
  const { WALLET_FUND_TOTP_ACTION } = await import('./providers/production/moov-fund-authz.mjs');
  if (actionKey === WALLET_FUND_TOTP_ACTION) {
    return resolveWalletFundStepUpBinding({ client, mapping, claims, body, spoof });
  }
  const { TEAM_RESET_TOTP_ACTION } = await import('./admin-reset-totp.mjs');
  if (actionKey === TEAM_RESET_TOTP_ACTION) {
    return resolveWalletFundStepUpBinding({ client, mapping, claims, body, spoof }, TEAM_RESET_TOTP_ACTION);
  }
  // If an older checkalt-authz.mjs is live (deploy order or rollback), keep
  // deposit.submit working rather than failing every check-bound step-up.
  const checkAltStepUpActions = Array.isArray(FINANCIAL_CHECKALT_STEPUP_ACTIONS)
    ? FINANCIAL_CHECKALT_STEPUP_ACTIONS
    : [CHECKALT_TOTP_ACTION];
  if (!checkAltStepUpActions.includes(actionKey)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'action_mismatch',
      message: 'Financial TOTP step-up action is server-controlled.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  const checkId = body.check_intake_item_id || body.check_id || null;
  if (!checkId) {
    return {
      ok: false,
      statusCode: 400,
      error: 'check_intake_item_id is required',
      message: 'Financial TOTP must be bound to a server-side check. Browser tenant_id is ignored.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  const check = (await client.query(
    'SELECT id, tenant_id, amount, status FROM public.check_intake_items WHERE id = $1::uuid',
    [checkId],
  )).rows[0];
  if (!check) {
    return { ok: false, statusCode: 404, error: 'Check not found', spoofFieldsIgnored: spoof, ...financialGate() };
  }
  const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  if (!membershipForTenant(memberships, check.tenant_id)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'cross_tenant_denied',
      message: 'TOTP step-up tenant is taken from the check. Browser tenant_id is ignored.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  const amountCents = serverAmountCentsFromCheck(check);
  if (!Number.isInteger(amountCents)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'invalid_amount',
      message: 'Server-derived check amount is required. Browser amount is ignored.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  if (body.amount_cents !== undefined && body.amount_cents !== null && Number(body.amount_cents) !== amountCents) {
    return {
      ok: false,
      statusCode: 409,
      error: 'amount_mismatch',
      message: 'Browser amount is ignored. Server-derived amount does not match the provided amount.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  // Check Alt two-factor is once per login, like wallet funding: the step-up
  // is recorded against this login and the check's tenant. The check and its
  // server-side amount are kept in the log only as an audit trail.
  const session = await resolveLoginSessionBinding({ claims, spoof });
  if (!session.ok) return session;
  return { ok: true, check, amountCents, actionKey, loginSession: session.loginSession };
};

/**
 * Marks this transaction as the server's step-up writer (SQL 97): a
 * financial_stepup_log row with source app_financial_totp is refused unless
 * this transaction-local setting is present. Set right before each insert.
 */
export const STEPUP_WRITER_SQL = "SELECT set_config('app.stepup_writer', '1', true)";

/** Clears the writer flag right after the server's step-up insert. */
export const STEPUP_WRITER_RESET_SQL = "SELECT set_config('app.stepup_writer', '0', true)";

export const insertAppStepUpLog = async (client, mapping, bound) => {
  await client.query(STEPUP_WRITER_SQL);
  try {
    return await insertAppStepUpLogRow(client, mapping, bound);
  } finally {
    await client.query(STEPUP_WRITER_RESET_SQL).catch(() => {});
  }
};

const insertAppStepUpLogRow = async (client, mapping, bound) => {
  if (bound.kind === 'login_session') {
    const row = (await client.query(
      `INSERT INTO public.financial_stepup_log
        (user_id, tenant_id, action_key, factor_type, succeeded, metadata)
       VALUES ($1::uuid, $2::uuid, $3, 'totp', true, $4::jsonb)
       RETURNING id, created_at`,
      [
        mapping.application_user_id,
        bound.tenantId,
        bound.actionKey,
        JSON.stringify({
          login_session: bound.loginSession,
          operation: bound.actionKey,
          source: 'app_financial_totp',
        }),
      ],
    )).rows[0];
    return {
      ok: true,
      statusCode: 200,
      recorded: true,
      stepup_id: row.id,
      check_id: null,
      tenant_id: bound.tenantId,
      amount_cents: null,
      applicationUserId: mapping.application_user_id,
    };
  }
  const row = (await client.query(
    `INSERT INTO public.financial_stepup_log
      (user_id, tenant_id, action_key, factor_type, succeeded, metadata)
     VALUES ($1::uuid, $2::uuid, $3, 'totp', true, $4::jsonb)
     RETURNING id, created_at`,
    [
      mapping.application_user_id,
      bound.check.tenant_id,
      bound.actionKey,
      JSON.stringify({
        check_id: bound.check.id,
        amount_cents: bound.amountCents,
        login_session: bound.loginSession,
        operation: bound.actionKey,
        source: 'app_financial_totp',
      }),
    ],
  )).rows[0];
  return {
    ok: true,
    statusCode: 200,
    recorded: true,
    stepup_id: row.id,
    check_id: bound.check.id,
    tenant_id: bound.check.tenant_id,
    amount_cents: bound.amountCents,
    applicationUserId: mapping.application_user_id,
  };
};

export const handleMfaStepUp = async (event, deps = {}) => {
  const body = parseBody(event);
  const normalized = normalizeTotpCode(body.code ?? body.userCode);
  if (!normalized.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: normalized.error,
      message: totpUserFailureMessage({ message: normalized.error }),
      ...financialGate(),
    };
  }
  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async (ctx) => {
    try {
      const rate = await consumeRate(ctx.client, ctx.mapping.application_user_id, TOTP_CODE_CHECK_RATE_ACTION);
      if (!rate.ok) return rate;
      await commitAndContinue(ctx.client, ctx.mapping, ctx.claims);
      const bound = await resolveFinancialStepUpBinding({
        client: ctx.client,
        mapping: ctx.mapping,
        claims: ctx.claims,
        body,
        spoof: ctx.spoof,
      });
      if (!bound.ok) return bound;
      const wrap = await (deps.loadWrapKey || loadFinancialTotpWrapKey)();
      const verified = await verifyAgainstStore({
        client: ctx.client,
        mapping: ctx.mapping,
        claims: ctx.claims,
        code: normalized.code,
        wrap,
        nowMs: deps.nowMs,
        consumeTimestep: true,
      });
      if (!verified.ok) return verified;
      const recorded = await insertAppStepUpLog(ctx.client, ctx.mapping, bound);
      if (!recorded?.ok) {
        return {
          ok: false,
          statusCode: recorded?.statusCode || 401,
          error: recorded?.error || 'stepup_log_failed',
          verified: true,
          recorded: false,
          message: recorded?.message || 'TOTP was valid but the server-side step-up log was not recorded.',
          spoofFieldsIgnored: ctx.spoof,
          ...financialGate(),
        };
      }
      return {
        ok: true,
        statusCode: 200,
        verified: true,
        recorded: true,
        stepup_id: recorded.stepup_id,
        factorType: 'totp',
        source: 'app_financial_totp',
        check_id: recorded.check_id,
        tenant_id: recorded.tenant_id,
        amount_cents: recorded.amount_cents,
        spoofFieldsIgnored: ctx.spoof,
        ...financialGate(),
      };
    } catch (error) {
      return wrapFail(error);
    }
  }, deps);
};

export const handleMfaSetPreference = async () => ({
  ok: false,
  statusCode: 403,
  error: 'cognito_preferred_mfa_disabled',
  message: 'Refusing Cognito login MFA preference changes. Financial TOTP is application-level only.',
  ...financialGate(),
});
