/**
 * KYC secrets transit only to Moov. Never log, never return, never query-string.
 */

const SENSITIVE_KEY_RE = /^(ssn|full|governmentid|government_id|governmentID|birthdate|birth_date|birthDate|dob)$/i;
const SSN_RE = /\b\d{3}-?\d{2}-?\d{4}\b/g;
const NINE_DIGIT_RE = /\b\d{9}\b/g;
const DOB_ISO_RE = /\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;

export const redactRecipientKycText = (value) => String(value ?? '')
  .replace(/("?(?:ssn|governmentID|governmentId|government_id|birthDate|birth_date|birthdate|dob)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi, '$1[redacted]')
  .replace(SSN_RE, '[ssn]')
  .replace(NINE_DIGIT_RE, '[ssn]')
  .replace(DOB_ISO_RE, '[dob]');

export const redactRecipientKycValue = (value, key = '') => {
  if (SENSITIVE_KEY_RE.test(String(key))) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactRecipientKycValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [nestedKey, redactRecipientKycValue(nested, nestedKey)]),
    );
  }
  if (typeof value === 'string') return redactRecipientKycText(value);
  return value;
};

export const recipientKycResponseHasSecrets = (payload) => {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  if (!text) return false;
  if (/"ssn"\s*:\s*"(?!\[redacted\]|\[ssn\])/i.test(text)) return true;
  if (/"full"\s*:\s*"\d{9}"/i.test(text)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true;
  if (/"birthDate"\s*:\s*\{/i.test(text)) return true;
  if (/"birth_date"\s*:\s*"/i.test(text)) return true;
  return false;
};

export const stripKycSecretsFromAccount = (account) => {
  if (!account || typeof account !== 'object') return account;
  const copy = { ...account };
  if (copy.profile?.individual) {
    const individual = { ...copy.profile.individual };
    delete individual.governmentID;
    delete individual.governmentId;
    delete individual.birthDate;
    delete individual.ssn;
    copy.profile = { ...copy.profile, individual };
  }
  return copy;
};
