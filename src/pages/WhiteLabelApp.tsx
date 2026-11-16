import { useParams, Routes, Route, Navigate, useLocation, Link } from "react-router-dom";
import { lazy, Suspense } from "react";
import { ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TenantProvider } from "@/contexts/TenantContext";
import { TenantThemeProvider } from "@/components/white-label/TenantThemeProvider";
import { ThemeScope } from "@/hooks/useTheme";
import { WhiteLabelLogin } from "@/components/white-label/WhiteLabelLogin";
import { WhiteLabelCheckCenter } from "@/components/white-label/WhiteLabelCheckCenter";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isCheckOpsHost } from "@/lib/checkopsHost";
import { useWorkspaceMembership } from "@/hooks/useWorkspaceMembership";
import { loginPathWithNext, postLoginPath } from "@/lib/loginReturnPath";

const Payments = lazy(() => import("@/pages/Payments"));
const CashJobs = lazy(() => import("@/pages/CashJobs"));
const WalletOps = lazy(() => import("@/pages/WalletOps"));
// Settings (branding, billing, compliance, users...) is large and opened rarely: its own chunk.
const WhiteLabelSettings = lazy(() =>
  import("@/components/white-label/WhiteLabelSettings").then((m) => ({ default: m.WhiteLabelSettings })),
);

/**
 * Resolves the base path for tenant routes.
 * On checkops.com: /{slug}
 * On other hosts (localhost, lovable previews): /wl/{slug}
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

  // Membership: the server's organization list first, then the tenant_users read; a confirmed
  // membership survives a failed refetch (useWorkspaceMembership, workspaceAccess.ts).
  const { workspaceAccess, memberLoading, checking, retry, failureReason } = useWorkspaceMembership(tenant, user);

  // tenants_public lists active tenants only, so an inactive organization looks
  // "not found". For a signed-in member, read the base tenant row (membership-
  // scoped RLS) to show the inactive screen instead.
  const { slug: routeSlug } = useParams<{ slug: string }>();
  const { data: hiddenTenantStatus, isLoading: hiddenStatusLoading } = useQuery({
    queryKey: ["tenant-hidden-status", routeSlug, user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("subscription_status")
        .eq("slug", routeSlug!)
        .maybeSingle();
      return (data as { subscription_status?: string | null } | null)?.subscription_status ?? null;
    },
    enabled: !loading && !tenant && !!routeSlug && !!user?.id,
  });
  const tenantInactive = (!tenant && !!hiddenTenantStatus && hiddenTenantStatus !== "active")
    || (!!tenant && tenant.subscription_status !== "active");

  const isMember = workspaceAccess === "member";


  if (loading || authLoading || (user && memberLoading) || (user && !tenant && !!routeSlug && hiddenStatusLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (tenantInactive) {
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

  // The membership read failed and the identity list does not name this tenant: we do not
  // know, so offer a retry instead of a false "Access Denied".
  if (user && !memberLoading && workspaceAccess === "unconfirmed" && location.pathname !== `${basePath}/login`) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <h1 className="text-xl font-semibold">We couldn't confirm your access to {tenant.name}.</h1>
          <p className="text-muted-foreground">
            Check your connection and try again. Retry also refreshes your sign-in.
          </p>
          {failureReason ? (
            <p className="text-xs text-muted-foreground">Reason: {failureReason}</p>
          ) : null}
          <Button onClick={() => void retry()} disabled={checking}>
            {checking ? "Checking…" : "Retry"}
          </Button>
        </div>
      </div>
    );
  }

  // User is logged in but not a member of this tenant (the read succeeded with no row).
  // Let them reach the login screen so they can switch accounts instead of hard-blocking.
  if (user && !memberLoading && workspaceAccess === "denied" && location.pathname !== `${basePath}/login`) {
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

  // Signed-out / expired-session redirects keep the page the user was on
  // (path + ?tab=...), and sign-in returns there instead of to /checks.
  const loginRedirect = <Navigate to={loginPathWithNext(basePath, location)} replace />;

  // One wrapper per page (keyed by path): in the app each page floats in from the right (index.css).
  return (
    <div key={location.pathname} className="route-page">
      <Routes>
        <Route
          path="login"
          element={
            user && !authLoading && isMember
              ? <Navigate to={postLoginPath(basePath, location.search)} replace />
              : <WhiteLabelLogin />
          }
        />
        <Route
          path="checks"
          element={
            !user
              ? loginRedirect
              : isMember
                ? <WhiteLabelCheckCenter />
                : <Navigate to={`${basePath}/login`} replace />
          }
        />
        <Route
          path="payments"
          element={
            !user
              ? loginRedirect
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
              ? loginRedirect
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
              ? loginRedirect
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
              ? loginRedirect
              : isMember
                ? (
                    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
                      <WhiteLabelSettings />
                    </Suspense>
                  )
                : <Navigate to={`${basePath}/login`} replace />
          }
        />
        <Route path="*" element={<Navigate to={user && isMember ? "checks" : "login"} replace />} />
      </Routes>
    </div>
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
