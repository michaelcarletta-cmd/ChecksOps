import { createHmac, timingSafeEqual } from 'node:crypto';

export const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const hmacHex = (secret, payload, hash = 'sha256') => (
  createHmac(hash, secret).update(payload).digest('hex')
);

export const hmacBase64 = (secret, payload, hash = 'sha256') => (
  createHmac(hash, secret).update(payload).digest('base64')
);

export const parseTimestampMs = (raw) => {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
};

export const header = (event, name) => {
  const headers = event?.headers || {};
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return null;
};

export const rawEventBody = (event) => {
  if (!event?.body) return '';
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf8');
  return String(event.body);
};

const signatureCandidates = (value) => String(value || '')
  .split(/[\s,]+/)
  .map((part) => part.trim())
  .filter((part) => part && part !== 'v1');

/**
 * Moov signs `timestamp|nonce|webhookID` with HMAC-SHA512 (hex) and sends it
 * in `X-Signature`. Legacy Svix-style body signature is still accepted.
 */
export const verifyMoovSignature = ({ event, rawBody, secret, nowMs = Date.now(), maxSkewMs = 5 * 60 * 1000 }) => {
  if (!secret) return { ok: false, reason: 'missing_webhook_secret', eventId: null };
  const webhookId = header(event, 'x-webhook-id')
    || header(event, 'webhook-id')
    || header(event, 'x-moov-webhook-id');
  const timestamp = header(event, 'x-timestamp')
    || header(event, 'webhook-timestamp')
    || header(event, 'x-moov-timestamp');
  const nonce = header(event, 'x-nonce');
  const signatureHeader = header(event, 'x-signature')
    || header(event, 'webhook-signature')
    || header(event, 'x-moov-signature');

  if (!webhookId || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing_signature_headers', eventId: webhookId || null };
  }

  const tsMs = parseTimestampMs(timestamp);
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > maxSkewMs) {
    return { ok: false, reason: 'timestamp_outside_window', eventId: webhookId };
  }

  const candidates = signatureCandidates(signatureHeader);
  if (nonce) {
    const expected = hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, 'sha512');
    if (candidates.some((candidate) => safeEqual(candidate.toLowerCase(), expected))) {
      return { ok: true, eventId: webhookId, algorithm: 'hmac-sha512-hex' };
    }
  }

  const legacy = hmacBase64(secret, `${webhookId}.${timestamp}.${rawBody}`, 'sha256');
  if (candidates.some((candidate) => safeEqual(candidate, legacy))) {
    return { ok: true, eventId: webhookId, algorithm: 'hmac-sha256-b64-legacy' };
  }
  return { ok: false, reason: 'invalid_signature', eventId: webhookId };
};

/** Staging fixture HMAC used for CheckAlt and Plaid until production cutover. */
export const verifyHmacBodySignature = ({ event, rawBody, secret, nowMs = Date.now(), maxSkewMs = 5 * 60 * 1000 }) => {
  if (!secret) return { ok: false, reason: 'missing_webhook_secret', eventId: null };
  const webhookId = header(event, 'x-webhook-id') || header(event, 'webhook-id');
  const timestamp = header(event, 'x-timestamp') || header(event, 'webhook-timestamp');
  const signatureHeader = header(event, 'x-signature') || header(event, 'webhook-signature');
  if (!webhookId || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing_signature_headers', eventId: webhookId || null };
  }
  const tsMs = parseTimestampMs(timestamp);
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > maxSkewMs) {
    return { ok: false, reason: 'timestamp_outside_window', eventId: webhookId };
  }
  const expected = hmacHex(secret, `${webhookId}.${timestamp}.${rawBody}`, 'sha256');
  const ok = signatureCandidates(signatureHeader).some((candidate) => (
    safeEqual(candidate.toLowerCase(), expected)
  ));
  return { ok, reason: ok ? null : 'invalid_signature', eventId: webhookId, algorithm: ok ? 'hmac-sha256-hex' : null };
};
