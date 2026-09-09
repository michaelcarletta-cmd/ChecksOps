/**
 * Browser-local TOTP QR helpers.
 * The secret stays in memory for the enrollment session only.
 * Never log, persist, or send the secret or otpauth URI to analytics.
 */

const ISSUER = "ChecksOps";

export const buildTotpOtpauthUri = (secret: string, email?: string | null): string => {
  const key = String(secret || "").replace(/\s+/g, "");
  if (!key) throw new Error("missing_totp_secret");
  const label = encodeURIComponent(email || ISSUER);
  const issuer = encodeURIComponent(ISSUER);
  return `otpauth://totp/${issuer}:${label}?secret=${encodeURIComponent(key)}&issuer=${issuer}&digits=6&period=30`;
};

export const resolveTotpOtpauthUri = (input: {
  otpauthUri?: string | null;
  secret?: string | null;
  email?: string | null;
}): string => {
  const provided = String(input.otpauthUri || "").trim();
  if (provided.startsWith("otpauth://")) return provided;
  return buildTotpOtpauthUri(String(input.secret || ""), input.email);
};

export const totpQrDataUrl = async (otpauthUri: string): Promise<string> => {
  const uri = String(otpauthUri || "").trim();
  if (!uri.startsWith("otpauth://")) throw new Error("invalid_otpauth_uri");
  const { default: QRCode } = await import("qrcode");
  return QRCode.toDataURL(uri, {
    width: 176,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0f172a", light: "#ffffff" },
  });
};
