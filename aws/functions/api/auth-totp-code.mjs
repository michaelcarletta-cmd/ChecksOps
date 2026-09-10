/**
 * Shared TOTP code normalization for Cognito software-token verification.
 * Codes stay strings. Never coerce to Number (leading zeros). Do not log codes.
 */

export const TOTP_CODE_DIGITS = 6;

export const TOTP_BOUNDARY_MESSAGE =
  'That verification code could not be confirmed. Wait for a new code in your authenticator app and try again.';

export const TOTP_SESSION_MESSAGE =
  'Your session expired. Sign in again and retry verification.';

export const normalizeTotpCode = (value) => {
  if (typeof value === 'number') {
    return { ok: false, error: 'totp_must_be_string' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'totp_invalid_format' };
  }
  const trimmed = value.trim();
  if (!new RegExp(`^\\d{${TOTP_CODE_DIGITS}}$`).test(trimmed)) {
    return { ok: false, error: 'totp_invalid_format' };
  }
  return { ok: true, code: trimmed };
};

export const totpUserFailureMessage = (error) => {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  const blob = `${name} ${message}`;
  if (/NotAuthorized|Access Token|session_expired|expired token/i.test(blob)) {
    return TOTP_SESSION_MESSAGE;
  }
  return TOTP_BOUNDARY_MESSAGE;
};
