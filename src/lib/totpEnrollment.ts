/** Account Security badge: enrolled if Cognito listed SOFTWARE_TOKEN_MFA. Preferred MFA is ignored. */
export const awsTotpEnrollmentDisplay = (
  status: { totpEnrolled?: boolean | null; preferredMfa?: string | null } | null | undefined,
): "enrolled" | "setup" => (status?.totpEnrolled === true ? "enrolled" : "setup");
