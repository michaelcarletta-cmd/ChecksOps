/**
 * AWS Cognito frontend switch.
 *
 * `isAwsStaging()` / `isAwsCognitoSpa()` mean this Vite build uses the Cognito
 * SPA client. That is true on both production (checksops.com) and staging
 * (staging.checksops.com). Do not rename or invert this flag — auth, storage,
 * and write-path code depend on it.
 *
 * Staging chrome (banner, master-UAT password toggle) uses
 * `isAwsStagingEnvironment()`, which requires the staging hostname.
 */

import { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
import {
  awsPasskeyOriginRequiredMessage,
  detectAwsStagingEnvironment,
  hostnameFromAppUrl,
  isAwsCognitoAuthProvider,
} from "@/lib/awsEnvDetect";

export { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
export {
  awsPasskeyOriginRequiredMessage,
  detectAwsStagingEnvironment,
  hostnameFromAppUrl,
  isAwsCognitoAuthProvider,
  isAwsProductionPublicHostname,
  isAwsStagingHostname,
} from "@/lib/awsEnvDetect";

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

/** Cognito SPA client is active. Not a staging-hostname check. */
export function isAwsCognitoSpa(): boolean {
  return isAwsCognitoAuthProvider(import.meta.env.VITE_AUTH_PROVIDER);
}

/**
 * Alias for `isAwsCognitoSpa()`. Keep this name: AWS-mode code paths depend on it.
 * Do not invert. Use `isAwsStagingEnvironment()` for staging UI chrome.
 */
export function isAwsStaging(): boolean {
  return isAwsCognitoSpa();
}

function runtimeHostname(): string {
  if (typeof window !== "undefined" && window.location?.hostname) {
    return window.location.hostname;
  }
  return hostnameFromAppUrl(import.meta.env.VITE_APP_URL);
}

/** Amber banner / master-UAT toggle. True only on staging.checksops.com Cognito SPA. */
export function isAwsStagingEnvironment(): boolean {
  return detectAwsStagingEnvironment({
    authProvider: import.meta.env.VITE_AUTH_PROVIDER,
    hostname: runtimeHostname(),
  });
}

export function awsPasskeysRequireConfiguredOriginMessage(): string {
  return awsPasskeyOriginRequiredMessage(AWS_STAGING_HTTPS_ORIGIN);
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
 * (production: https://checksops.com; staging default: https://staging.checksops.com).
 * HTTP S3 / localhost / unexpected hosts fail closed.
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
