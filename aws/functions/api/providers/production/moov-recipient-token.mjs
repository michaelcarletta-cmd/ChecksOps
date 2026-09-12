import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const RECIPIENT_INVITE_BYTES = 32;
export const RECIPIENT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const RECIPIENT_TOKEN_MAX_FAILURES = 10;
export const RECIPIENT_TOKEN_WINDOW_MS = 15 * 60 * 1000;

export const hashRecipientInviteToken = (token) => (
  createHash('sha256').update(String(token || ''), 'utf8').digest('hex')
);

export const mintRecipientInviteToken = ({ nowMs = Date.now(), ttlMs = RECIPIENT_INVITE_TTL_MS } = {}) => {
  const plaintext = randomBytes(RECIPIENT_INVITE_BYTES).toString('hex');
  return {
    plaintext,
    token_hash: `sha256:${hashRecipientInviteToken(plaintext)}`,
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    entropy_bits: RECIPIENT_INVITE_BYTES * 8,
  };
};

export const tokensMatch = (presented, storedPlainOrHash) => {
  const presentedHash = hashRecipientInviteToken(presented);
  const stored = String(storedPlainOrHash || '');
  const storedHash = stored.startsWith('sha256:')
    ? stored.slice('sha256:'.length).toLowerCase()
    : hashRecipientInviteToken(stored);
  try {
    const a = Buffer.from(presentedHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== 32 || b.length !== 32) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

export const classifyRecipientInvite = ({
  recipient,
  presentedToken,
  nowMs = Date.now(),
} = {}) => {
  if (!recipient) {
    return { ok: false, statusCode: 404, error: 'invite_not_found', message: 'This link is not valid.' };
  }
  if (recipient.disconnected_at || String(recipient.onboarding_status || '') === 'disconnected') {
    return { ok: false, statusCode: 410, error: 'invite_revoked', message: 'This link has been revoked.' };
  }
  if (recipient.token_revoked_at) {
    return { ok: false, statusCode: 410, error: 'invite_revoked', message: 'This link has been revoked.' };
  }
  const expiresAt = recipient.token_expires_at ? Date.parse(recipient.token_expires_at) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt < nowMs) {
    return { ok: false, statusCode: 410, error: 'invite_expired', message: 'This link has expired. Ask the sender for a new one.' };
  }
  const stored = recipient.invite_token_hash || recipient.secure_token;
  if (!tokensMatch(presentedToken, stored)) {
    return { ok: false, statusCode: 404, error: 'invite_not_found', message: 'This link is not valid.' };
  }
  return {
    ok: true,
    recipient_id: recipient.id,
    tenant_id: recipient.tenant_id,
    provider_account_id: recipient.provider_account_id || null,
  };
};

const failureBuckets = new Map();

export const resetRecipientTokenRateLimit = () => failureBuckets.clear();

export const noteRecipientTokenFailure = ({ ip, nowMs = Date.now() } = {}) => {
  const key = String(ip || 'unknown');
  const bucket = (failureBuckets.get(key) || []).filter((ts) => nowMs - ts < RECIPIENT_TOKEN_WINDOW_MS);
  bucket.push(nowMs);
  failureBuckets.set(key, bucket);
  return bucket.length;
};

export const recipientTokenRateLimited = ({ ip, nowMs = Date.now() } = {}) => {
  const key = String(ip || 'unknown');
  const bucket = (failureBuckets.get(key) || []).filter((ts) => nowMs - ts < RECIPIENT_TOKEN_WINDOW_MS);
  failureBuckets.set(key, bucket);
  return bucket.length >= RECIPIENT_TOKEN_MAX_FAILURES;
};
