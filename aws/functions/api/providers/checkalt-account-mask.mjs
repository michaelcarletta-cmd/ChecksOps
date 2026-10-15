/**
 * Check Alt depositor account masking and validation.
 *
 * The app only ever shows the last four digits of a tenant's deposit account
 * number: the register / verify / status responses (production and UAT) and
 * the stored last_register_payload go through these helpers. The input field
 * still accepts a new number; it is sent once, validated server-side, and
 * never echoed back.
 */

/** Digits only, 4 to 17 (US DDA/savings). No routing number: Check Alt binds the bank via the FI key. */
export const CHECKALT_ACCOUNT_NUMBER_RE = /^\d{4,17}$/;

export const MASK_PREFIX = '****';

export const accountLast4 = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
};

export const maskAccountNumber = (value) => {
  if (value === null || value === undefined || value === '') return value ?? null;
  const last4 = accountLast4(value);
  return last4 ? `${MASK_PREFIX}${last4}` : MASK_PREFIX;
};

/** Returns the normalized number, or null when it is not 4-17 digits. */
export const normalizeDepositAccountNumber = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return CHECKALT_ACCOUNT_NUMBER_RE.test(text) ? text : null;
};

const ACCOUNT_KEY_RE = /account.?(number|num|no)$|^accountnumber$|^depositaccountnumber$/i;

/**
 * Deep copy of a Check Alt / stored payload with account numbers masked:
 * any value under an account-number key, and any occurrence of a known full
 * account number inside a string.
 */
export const maskCheckAltPayload = (value, knownNumbers = []) => {
  const known = [...new Set(knownNumbers.map((n) => String(n ?? '').trim()).filter((n) => n.length >= 4))];
  const maskString = (text) => {
    let out = text;
    for (const number of known) {
      if (out.includes(number)) out = out.split(number).join(maskAccountNumber(number));
    }
    return out;
  };
  const walk = (node, key = null) => {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k);
      return out;
    }
    if (key && ACCOUNT_KEY_RE.test(key) && (typeof node === 'string' || typeof node === 'number')) {
      return maskAccountNumber(node);
    }
    if (typeof node === 'string') return maskString(node);
    if (typeof node === 'number' && known.includes(String(node))) return maskAccountNumber(node);
    return node;
  };
  return walk(value);
};

