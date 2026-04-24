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
 * Root page on checkops.com. Shows the existing CheckOps marketing landing
 * with a floating "Sign In" CTA in the top-right for returning users.
 */
export default function CheckOpsLanding() {
  return (
    <div className="relative">
      <div className="fixed top-3 right-3 z-50 md:top-4 md:right-4">
        <Button asChild size="sm" variant="secondary" className="shadow-lg">
          <Link to="/login">Sign In</Link>
        </Button>
      </div>
      <Suspense fallback={<PageLoader />}>
        <CheckCenterMarketing />
      </Suspense>
    </div>
  );
}

export { CheckOpsLogo };
