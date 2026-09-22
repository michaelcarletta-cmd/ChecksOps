/**
 * AWS Cognito frontend switch.
 * `isAwsStaging()` means "this SPA uses Cognito + the AWS API adapter".
 * Do not invert it — production checksops.com also sets VITE_AUTH_PROVIDER=cognito.
 * Host-specific staging vs production UX uses `isAwsStagingHost()` from awsHost.
 */

import { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
import {
  awsPasskeyRequiredMessage,
  currentBrowserHostname,
  isAwsProductionHost,
  isAwsStagingHost,
  shouldShowAwsStagingBanner,
} from "@/lib/awsHost";

export { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
export {
  AWS_PRODUCTION_HOSTNAME,
  AWS_PRODUCTION_WWW_HOSTNAME,
  AWS_STAGING_HOSTNAME,
  awsPasskeyRequiredMessage,
  currentBrowserHostname,
  isAwsProductionHost,
  isAwsStagingHost,
  shouldShowAwsStagingBanner,
} from "@/lib/awsHost";

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

/** Cognito SPA on staging.checksops.com — banner and staging-only copy. */
export function isAwsStagingEnvironment(hostname = currentBrowserHostname()): boolean {
  return isAwsStaging() && isAwsStagingHost(hostname);
}

/** Cognito SPA on checksops.com / www.checksops.com. */
export function isAwsProductionEnvironment(hostname = currentBrowserHostname()): boolean {
  return isAwsStaging() && isAwsProductionHost(hostname);
}

export function awsStagingBannerVisible(hostname = currentBrowserHostname()): boolean {
  return shouldShowAwsStagingBanner({ cognito: isAwsStaging(), hostname });
}

export function awsPasskeysBlockedMessage(): string {
  return `${awsPasskeyRequiredMessage(AWS_STAGING_HTTPS_ORIGIN)} Password sign-in is disabled.`;
}

/**
 * AWS API base for Cognito builds.
 * Production Step 2: VITE_CHECKSOPS_API_URL=/prep (or same-origin) resolves
 * against window.location.origin so www.checksops.com stays same-origin.
 * Staging continues to use an absolute execute-api URL.
 * Does not change Cognito IdP, JWT, or WebAuthn semantics.
 */
export function awsApiBaseUrl(): string {
  const configured = String(import.meta.env.VITE_CHECKSOPS_API_URL || "");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return resolveAwsApiBaseUrl(configured, origin);
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
