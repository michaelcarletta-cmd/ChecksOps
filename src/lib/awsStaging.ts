/**
 * AWS Cognito frontend switch.
 * Production and staging SPA builds use `--mode aws` with VITE_AUTH_PROVIDER=cognito.
 */

import { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";

export { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";

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

/** AWS function path used by XHR/public fetches that cannot go through functions.invoke. */
export function awsFunctionsUrl(name: string): string {
  return `${awsApiBaseUrl()}/functions/v1/${encodeURIComponent(name)}`;
}

/**
 * Fail-closed gate for Cognito native WebAuthn.
 * Enabled only when the browser HTTPS origin matches VITE_APP_URL
 * (default https://staging.checksops.com). HTTP S3 / localhost / unexpected
 * hosts fail closed. Requires VITE_AUTH_PROVIDER=cognito from `--mode aws`.
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
