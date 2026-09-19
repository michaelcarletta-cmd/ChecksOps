/**
 * Post-OCR descriptive-text display normalization.
 * Does not extract, persist banking values, or change provider output in place.
 */
const PRESERVE_UPPER = new Set([
  'LLC',
  'LLP',
  'LP',
  'PC',
  'PA',
  'PLLC',
  'NJM',
  'USAA',
  'USA',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\//i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const lettersOnly = (value) => String(value || '').replace(/[^A-Za-z]/g, '');

export const isEffectivelyAllCaps = (value) => {
  const letters = lettersOnly(value);
  return letters.length > 0 && letters === letters.toUpperCase();
};

const titleSimple = (word) => {
  if (!word) return word;
  if (PRESERVE_UPPER.has(word.toUpperCase())) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
};

const titleCore = (core) => {
  if (!core) return core;
  if (/^([A-Za-z]\.)+[A-Za-z]?\.?$/.test(core)) return core.toUpperCase();
  if (PRESERVE_UPPER.has(core.toUpperCase())) return core.toUpperCase();
  if (core.includes("'")) {
    return core.split(/(')/).map((part) => (part === "'" ? part : titleSimple(part))).join('');
  }
  return titleSimple(core);
};

const titleToken = (token) => token.split('-').map((part) => {
  const match = part.match(/^(\W*)(.*?)(\W*)$/);
  if (!match) return part;
  return `${match[1]}${titleCore(match[2])}${match[3]}`;
}).join('-');

export const titleCaseDescriptive = (value) => String(value || '')
  .split(/\s+/)
  .filter(Boolean)
  .map(titleToken)
  .join(' ');

/**
 * Trim-only claim-number sanitizer. Does not change case, digits, or punctuation.
 */
export const normalizeClaimNumber = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
};

export const claimNumbersEqual = (left, right) => {
  const a = normalizeClaimNumber(left);
  const b = normalizeClaimNumber(right);
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
};

export const normalizeDescriptiveText = (value, { max = 200 } = {}) => {
  if (value == null) return null;
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (EMAIL_RE.test(text) || URL_RE.test(text) || UUID_RE.test(text)) return text.slice(0, max);
  if (/\d/.test(text) && !/\s/.test(text)) return text.slice(0, max);
  const out = isEffectivelyAllCaps(text) ? titleCaseDescriptive(text) : text;
  return out.slice(0, max);
};
