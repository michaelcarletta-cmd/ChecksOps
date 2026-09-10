/**
 * Financial TOTP codes stay strings. Never coerce to number (leading zeros).
 * Trim surrounding whitespace only. Do not log the code.
 */

export const TOTP_CODE_DIGITS = 6;

export const TOTP_BOUNDARY_MESSAGE =
  "That verification code could not be confirmed. Wait for a new code in your authenticator app and try again.";

export const TOTP_SESSION_MESSAGE =
  "Your session expired. Sign in again and retry verification.";

export type TotpNormalizeResult =
  | { ok: true; code: string }
  | { ok: false; error: "totp_must_be_string" | "totp_invalid_format" };

export function normalizeTotpCode(value: unknown): TotpNormalizeResult {
  if (typeof value === "number") {
    return { ok: false, error: "totp_must_be_string" };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "totp_invalid_format" };
  }
  const trimmed = value.trim();
  if (!new RegExp(`^\\d{${TOTP_CODE_DIGITS}}$`).test(trimmed)) {
    return { ok: false, error: "totp_invalid_format" };
  }
  return { ok: true, code: trimmed };
}

export function totpUserFailureMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name || "")
    : "";
  const message = error instanceof Error ? error.message : String(error || "");
  const blob = `${name} ${message}`;
  if (/NotAuthorized|Access Token|session_expired|expired token/i.test(blob)) {
    return TOTP_SESSION_MESSAGE;
  }
  return TOTP_BOUNDARY_MESSAGE;
}
