/**
 * AWS Cognito frontend switch. Production Vite builds use `.env.production`
 * and never set VITE_AUTH_PROVIDER=cognito, so this stays false for ChecksOps.com
 * until an approved production AWS frontend env is deployed.
 */

const DEFAULT_ORIGIN = "https://staging.checksops.com";
const DEFAULT_RP_ID = "staging.checksops.com";

const originFromAppUrl = (appUrl) => {
  const raw = String(appUrl || DEFAULT_ORIGIN).trim().replace(/\/$/, "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return { origin: DEFAULT_ORIGIN, rpId: DEFAULT_RP_ID };
    return { origin: `${url.protocol}//${url.host}`, rpId: url.hostname };
  } catch {
    return { origin: DEFAULT_ORIGIN, rpId: DEFAULT_RP_ID };
  }
};

const configured = originFromAppUrl(import.meta.env.VITE_APP_URL);

/** Cognito native WebAuthn RP ID / HTTPS origin (staging default). */
export const AWS_STAGING_HTTPS_ORIGIN = configured.origin;
export const AWS_STAGING_RP_ID = configured.rpId;

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
 * Enabled only when the browser HTTPS origin matches VITE_APP_URL
 * (default https://staging.checksops.com). HTTP S3 / localhost / unexpected
 * hosts fail closed. Production `.env.production` does not set Cognito, so
 * this stays false on ChecksOps.com until an approved AWS frontend env exists.
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
