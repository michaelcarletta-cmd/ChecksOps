import { isAwsStaging } from "@/lib/awsStaging";

function isProductionChecksOpsHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = String(window.location.hostname || "").toLowerCase();
  return host === "checksops.com" || host === "www.checksops.com";
}

export function AwsStagingBanner() {
  // isAwsStaging() is the Cognito/AWS-mode switch, not a hostname check.
  // Production AWS builds bake VITE_AUTH_PROVIDER=cognito, so hide the
  // amber banner on the production apex/www hosts only.
  if (!isAwsStaging() || isProductionChecksOpsHost()) return null;
  return (
    <div
      data-testid="aws-staging-banner"
      className="bg-amber-500 text-amber-950 text-center text-xs font-medium py-1 px-3"
    >
      AWS staging — Cognito + RDS. Production ChecksOps is unchanged.
    </div>
  );
}
