import { isAwsStaging } from "@/lib/awsStaging";
import { isProductionAppBuild } from "@/lib/productionAppBuild";

export { isProductionAppBuild } from "@/lib/productionAppBuild";

const PRODUCTION_HOSTNAMES = new Set(["checksops.com", "www.checksops.com"]);

/**
 * Staging wording ("AWS staging") belongs on the staging site only. Production
 * runs the same Cognito build, so isAwsStaging() is true there too; this also
 * requires a non-production hostname, and a bundle not built for production (the app's
 * hostname is always localhost). Use it for labels, not auth behavior.
 */
export function isAwsStagingSite(): boolean {
  if (!isAwsStaging()) return false;
  if (isProductionAppBuild()) return false;
  if (typeof window === "undefined") return true;
  return !PRODUCTION_HOSTNAMES.has(window.location.hostname.toLowerCase());
}
