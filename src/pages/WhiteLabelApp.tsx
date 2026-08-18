import { useParams, Routes, Route, Navigate, useLocation, Link } from "react-router-dom";
import { lazy, Suspense } from "react";
import { ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TenantProvider } from "@/contexts/TenantContext";
import { TenantThemeProvider } from "@/components/white-label/TenantThemeProvider";
import { ThemeScope } from "@/hooks/useTheme";
import { WhiteLabelLogin } from "@/components/white-label/WhiteLabelLogin";
import { WhiteLabelCheckCenter } from "@/components/white-label/WhiteLabelCheckCenter";
import { WhiteLabelSettings } from "@/components/white-label/WhiteLabelSettings";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isCheckOpsHost } from "@/lib/checkopsHost";
import { isMasterMerchant } from "@/lib/masterMerchant";

const Payments = lazy(() => import("@/pages/Payments"));
const CashJobs = lazy(() => import("@/pages/CashJobs"));
const WalletOps = lazy(() => import("@/pages/WalletOps"));

/**
 * Resolves the base path for tenant routes.
 * On checkops.com: /{slug}
 * On other hosts (freedomclaims.work, lovable previews): /wl/{slug}
 */
function useTenantBasePath(slug?: string) {
  const location = useLocation();
  const hostScoped = isCheckOpsHost();
  if (!slug) return "";
  if (location.pathname.startsWith(`/wl/${slug}`)) return `/wl/${slug}`;
  if (location.pathname.startsWith(`/${slug}`)) return `/${slug}`;
  return hostScoped ? `/${slug}` : `/wl/${slug}`;
}

function SubPageHeader({ basePath }: { basePath: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Button variant="ghost" size="sm" asChild className="gap-1.5 h-8 px-2 text-muted-foreground hover:text-foreground">
        <Link to={`${basePath}/checks`}>
          <ArrowLeft className="h-4 w-4" />
          <span className="text-xs">Back</span>
        </Link>
      </Button>
      <Button variant="ghost" size="sm" asChild className="gap-1.5 h-8 px-2 text-muted-foreground hover:text-foreground">
        <Link to={`${basePath}/checks`}>
          <Home className="h-4 w-4" />
          <span className="text-xs">Home</span>
        </Link>
      </Button>
    </div>
  );
}

function WhiteLabelRoutes() {
  const { tenant, loading, error } = useTenant();
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const basePath = useTenantBasePath(tenant?.slug);

  // Check tenant membership
  const { data: isTenantMember, isLoading: memberLoading } = useQuery({
    queryKey: ["tenant-membership", tenant?.id, user?.id],
    queryFn: async () => {
      if (!tenant?.id || !user?.id) return false;
      const { data } = await supabase
        .from("tenant_users")
        .select("id")
        .eq("tenant_id", tenant.id)
        .eq("user_id", user.id)
        .maybeSingle();
      return !!data;
    },
    enabled: !!tenant?.id && !!user?.id,
  });

  // Master merchant can preview any tenant's Check Center
  const isMember = !!isTenantMember || isMasterMerchant(user?.email);


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
          <h1 className="text-2xl font-bold">Organization Not Found</h1>
          <p className="text-muted-foreground">
            The organization you're looking for doesn't exist or is no longer active.
          </p>
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

  // User is logged in but not a member of this tenant.
  // Let them reach the login screen so they can switch accounts instead of hard-blocking.
  if (user && !memberLoading && !isMember && location.pathname !== `${basePath}/login`) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground">
            You don't have access to {tenant.name}'s ChecksOps workspace. Contact your administrator for an invite.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="login"
        element={
          user && !authLoading && isMember
            ? <Navigate to={`${basePath}/checks`} replace />
            : <WhiteLabelLogin />
        }
      />
      <Route
        path="checks"
        element={
          !user
            ? <Navigate to={`${basePath}/login`} replace />
            : isMember
              ? <WhiteLabelCheckCenter />
              : <Navigate to={`${basePath}/login`} replace />
        }
      />
      <Route
        path="payments"
        element={
          !user
            ? <Navigate to={`${basePath}/login`} replace />
            : isMember
              ? (
                <div className="min-h-screen bg-background p-2 sm:p-3 md:p-6 max-w-full overflow-x-hidden">
                  <SubPageHeader basePath={basePath} />
                  <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
                    <Payments />
                  </Suspense>
                </div>
              )
              : <Navigate to={`${basePath}/login`} replace />
        }
      />
      <Route
        path="cash-jobs"
        element={
          !user
            ? <Navigate to={`${basePath}/login`} replace />
            : isMember
              ? (
                <div className="min-h-screen bg-background p-2 sm:p-3 md:p-6 max-w-full overflow-x-hidden">
                  <SubPageHeader basePath={basePath} />
                  <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
                    <CashJobs />
                  </Suspense>
                </div>
              )
              : <Navigate to={`${basePath}/login`} replace />
        }
      />
      <Route
        path="wallet-ops"
        element={
          !user
            ? <Navigate to={`${basePath}/login`} replace />
            : isMember
              ? (
                <div className="min-h-screen bg-background p-2 sm:p-3 md:p-6 max-w-full overflow-x-hidden">
                  <SubPageHeader basePath={basePath} />
                  <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
                    <WalletOps />
                  </Suspense>
                </div>
              )
              : <Navigate to={`${basePath}/login`} replace />
        }
      />
      <Route
        path="settings"
        element={
          !user
            ? <Navigate to={`${basePath}/login`} replace />
            : isMember
              ? <WhiteLabelSettings />
              : <Navigate to={`${basePath}/login`} replace />
        }
      />
      <Route path="*" element={<Navigate to={user && isMember ? "checks" : "login"} replace />} />
    </Routes>
  );
}

export default function WhiteLabelApp() {
  const { slug } = useParams<{ slug: string }>();

  return (
    <TenantProvider slug={slug}>
      <TenantThemeProvider>
        <ThemeScope>
          <WhiteLabelRoutes />
        </ThemeScope>
      </TenantThemeProvider>
    </TenantProvider>
  );
}
