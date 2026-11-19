import { isAwsStaging } from "@/lib/awsStaging";
import { isProductionAppBuild } from "@/lib/awsStagingSite";

export function AwsStagingBanner() {
  const hostname =
    typeof window === "undefined" ? "" : window.location.hostname.toLowerCase();

  if (hostname === "checksops.com" || hostname === "www.checksops.com") {
    return null;
  }

  // The iOS/Android app runs on localhost; a production build still says nothing about staging.
  if (isProductionAppBuild()) return null;

  if (!isAwsStaging()) return null;

  return (
    <div
      data-testid="aws-staging-banner"
      className="bg-amber-500 text-amber-950 text-center text-xs font-medium py-1 px-3"
    >
      AWS staging — Cognito + RDS. Production ChecksOps is unchanged.
    </div>
  );
}
