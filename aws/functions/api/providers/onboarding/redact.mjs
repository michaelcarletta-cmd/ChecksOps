/**
 * Redaction for onboarding data. SSN, EIN, date of birth, bank account and
 * routing numbers and document bytes never reach a log line, an error message,
 * provider_metadata or an outbox payload.
 */

const SENSITIVE_KEY = /^(ssn|ssn_?full|full_?ssn|ein|tax_?id|taxid|government_?id|governmentid|dob|birth_?date|birthdate|date_?of_?birth|account_?number|accountnumber|routing_?number|routingnumber|file_?base64|file|bytes|body|plaintext|secret|token|password|authorization)$/i;

export const isSensitiveKey = (key) => SENSITIVE_KEY.test(String(key || '').replace(/-/g, '_'));

/** Masks runs of 4+ digits (keeps nothing) so SSN/EIN/account numbers cannot leak through free text. */
export const redactText = (value, max = 200) => String(value ?? '')
  // SSN with any separator run (dash, space, dot, slash, underscore): 123-45-6789, 123 45 6789, 123.45.6789.
  .replace(/\d{3}[\s.\-_/]+\d{2}[\s.\-_/]+\d{4}/g, '[redacted]')
  // EIN with any separator: 12-3456789, 12 3456789, 12.3456789.
  .replace(/\d{2}[\s.\-_/]+\d{7}/g, '[redacted]')
  .replace(/\d{4,}/g, '[redacted]')
  .slice(0, max);

export const redact = (value, depth = 0) => {
  if (depth > 8) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, 400);
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) >= 1000 ? '[redacted]' : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) return '[bytes]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? '[redacted]' : redact(nested, depth + 1);
  }
  return out;
};

/** Structured, redacted log line. Callers pass codes and ids, never request bodies. */
export const onboardingLog = (event, fields = {}, logger = console) => {
  try {
    logger.error(JSON.stringify(redact({ service: 'checksops-api', event, ...fields })));
  } catch { /* logging never fails a request */ }
};

/** Stable, PII-free error code for a Moov failure. Moov messages can echo submitted values, so they are dropped. */
export const moovErrorCode = (error) => {
  const status = Number(error?.status || 0);
  if (!status) return 'moov_unreachable';
  if (status === 401 || status === 403) return 'moov_auth_failed';
  if (status === 404) return 'moov_not_found';
  if (status === 409) return 'moov_conflict';
  if (status === 422 || status === 400) return 'moov_rejected';
  if (status === 429) return 'moov_rate_limited';
  if (status >= 500) return 'moov_unavailable';
  return 'moov_failed';
};

const FIELD_SEGMENT = /^(?:[A-Za-z][A-Za-z0-9_]{0,40}|\d{1,2})$/;

/**
 * Field paths a Moov 400/422 body names (e.g. "profile.business.website"). Keys
 * only: messages and values are dropped because Moov can echo submitted data.
 */
export const moovRejectedFields = (error, max = 20) => {
  const status = Number(error?.status || 0);
  if (status !== 400 && status !== 422) return [];
  let body = error?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return []; }
  }
  if (!body || typeof body !== 'object') return [];
  if (body.error && typeof body.error === 'object') body = body.error;
  const paths = [];
  const walk = (node, prefix, depth) => {
    if (paths.length >= max || depth > 6) return;
    if (node === null || typeof node !== 'object') {
      if (prefix) paths.push(prefix);
      return;
    }
    for (const [key, nested] of Object.entries(node)) {
      if (!FIELD_SEGMENT.test(key)) continue;
      walk(nested, prefix ? `${prefix}.${key}` : key, depth + 1);
    }
  };
  walk(body, '', 0);
  return paths.filter((path) => path !== 'error' && path !== 'message' && path !== 'code');
};

export const isNetworkError = (error) => {
  const code = String(error?.cause?.code || error?.code || '');
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR/.test(code)
    || error?.name === 'AbortError'
    || (error instanceof TypeError && /fetch failed/i.test(String(error.message)));
};
