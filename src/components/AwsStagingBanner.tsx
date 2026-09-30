import { isAwsStaging } from "@/lib/awsStaging";

export function AwsStagingBanner() {
  const hostname =
    typeof window === "undefined" ? "" : window.location.hostname.toLowerCase();

  if (hostname === "checksops.com" || hostname === "www.checksops.com") {
    return null;
  }

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
