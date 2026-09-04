/**
 * Staging-only switch. Production Vite builds use `.env.production` and never
 * set VITE_AUTH_PROVIDER=cognito, so this stays false for ChecksOps.com.
 */

/** Cognito native WebAuthn RP ID / HTTPS origin for AWS staging only. */
export const AWS_STAGING_HTTPS_ORIGIN = "https://staging.checksops.com";
export const AWS_STAGING_RP_ID = "staging.checksops.com";

/** Default CheckOps / WhiteLabel Cognito session localStorage key. */
export const AWS_STAGING_AUTH_SESSION_KEY = "checksops.aws.staging.auth";
/** Mortgage Desk Cognito session — isolated from CheckOps (parity with sb-mortgage-ops-auth). */
export const AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY = "checksops.aws.staging.auth.mortgage-ops";

export function isAwsStaging(): boolean {
  return String(import.meta.env.VITE_AUTH_PROVIDER || "").toLowerCase() === "cognito";
}

export function awsApiBaseUrl(): string {
  return String(import.meta.env.VITE_CHECKSOPS_API_URL || "").replace(/\/$/, "");
}

/**
 * Fail-closed gate for Cognito native WebAuthn.
 * Enabled only on the dedicated HTTPS staging hostname — never on HTTP S3
 * website endpoints, localhost, apex, www, or unexpected hosts.
 */
export function isAwsStagingHttpsPasskeysEnabled(): boolean {
  if (!isAwsStaging()) return false;
  if (typeof window === "undefined") return false;
  try {
    const { protocol, hostname, origin } = window.location;
    if (protocol !== "https:") return false;
    if (hostname !== AWS_STAGING_RP_ID) return false;
    if (origin.replace(/\/$/, "") !== AWS_STAGING_HTTPS_ORIGIN) return false;
    return true;
  } catch {
    return false;
  }
}

export const AWS_STAGING_PUBLIC_CONFIG = {
  region: "us-east-1",
  userPoolId: String(import.meta.env.VITE_COGNITO_USER_POOL_ID || ""),
  userPoolClientId: String(import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID || ""),
  rpId: AWS_STAGING_RP_ID,
  requiredOrigin: AWS_STAGING_HTTPS_ORIGIN,
} as const;
