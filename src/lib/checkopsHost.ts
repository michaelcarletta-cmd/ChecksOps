/**
 * Host detection for the CheckOps white-label platform.
 *
 * checkops.com (and its subdomains + Lovable preview/staging) is the PUBLIC
 * white-label surface: the root shows marketing, /login authenticates, and
 * /{slug}/... loads an individual tenant's Check Center.
 *
 * The Freedom CRM lives on freedomclaims.work / freedomclaims.lovable.app /
 * localhost, where /claims, /tasks, /settings, etc. are the real routes — we
 * must never treat those paths as tenant slugs.
 */

const CHECKOPS_HOSTS = [
  "checkops.com",
  "www.checkops.com",
  "checkops.app",
  "www.checkops.app",
  // Staging subdomain we may provision on Lovable for the white-label surface
  "checkops.lovable.app",
];

export function isCheckOpsHost(hostname: string = typeof window !== "undefined" ? window.location.hostname : ""): boolean {
  if (!hostname) return false;
  if (CHECKOPS_HOSTS.includes(hostname)) return true;
  // Any subdomain of checkops.com / checkops.app
  if (hostname.endsWith(".checkops.com")) return true;
  if (hostname.endsWith(".checkops.app")) return true;
  return false;
}
