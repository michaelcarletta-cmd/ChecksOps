/**
 * Separate Cognito SPA detection from staging-hostname detection.
 *
 * `VITE_AUTH_PROVIDER=cognito` means the AWS/Cognito frontend client is active.
 * That is true on both checksops.com (production) and staging.checksops.com.
 * Staging chrome (amber banner, master-UAT password toggle) must follow the
 * hostname, not the Cognito switch.
 */

export const AWS_STAGING_HOSTNAMES = ["staging.checksops.com"] as const;
export const AWS_PRODUCTION_PUBLIC_HOSTNAMES = ["checksops.com", "www.checksops.com"] as const;

export function isAwsCognitoAuthProvider(authProvider: unknown): boolean {
  return String(authProvider || "").trim().toLowerCase() === "cognito";
}

export function normalizeHostname(hostname: unknown): string {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export function hostnameFromAppUrl(appUrl: unknown): string {
  const raw = String(appUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return normalizeHostname(url.hostname);
  } catch {
    return "";
  }
}

export function isAwsStagingHostname(hostname: unknown): boolean {
  const host = normalizeHostname(hostname);
  return (AWS_STAGING_HOSTNAMES as readonly string[]).includes(host);
}

export function isAwsProductionPublicHostname(hostname: unknown): boolean {
  const host = normalizeHostname(hostname);
  return (AWS_PRODUCTION_PUBLIC_HOSTNAMES as readonly string[]).includes(host);
}

/**
 * Staging environment chrome only. Never true on checksops.com / www.checksops.com.
 * Requires Cognito SPA plus the staging hostname.
 */
export function detectAwsStagingEnvironment(opts: {
  authProvider?: unknown;
  hostname?: unknown;
} = {}): boolean {
  if (!isAwsCognitoAuthProvider(opts.authProvider)) return false;
  return isAwsStagingHostname(opts.hostname);
}

export function awsPasskeyOriginRequiredMessage(requiredOrigin: unknown): string {
  const origin = String(requiredOrigin || "").trim().replace(/\/$/, "") || "this HTTPS origin";
  return `Passkeys require ${origin}. Use email verification on this origin.`;
}
