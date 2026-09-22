/** Public hostname helpers for AWS Cognito SPAs. Independent of VITE_AUTH_PROVIDER. */

export const AWS_STAGING_HOSTNAME = "staging.checksops.com";
export const AWS_PRODUCTION_HOSTNAME = "checksops.com";
export const AWS_PRODUCTION_WWW_HOSTNAME = "www.checksops.com";

export function normalizePublicHostname(hostname: string | null | undefined): string {
  return String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
}

export function isAwsStagingHost(hostname?: string | null): boolean {
  return normalizePublicHostname(hostname) === AWS_STAGING_HOSTNAME;
}

export function isAwsProductionHost(hostname?: string | null): boolean {
  const host = normalizePublicHostname(hostname);
  return host === AWS_PRODUCTION_HOSTNAME || host === AWS_PRODUCTION_WWW_HOSTNAME;
}

export function currentBrowserHostname(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.location.hostname || "";
  } catch {
    return "";
  }
}

/** Banner is staging-host only. Cognito on checksops.com is production. */
export function shouldShowAwsStagingBanner(opts: {
  cognito: boolean;
  hostname?: string | null;
}): boolean {
  return opts.cognito === true && isAwsStagingHost(opts.hostname);
}

export function awsPasskeyRequiredMessage(requiredOrigin: string): string {
  const origin = String(requiredOrigin || "").replace(/\/$/, "") || "the configured HTTPS origin";
  return `Passkeys require ${origin}. Use email verification on this origin.`;
}

/** Apex URL for www.checksops.com so WebAuthn stays on RP ID checksops.com. */
export function apexCanonicalRedirectUrl(opts: {
  hostname?: string | null;
  protocol?: string | null;
  pathname?: string | null;
  search?: string | null;
  hash?: string | null;
}): string | null {
  if (normalizePublicHostname(opts.hostname) !== AWS_PRODUCTION_WWW_HOSTNAME) return null;
  const protocol = String(opts.protocol || "https:").toLowerCase();
  if (protocol && protocol !== "https:") return null;
  const pathname = opts.pathname && String(opts.pathname).startsWith("/") ? String(opts.pathname) : "/";
  const search = opts.search ? String(opts.search) : "";
  const hash = opts.hash ? String(opts.hash) : "";
  return `https://${AWS_PRODUCTION_HOSTNAME}${pathname}${search}${hash}`;
}
