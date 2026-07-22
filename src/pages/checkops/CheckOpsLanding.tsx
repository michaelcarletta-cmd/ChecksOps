import { Link } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";

const CheckCenterMarketing = lazy(() => import("@/pages/marketing/CheckCenterMarketing"));

const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

/**
 * Root page on checkops.com. Shows the existing ChecksOps marketing landing
 * with a floating "Sign In" CTA in the top-right for returning users.
 */
export default function CheckOpsLanding() {
  return (
    <Suspense fallback={<PageLoader />}>
      <CheckCenterMarketing />
    </Suspense>
  );
}

export { CheckOpsLogo };
