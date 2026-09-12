/**
 * AWS Cognito frontend switch vs staging-only UX.
 *
 * Production AWS SPAs set VITE_AUTH_PROVIDER=cognito and talk to /prep.
 * That must NOT make isAwsStaging() true on checksops.com.
 */

import { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
import {
  isAwsAuthProvider,
  isAwsHttpsPasskeysOrigin,
  isAwsStagingEnv,
} from "@/lib/awsEnvironment";

export { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
export {
  isAwsAuthProvider,
  isAwsHttpsPasskeysOrigin,
  isAwsStagingEnv,
  PRODUCTION_HOSTS,
  STAGING_HOSTS,
} from "@/lib/awsEnvironment";

const DEFAULT_ORIGIN = "https://staging.checksops.com";
const DEFAULT_RP_ID = "staging.checksops.com";

const originFromAppUrl = (appUrl: string | undefined) => {
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

/** Cognito native WebAuthn RP ID / HTTPS origin (from VITE_APP_URL). */
export const AWS_STAGING_HTTPS_ORIGIN = configured.origin;
export const AWS_STAGING_RP_ID = configured.rpId;

/** Default CheckOps / WhiteLabel Cognito session localStorage key. */
export const AWS_STAGING_AUTH_SESSION_KEY = "checksops.aws.staging.auth";
/** Mortgage Desk Cognito session — isolated from CheckOps (parity with sb-mortgage-ops-auth). */
export const AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY = "checksops.aws.staging.auth.mortgage-ops";

const runtimeHostname = () => {
  if (typeof window === "undefined") return "";
  try {
    return window.location.hostname;
  } catch {
    return "";
  }
};

/** Cognito + AWS API adapter. True on staging and production-prep AWS SPAs. */
export function isAwsAuth(): boolean {
  return isAwsAuthProvider(import.meta.env.VITE_AUTH_PROVIDER);
}

/**
 * Staging-only UX (banner, UAT password). False on checksops.com even when
 * the production SPA uses Cognito.
 */
export function isAwsStaging(): boolean {
  if (!isAwsAuth()) return false;
  return isAwsStagingEnv({
    checksopsEnv: import.meta.env.VITE_CHECKSOPS_ENVIRONMENT,
    hostname: runtimeHostname(),
    appUrl: import.meta.env.VITE_APP_URL,
  });
}

/**
 * AWS API base for Cognito builds.
 * Production Step 2: VITE_CHECKSOPS_API_URL=/prep (or same-origin) resolves
 * against window.location.origin so www.checksops.com stays same-origin.
 * Staging continues to use an absolute execute-api URL.
 */
export function awsApiBaseUrl(): string {
  const configuredUrl = String(import.meta.env.VITE_CHECKSOPS_API_URL || "");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return resolveAwsApiBaseUrl(configuredUrl, origin);
}

/**
 * Fail-closed gate for Cognito native WebAuthn.
 * Enabled when the browser HTTPS origin matches VITE_APP_URL (staging or production RP).
 */
export function isAwsHttpsPasskeysEnabled(): boolean {
  if (!isAwsAuth()) return false;
  if (typeof window === "undefined") return false;
  try {
    const { protocol, hostname, origin } = window.location;
    return isAwsHttpsPasskeysOrigin({
      protocol,
      hostname,
      origin,
      requiredRpId: AWS_STAGING_RP_ID,
      requiredOrigin: AWS_STAGING_HTTPS_ORIGIN,
    });
  } catch {
    return false;
  }
}

/** @deprecated use isAwsHttpsPasskeysEnabled — kept so existing imports compile. */
export function isAwsStagingHttpsPasskeysEnabled(): boolean {
  return isAwsHttpsPasskeysEnabled();
}

export const AWS_STAGING_PUBLIC_CONFIG = {
  region: "us-east-1",
  userPoolId: String(import.meta.env.VITE_COGNITO_USER_POOL_ID || ""),
  userPoolClientId: String(import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID || ""),
  rpId: AWS_STAGING_RP_ID,
  requiredOrigin: AWS_STAGING_HTTPS_ORIGIN,
} as const;
