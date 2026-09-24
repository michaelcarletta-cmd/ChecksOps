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

import { isAwsStaging } from "./awsStaging";

const CHECKOPS_HOSTS = [
  "checkops.com",
  "www.checkops.com",
  "checksops.com",
  "www.checksops.com",
  "checkops.app",
  "www.checkops.app",
  "checksops.app",
  "www.checksops.app",
  // Staging subdomains we may provision on Lovable for the white-label surface
  "checkops.lovable.app",
  "checksops.lovable.app",
];

export function isChecksOpsPlatformHost(hostname: string): boolean {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase();
  if (CHECKOPS_HOSTS.includes(host)) return true;
  // Any subdomain of checkops.com / checksops.com / checkops.app / checksops.app
  if (host.endsWith(".checkops.com")) return true;
  if (host.endsWith(".checksops.com")) return true;
  if (host.endsWith(".checkops.app")) return true;
  if (host.endsWith(".checksops.app")) return true;
  return false;
}

export function isCheckOpsHost(hostname: string = typeof window !== "undefined" ? window.location.hostname : ""): boolean {
  // Isolated AWS staging frontend uses the same /{slug} ChecksOps routing as production.
  if (isAwsStaging()) return true;
  if (!hostname) return false;
  return isChecksOpsPlatformHost(hostname);
}

const MORTGAGE_OPS_HOSTS = [
  "mortgage.checksops.com",
  "mortgage.checkops.com",
];

export function isMortgageOpsHost(
  hostname: string = typeof window !== "undefined" ? window.location.hostname : ""
): boolean {
  if (!hostname) return false;
  return MORTGAGE_OPS_HOSTS.includes(hostname);
}
