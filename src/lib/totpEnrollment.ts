/** Account Security badge: enrolled if app-level financial TOTP verified_at is set. Cognito MFA is ignored. */
export const awsTotpEnrollmentDisplay = (
  status: { totpEnrolled?: boolean | null; preferredMfa?: string | null } | null | undefined,
): "enrolled" | "setup" => (status?.totpEnrolled === true ? "enrolled" : "setup");
