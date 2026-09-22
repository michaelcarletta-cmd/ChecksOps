/**
 * AWS frontend helpers.
 *
 * AUTH and DATA/SERVICE are independent (see `@/lib/providers`).
 * `isAwsStaging()` remains the *combined* Cognito-auth + AWS-data switch
 * used by today's staging deploy. Do not rename or invert it.
 *
 * Production Vite builds use `.env.production` and never set
 * VITE_AUTH_PROVIDER=cognito, so combined AWS mode stays false on
 * ChecksOps.com until an approved production frontend env is deployed.
 */

import { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
import {
  resolveAuthProvider,
  resolveDataServiceProvider,
  resolveIntegrationSelection,
} from "@/lib/providers";

export { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
export {
  resolveAuthProvider,
  resolveDataServiceProvider,
  resolveIntegrationSelection,
} from "@/lib/providers";

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

const viteEnv = () => import.meta.env as Record<string, string | undefined>;

/** Browser identity is Cognito (EMAIL_OTP / WebAuthn). */
export function isCognitoAuth(): boolean {
  return resolveAuthProvider(viteEnv()) === "cognito";
}

/** Data/storage/functions/rpc use the AWS /prep adapter. */
export function isAwsDataPlane(): boolean {
  return resolveDataServiceProvider(viteEnv()) === "aws";
}

export function isSupabaseDataPlane(): boolean {
  return resolveDataServiceProvider(viteEnv()) === "supabase";
}

/**
 * Combined Cognito auth + AWS data adapter. Staging `--mode aws` stays true.
 * Future production (Cognito auth + explicit Supabase data) is false so
 * existing Supabase-backed services keep their current wiring.
 */
export function isAwsStaging(): boolean {
  return resolveIntegrationSelection(viteEnv()).client === "aws-adapter";
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
  if (!isCognitoAuth()) return false;
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
