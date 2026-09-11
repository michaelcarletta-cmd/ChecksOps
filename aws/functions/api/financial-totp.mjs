/**
 * Application-level financial TOTP (not Cognito login MFA).
 *
 * Login stays EMAIL_OTP / WEB_AUTHN. This module does not call Cognito MFA
 * APIs. Enrollment is stored encrypted at rest; verification is server-side only.
 *
 * Do not log secrets or TOTP codes. Do not put ciphertext on the generic data API.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const FINANCIAL_TOTP_ISSUER = 'ChecksOps Financial';
export const FINANCIAL_TOTP_DIGITS = 6;
export const FINANCIAL_TOTP_PERIOD_SECONDS = 30;
export const FINANCIAL_TOTP_WINDOW = 1;
export const FINANCIAL_TOTP_ALGORITHM = 'SHA1';
export const FINANCIAL_TOTP_WRAP_ALG = 'aes-256-gcm';
export const FINANCIAL_STEPUP_TTL_MS = 30 * 60 * 1000;
export const FINANCIAL_TOTP_VERIFY_LIMIT = 5;
export const FINANCIAL_TOTP_VERIFY_WINDOW_MS = 5 * 60 * 1000;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_RE = /^[A-Z2-7]{32}$/;

const toBase32 = (bytes) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
};

export const decodeBase32 = (secret) => {
  const normalized = String(secret || '').toUpperCase().replace(/=+$/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of normalized) {
    const idx = BASE32.indexOf(char);
    if (idx < 0) throw new Error('invalid_totp_secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

export const generateTotpSecret = () => toBase32(randomBytes(20));

export const otpauthUri = (secret, email) => {
  const label = encodeURIComponent(email || 'ChecksOps');
  const issuer = encodeURIComponent(FINANCIAL_TOTP_ISSUER);
  return `otpauth://totp/${issuer}:${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&digits=${FINANCIAL_TOTP_DIGITS}&period=${FINANCIAL_TOTP_PERIOD_SECONDS}`;
};

export const wrapKeyFromHex = (hex) => {
  const raw = String(hex || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('invalid_wrap_key');
  return Buffer.from(raw, 'hex');
};

export const encryptSecret = (secret, key, keyId = 'financial-totp-v1') => {
  if (!SECRET_RE.test(secret)) throw new Error('invalid_totp_secret');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_wrap_key');
  const nonce = randomBytes(12);
  const cipher = createCipheriv(FINANCIAL_TOTP_WRAP_ALG, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, nonce, keyId, alg: FINANCIAL_TOTP_WRAP_ALG };
};

export const decryptSecret = ({ ciphertext, nonce, key }) => {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_wrap_key');
  const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  const iv = Buffer.isBuffer(nonce) ? nonce : Buffer.from(nonce);
  const tag = buf.subarray(buf.length - 16);
  const body = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv(FINANCIAL_TOTP_WRAP_ALG, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(body, undefined, 'utf8') + decipher.final('utf8');
};

export const timestepOf = (nowMs = Date.now(), periodSeconds = FINANCIAL_TOTP_PERIOD_SECONDS) => (
  Math.floor(Number(nowMs) / 1000 / periodSeconds)
);

export const hotp = (secretBytes, counter, digits = FINANCIAL_TOTP_DIGITS) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secretBytes).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, '0');
};

export const totpAt = (secret, timestep, digits = FINANCIAL_TOTP_DIGITS) => (
  hotp(typeof secret === 'string' ? decodeBase32(secret) : secret, timestep, digits)
);

const codesEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const verifyFinancialTotp = ({
  secret,
  code,
  nowMs = Date.now(),
  lastUsedTimestep = null,
  window = FINANCIAL_TOTP_WINDOW,
} = {}) => {
  const trimmed = String(code || '');
  if (!new RegExp(`^\\d{${FINANCIAL_TOTP_DIGITS}}$`).test(trimmed)) {
    return { ok: false, error: 'totp_invalid_format' };
  }
  const center = timestepOf(nowMs);
  for (let delta = -window; delta <= window; delta += 1) {
    const step = center + delta;
    if (lastUsedTimestep !== null && Number(lastUsedTimestep) === step) continue;
    if (codesEqual(totpAt(secret, step), trimmed)) {
      return { ok: true, timestep: step };
    }
  }
  return { ok: false, error: 'totp_mismatch' };
};

/**
 * Financial enrollment is the app-level row, never Cognito UserMFASettingList.
 */
export const evaluateFinancialTotpEnrollment = ({
  verifiedAt = null,
  userMfaSettingList = [],
  preferredMfaSetting = null,
} = {}) => ({
  totpEnrolled: Boolean(verifiedAt),
  loginMfaIgnored: true,
  userMfaSettingList: Array.isArray(userMfaSettingList) ? userMfaSettingList : [],
  preferredMfaSetting: preferredMfaSetting || null,
  source: 'financial_totp_enrollments',
});

export const bindFinancialStepUp = ({
  applicationUserId,
  tenantId,
  action,
  resourceId,
  amountCents,
  ttlMs = FINANCIAL_STEPUP_TTL_MS,
} = {}) => {
  if (!applicationUserId || !tenantId || !action || !resourceId || !Number.isInteger(amountCents)) {
    return { ok: false, error: 'stepup_binding_incomplete' };
  }
  return {
    ok: true,
    application_user_id: applicationUserId,
    tenant_id: tenantId,
    action_key: action,
    factor_type: 'totp',
    succeeded: true,
    ttl_ms: ttlMs,
    metadata: {
      check_id: resourceId,
      amount_cents: amountCents,
      source: 'app_financial_totp',
    },
  };
};

export const consumeFinancialTotpRateLimit = (store, {
  userId,
  action,
  nowMs = Date.now(),
  limit = FINANCIAL_TOTP_VERIFY_LIMIT,
  windowMs = FINANCIAL_TOTP_VERIFY_WINDOW_MS,
} = {}) => {
  if (!userId || !action) return { allowed: false, error: 'rate_limit_identity' };
  const key = `${userId}:${action}`;
  const current = store.get(key);
  if (!current || nowMs - current.windowStartedAt >= windowMs) {
    store.set(key, { windowStartedAt: nowMs, count: 1 });
    return { allowed: true, count: 1, retryAfterSec: 0 };
  }
  const count = current.count + 1;
  store.set(key, { ...current, count });
  if (count > limit) {
    return {
      allowed: false,
      count,
      retryAfterSec: Math.max(1, Math.ceil((current.windowStartedAt + windowMs - nowMs) / 1000)),
      error: 'rate_limited',
    };
  }
  return { allowed: true, count, retryAfterSec: 0 };
};

export const enrollmentResponseWithoutSecret = (enrollment) => ({
  totpEnrolled: Boolean(enrollment?.verifiedAt || enrollment?.verified_at),
  enrolledAt: enrollment?.enrolled_at || enrollment?.enrolledAt || null,
  issuer: FINANCIAL_TOTP_ISSUER,
  digits: FINANCIAL_TOTP_DIGITS,
  periodSeconds: FINANCIAL_TOTP_PERIOD_SECONDS,
});

export const assertNoSecretLeak = (payload, secret) => {
  const blob = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (secret && blob.includes(secret)) throw new Error('totp_secret_logged');
};

export const FINANCIAL_TOTP_PREP = {
  cognitoLoginMfa: false,
  preferredMfa: false,
  secretExportableFromCognito: false,
  authorizationRecord: 'financial_stepup_log',
  enrollmentTable: 'financial_totp_enrollments',
};
