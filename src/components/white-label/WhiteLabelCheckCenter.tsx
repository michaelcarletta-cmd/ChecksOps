import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { Navigate, useNavigate, Link } from "react-router-dom";
import { lazy, Suspense, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LogOut, Settings, BadgeCheck, Banknote, Receipt, Hammer, Wallet, ShieldCheck } from "lucide-react";
import { isCheckOpsHost } from "@/lib/checkopsHost";

const CheckCommandCenter = lazy(() => import("@/pages/CheckCommandCenter"));

const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

export function WhiteLabelCheckCenter() {
  const { tenant } = useTenant();
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const resolveTenantBase = useCallback((): string | null => {
    if (!tenant?.slug) return null;
    if (isCheckOpsHost()) return `/${tenant.slug}`;
    if (window.location.pathname.startsWith("/wl/")) return `/wl/${tenant.slug}`;
    return null;
  }, [tenant]);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    const tenantBase = resolveTenantBase();
    const loginPath = tenantBase ? `${tenantBase}/login` : "/login";
    navigate(loginPath, { replace: true });
  }, [resolveTenantBase, navigate]);

  if (loading) return <PageLoader />;
  if (!user) {
    const tenantBase = resolveTenantBase();
    const loginPath = tenantBase ? `${tenantBase}/login` : "/login";
    return <Navigate to={loginPath} replace />;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 border-b border-border/40 bg-background/95 backdrop-blur flex items-center px-3 md:px-5 sticky top-0 z-10">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          {tenant?.logo_url ? (
            <img src={tenant.logo_url} alt={tenant.name} className="h-7 md:h-8 object-contain flex-shrink-0" />
          ) : null}
          <div className="flex items-center gap-2 min-w-0">
            {!tenant?.logo_url && (
              <div className="min-w-0">
                <span className="text-sm font-semibold truncate block">{tenant?.name || "Check Center"}</span>
                <span className="hidden sm:flex items-center gap-1 text-[10px] text-muted-foreground leading-none">
                  <Banknote className="h-3 w-3" /> ChecksOps command center
                </span>
              </div>
            )}
            {tenant && !tenant.is_system_tenant && tenant.subscription_status === "active" && (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-4 border-primary/40 text-primary bg-primary/5 hidden sm:inline-flex gap-0.5 flex-shrink-0"
                title="Verified by ChecksOps"
              >
                <BadgeCheck className="h-2.5 w-2.5" />
                ChecksOps Verified
              </Badge>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1 md:gap-2 flex-shrink-0">
          <span className="text-[11px] text-muted-foreground hidden md:block truncate max-w-[180px]">
            {user.email}
          </span>
          {tenant && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Cash Jobs">
              <Link to={`${resolveTenantBase() ?? `/wl/${tenant.slug}`}/cash-jobs`}>
                <Hammer className="h-4 w-4" />
              </Link>
            </Button>
          )}
          {tenant && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="WalletOps">
              <Link to={`${resolveTenantBase() ?? `/wl/${tenant.slug}`}/wallet-ops`}>
                <Wallet className="h-4 w-4" />
              </Link>
            </Button>
          )}
          {tenant && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Payments">
              <Link to={`${resolveTenantBase() ?? `/wl/${tenant.slug}`}/payments`}>
                <Receipt className="h-4 w-4" />
              </Link>
            </Button>
          )}
          {tenant && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Settings">
              <Link to={`${resolveTenantBase() ?? `/wl/${tenant.slug}`}/settings`}>
                <Settings className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Sign-in security (passkeys & 2FA)">
            <Link to="/account/security">
              <ShieldCheck className="h-4 w-4" />
            </Link>
          </Button>
          <ThemeToggle />
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSignOut} title="Sign Out">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <main className="p-2 sm:p-3 md:p-6 max-w-full overflow-x-hidden">
        <Suspense fallback={<PageLoader />}>
          <CheckCommandCenter />
        </Suspense>
      </main>
    </div>
  );
}
