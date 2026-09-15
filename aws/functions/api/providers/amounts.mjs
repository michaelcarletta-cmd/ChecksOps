/**
 * CheckAlt FinCapture requires integer cents with no decimal point.
 * Stored check.amount is whole dollars (e.g. 780.00) → userAmount 78000.
 * A raw dollar pass-through caused "RDC Amount Mismatch" against OCR cents.
 */

const CENTS_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?\d+(?:\.\d{1,2})?$/;

export const dollarsToIntegerCents = (value) => {
  if (value === undefined || value === null || value === '') {
    return { error: 'invalid_amount', message: 'amount is required' };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { error: 'invalid_amount', message: 'amount is not finite' };
    const cents = Math.round(value * 100);
    if (!Number.isInteger(cents)) return { error: 'invalid_amount', message: 'amount is not integer cents' };
    return { cents };
  }
  const raw = String(value).trim();
  if (!DECIMAL_RE.test(raw) && !CENTS_RE.test(raw)) {
    return { error: 'invalid_amount', message: 'amount must be a dollar decimal or integer cents' };
  }
  if (raw.includes('.')) {
    const [whole, frac = ''] = raw.split('.');
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
    if (!Number.isFinite(cents)) return { error: 'invalid_amount' };
    return { cents: raw.startsWith('-') && cents > 0 ? -cents : cents };
  }
  // Integer without a decimal is treated as dollars only when the caller
  // explicitly asks for dollar scale. CheckAlt submit always uses dollars*100.
  return { cents: Math.round(Number(raw) * 100) };
};

export const formatCheckAltUserAmount = (dollarAmount) => {
  const parsed = dollarsToIntegerCents(dollarAmount);
  if (parsed.error) return parsed;
  return {
    userAmount: parsed.cents,
    scale: 'integer_cents',
    sourceDollars: dollarAmount,
  };
};

/** Moov Transfers `amount.value` is integer USD cents (v2026.04.00 / v2026.07.00). */
export const MOOV_AMOUNT_API = {
  provider: 'moov',
  apiVersions: ['v2026.04.00', 'v2026.07.00'],
  field: 'amount.value',
  scale: 'integer_cents',
  currency: 'USD',
  example: { dollars: 123.45, value: 12345 },
  notes: 'Do not send dollar floats. Do not use amount.valueDecimal for ChecksOps execution.',
};

export const MIN_PROVIDER_AMOUNT_CENTS = 1;
export const MAX_PROVIDER_AMOUNT_CENTS = 100_000_000; // $1,000,000.00 hard ceiling

export const validateProviderCents = (cents, { allowZero = false } = {}) => {
  if (!Number.isInteger(cents)) {
    return { error: 'invalid_amount', message: 'amount must resolve to integer cents' };
  }
  if (cents < 0) {
    return { error: 'invalid_amount', message: 'negative amounts are rejected' };
  }
  if (cents === 0 && !allowZero) {
    return { error: 'invalid_amount', message: 'zero amounts are rejected' };
  }
  if (cents > MAX_PROVIDER_AMOUNT_CENTS) {
    return { error: 'invalid_amount', message: 'amount exceeds permitted maximum' };
  }
  return { cents, scale: 'integer_cents' };
};

export const formatMoovTransferAmount = (cents) => {
  const validated = validateProviderCents(cents);
  if (validated.error) return validated;
  return {
    amount: { currency: 'USD', value: validated.cents },
    scale: 'integer_cents',
    api: MOOV_AMOUNT_API,
  };
};

const UNTRUSTED_AMOUNT_KEYS = [
  'amount', 'amount_cents', 'amountCents', 'userAmount', 'user_amount',
  'value', 'valueDecimal', 'net_amount_cents', 'platform_fee_cents',
];

export const rejectUntrustedAmountFields = (body = {}) => {
  const present = UNTRUSTED_AMOUNT_KEYS.filter((key) => body[key] !== undefined && body[key] !== null);
  if (!present.length) return null;
  return {
    ok: false,
    statusCode: 400,
    error: 'untrusted_amount',
    fields: present,
    message: 'Provider amounts are server-derived. Browser-supplied amounts are rejected.',
  };
};

export const CHECKALT_STATUS_MAP = {
  numeric: {
    40: 'pending_approval',
    120: 'rejected',
    127: 'submitted',
    200: 'cleared',
  },
  string: {
    submitted: 'submitted',
    pending: 'submitted',
    pending_approval: 'pending_approval',
    processing: 'processing',
    approved: 'cleared',
    cleared: 'cleared',
    settled: 'cleared',
    deposited: 'cleared',
    returned: 'returned',
    rejected: 'rejected',
    declined: 'rejected',
    submitting: 'submitting',
    duplicate: 'duplicate',
    error: 'error',
  },
};

export const canonicalizeCheckAltStatusToken = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');

export const mapCheckAltStatus = (payload = {}) => {
  const numericStatus = Number(payload.statusCode ?? payload.status);
  if (Number.isFinite(numericStatus) && CHECKALT_STATUS_MAP.numeric[numericStatus]) {
    return CHECKALT_STATUS_MAP.numeric[numericStatus];
  }
  const rawStatus = canonicalizeCheckAltStatusToken(payload.status);
  return CHECKALT_STATUS_MAP.string[rawStatus] || null;
};
