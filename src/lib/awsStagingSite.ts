import { isAwsStaging } from "@/lib/awsStaging";

const PRODUCTION_HOSTNAMES = new Set(["checksops.com", "www.checksops.com"]);

/**
 * Staging wording ("AWS staging") belongs on the staging site only. Production
 * runs the same Cognito build, so isAwsStaging() is true there too; this also
 * requires a non-production hostname. Use it for labels, not auth behavior.
 */
export function isAwsStagingSite(): boolean {
  if (!isAwsStaging()) return false;
  if (typeof window === "undefined") return true;
  return !PRODUCTION_HOSTNAMES.has(window.location.hostname.toLowerCase());
}
