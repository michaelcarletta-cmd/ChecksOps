import { shouldShowAwsStagingBanner } from "@/lib/awsStaging";

export function AwsStagingBanner() {
  if (!shouldShowAwsStagingBanner()) return null;
  return (
    <div
      data-testid="aws-staging-banner"
      className="bg-amber-500 text-amber-950 text-center text-xs font-medium py-1 px-3"
    >
      AWS staging — Cognito + RDS. Production ChecksOps is unchanged.
    </div>
  );
}
