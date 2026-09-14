import { isAwsStagingEnvironment } from "@/lib/awsStaging";

/** Staging hostname chrome only. Hidden on checksops.com / www.checksops.com. */
export function AwsStagingBanner() {
  if (!isAwsStagingEnvironment()) return null;
  return (
    <div
      data-testid="aws-staging-banner"
      className="bg-amber-500 text-amber-950 text-center text-xs font-medium py-1 px-3"
    >
      AWS staging — Cognito + RDS. Production ChecksOps is unchanged.
    </div>
  );
}
