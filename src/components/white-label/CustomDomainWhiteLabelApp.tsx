import { lazy, Suspense } from "react";
import { TenantProvider } from "@/contexts/TenantContext";
import { TenantThemeProvider } from "@/components/white-label/TenantThemeProvider";
import { ThemeScope } from "@/hooks/useTheme";
import { WhiteLabelLogin } from "@/components/white-label/WhiteLabelLogin";
import { WhiteLabelCheckCenter } from "@/components/white-label/WhiteLabelCheckCenter";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Routes, Route, Navigate, useLocation, Link } from "react-router-dom";
import { ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isMasterMerchant } from "@/lib/masterMerchant";
import { decideWorkspaceAccess, identityListsTenant } from "@/lib/workspaceAccess";
import { loginPathWithNext, postLoginPath } from "@/lib/loginReturnPath";

const Payments = lazy(() => import("@/pages/Payments"));
const CashJobs = lazy(() => import("@/pages/CashJobs"));
const WalletOps = lazy(() => import("@/pages/WalletOps"));
// Settings (branding, billing, compliance, users...) is large and opened rarely: its own chunk.
const WhiteLabelSettings = lazy(() =>
  import("@/components/white-label/WhiteLabelSettings").then((m) => ({ default: m.WhiteLabelSettings })),
);

function SubPageHeader() {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Button variant="ghost" size="sm" asChild className="gap-1.5 h-8 px-2 text-muted-foreground hover:text-foreground">
        <Link to="/checks">
          <ArrowLeft className="h-4 w-4" />
          <span className="text-xs">Back</span>
        </Link>
      </Button>
      <Button variant="ghost" size="sm" asChild className="gap-1.5 h-8 px-2 text-muted-foreground hover:text-foreground">
        <Link to="/checks">
          <Home className="h-4 w-4" />
          <span className="text-xs">Home</span>
        </Link>
      </Button>
    </div>
  );
}

function CustomDomainRoutes() {
  const { tenant, loading, error } = useTenant();
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();

  // Membership: the server's organization list from /identity/me first, then the tenant_users
  // read. A failed read is not "no row" (workspaceAccess.ts). Same query key and shape as
  // WhiteLabelApp.
  const identityListsThisTenant = identityListsTenant(
    user?.app_metadata?.tenant_memberships,
    tenant?.id,
    tenant?.slug,
  );
  const {
    data: membershipRead,
    isLoading: memberQueryLoading,
    isFetching: memberFetching,
    refetch: refetchMembership,
  } = useQuery({
    queryKey: ["tenant-membership", tenant?.id, user?.id],
    queryFn: async () => {
      if (!tenant?.id || !user?.id) return { row: false, failed: false };
      const { data, error } = await supabase
        .from("tenant_users")
        .select("id")
        .eq("tenant_id", tenant.id)
        .eq("user_id", user.id)
        .maybeSingle();
      return { row: !!data, failed: !!error };
    },
    enabled: !!tenant?.id && !!user?.id,
  });
  const memberLoading = !identityListsThisTenant && memberQueryLoading;

  // Master merchant can preview any tenant's Check Center
  const workspaceAccess = decideWorkspaceAccess({
    tenantId: tenant?.id,
    tenantSlug: tenant?.slug,
    identityTenants: user?.app_metadata?.tenant_memberships,
    tenantUsersRow: !!membershipRead?.row,
    tenantUsersError: !!membershipRead?.failed,
    isMasterMerchant: isMasterMerchant(user?.email, user?.id),
  });
  const isMember = workspaceAccess === "member";

  if (loading || authLoading || (user && memberLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (error || !tenant) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Not Found</h1>
          <p className="text-muted-foreground">This domain is not configured.</p>
        </div>
      </div>
    );
  }

  if (tenant.subscription_status !== "active") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Subscription Inactive</h1>
          <p className="text-muted-foreground">
            This organization's subscription is currently inactive. Please contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  // The read failed and the identity list does not name this tenant: offer a retry, not a
  // false "Access Denied".
  if (user && !memberLoading && workspaceAccess === "unconfirmed" && location.pathname !== "/login") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <h1 className="text-xl font-semibold">We couldn't confirm your access to {tenant.name}.</h1>
          <p className="text-muted-foreground">
            Check your connection and try again.
          </p>
          <Button onClick={() => void refetchMembership()} disabled={memberFetching}>
            {memberFetching ? "Checking…" : "Retry"}
          </Button>
        </div>
      </div>
    );
  }

  if (user && !memberLoading && workspaceAccess === "denied" && location.pathname !== "/login") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground">
            You don't have access to this Check Center. Contact your administrator for an invite.
          </p>
        </div>
      </div>
    );
  }

  // Keep the page (path + ?tab=...) through a signed-out / expired-session
  // redirect so sign-in returns there instead of to /checks.
  const requireAuth = (node: React.ReactNode) =>
    !user
      ? <Navigate to={loginPathWithNext("", location)} replace />
      : isMember
        ? <>{node}</>
        : <Navigate to="/login" replace />;

  return (
    <Routes>
      <Route
        path="/login"
        element={
          user && isMember ? <Navigate to={postLoginPath("", location.search)} replace /> : <WhiteLabelLogin />
        }
      />
      <Route path="/checks" element={requireAuth(<WhiteLabelCheckCenter basePath="" />)} />
      <Route
        path="/payments"
        element={requireAuth(
          <div className="min-h-screen bg-background p-2 sm:p-3 md:p-6 max-w-full overflow-x-hidden">
            <SubPageHeader />
            <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
              <Payments />
            </Suspense>
          </div>
        )}
      />
      <Route
        path="/cash-jobs"
        element={requireAuth(
          <div className="min-h-screen bg-background p-2 sm:p-3 md:p-6 max-w-full overflow-x-hidden">
            <SubPageHeader />
            <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
              <CashJobs />
            </Suspense>
          </div>
        )}
      />
      {/* The Check Center header links to WalletOps; without this route a
          custom-domain refresh on /wallet-ops fell through to /checks. */}
      <Route
        path="/wallet-ops"
        element={requireAuth(
          <div className="min-h-screen bg-background p-2 sm:p-3 md:p-6 max-w-full overflow-x-hidden">
            <SubPageHeader />
            <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
              <WalletOps />
            </Suspense>
          </div>
        )}
      />
      <Route path="/settings" element={requireAuth(
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
          <WhiteLabelSettings />
        </Suspense>,
      )} />
      <Route path="*" element={<Navigate to={user && isMember ? "/checks" : "/login"} replace />} />
    </Routes>
  );
}

export function CustomDomainWhiteLabelApp({ slug }: { slug: string }) {
  return (
    <TenantProvider slug={slug}>
      <TenantThemeProvider>
        <ThemeScope>
          <CustomDomainRoutes />
        </ThemeScope>
      </TenantThemeProvider>
    </TenantProvider>
  );
}
