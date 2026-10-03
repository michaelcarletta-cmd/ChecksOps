/**
 * Instant micro-deposit codes transit only to Moov PUT /verify.
 * Never log, never persist, never echo, never query-string.
 */

const CODE_KEY_RE = /^(code|verification_code|verificationCode|mv_code|mvCode)$/i;
const MV_CODE_RE = /\bMV?\s?-?\d{4}\b/gi;
const QUOTED_FOUR_RE = /"(code|verification_code|verificationCode)"\s*:\s*"\d{4}"/gi;

export const redactRecipientMvText = (value) => String(value ?? '')
  .replace(/("?(?:code|verification_code|verificationCode|mv_code|mvCode)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi, '$1[redacted]')
  .replace(MV_CODE_RE, '[mv-code]')
  .replace(QUOTED_FOUR_RE, '"$1":"[redacted]"');

export const redactRecipientMvValue = (value, key = '') => {
  if (CODE_KEY_RE.test(String(key))) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactRecipientMvValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [nestedKey, redactRecipientMvValue(nested, nestedKey)]),
    );
  }
  if (typeof value === 'string') return redactRecipientMvText(value);
  return value;
};

export const recipientMvResponseHasSecrets = (payload) => {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  if (!text) return false;
  if (/"code"\s*:\s*"MV?\d{4}"/i.test(text)) return true;
  if (/"verification_code"\s*:\s*"\d{4}"/i.test(text)) return true;
  if (/"code"\s*:\s*"\d{4}"/i.test(text)) return true;
  return false;
};
