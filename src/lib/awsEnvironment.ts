/**
 * Environment identity for ChecksOps frontends.
 *
 * isAwsAuth — Cognito + AWS API client (staging or production-prep).
 * isAwsStagingEnv — staging-only UX (banner, UAT password). Fail closed.
 */

export const PRODUCTION_HOSTS = new Set(["checksops.com", "www.checksops.com"]);
export const STAGING_HOSTS = new Set(["staging.checksops.com"]);

const PRODUCTION_ENVS = new Set(["production", "prod", "production-prep"]);
const STAGING_ENVS = new Set(["staging", "aws-staging"]);

export function isAwsAuthProvider(authProvider?: string | null): boolean {
  return String(authProvider || "").toLowerCase() === "cognito";
}

export function hostnameFromAppUrl(appUrl?: string | null): string | null {
  const raw = String(appUrl || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True only for the staging environment. Production hosts never qualify,
 * even when VITE_AUTH_PROVIDER=cognito (production AWS SPA).
 *
 * Precedence: explicit VITE_CHECKSOPS_ENVIRONMENT, then runtime hostname,
 * then VITE_APP_URL host. Unknown hosts fail closed (not staging UI).
 */
export function isAwsStagingEnv(input: {
  checksopsEnv?: string | null;
  hostname?: string | null;
  appUrl?: string | null;
} = {}): boolean {
  const host = String(input.hostname || "").toLowerCase().trim();
  // Production hosts never present staging UX, even if a staging bundle
  // (VITE_CHECKSOPS_ENVIRONMENT=staging) is accidentally served there.
  if (host && PRODUCTION_HOSTS.has(host)) return false;
  if (host && STAGING_HOSTS.has(host)) return true;

  const env = String(input.checksopsEnv || "").toLowerCase().trim();
  if (STAGING_ENVS.has(env)) return true;
  if (PRODUCTION_ENVS.has(env)) return false;

  const appHost = hostnameFromAppUrl(input.appUrl);
  if (appHost) {
    if (STAGING_HOSTS.has(appHost)) return true;
    if (PRODUCTION_HOSTS.has(appHost)) return false;
  }

  return false;
}

export function isAwsHttpsPasskeysOrigin(input: {
  protocol?: string | null;
  hostname?: string | null;
  origin?: string | null;
  requiredRpId?: string | null;
  requiredOrigin?: string | null;
} = {}): boolean {
  try {
    if (String(input.protocol || "") !== "https:") return false;
    const rpId = String(input.requiredRpId || "").toLowerCase();
    const requiredOrigin = String(input.requiredOrigin || "").replace(/\/$/, "");
    const hostname = String(input.hostname || "").toLowerCase();
    const origin = String(input.origin || "").replace(/\/$/, "");
    if (!rpId || hostname !== rpId) return false;
    if (!requiredOrigin || origin !== requiredOrigin) return false;
    return true;
  } catch {
    return false;
  }
}
