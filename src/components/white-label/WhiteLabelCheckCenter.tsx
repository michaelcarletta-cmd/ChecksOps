import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { Navigate, useNavigate, Link } from "react-router-dom";
import { lazy, Suspense, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogOut, Settings, Shield } from "lucide-react";

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

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    const loginPath = tenant?.slug && window.location.pathname.startsWith("/wl/")
      ? `/wl/${tenant.slug}/login`
      : "/login";
    navigate(loginPath, { replace: true });
  }, [tenant, navigate]);

  if (loading) return <PageLoader />;
  if (!user) {
    const loginPath = tenant?.slug && window.location.pathname.startsWith("/wl/")
      ? `/wl/${tenant.slug}/login`
      : "/login";
    return <Navigate to={loginPath} replace />;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 border-b border-border/40 bg-background/95 backdrop-blur flex items-center px-3 md:px-5 sticky top-0 z-10">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          {tenant?.logo_url && (
            <img src={tenant.logo_url} alt={tenant.name} className="h-7 md:h-8 object-contain flex-shrink-0" />
          )}
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold truncate">{tenant?.name || "Check Center"}</span>
            {tenant && !tenant.is_system_tenant && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-primary/30 text-primary hidden sm:inline-flex gap-0.5 flex-shrink-0">
                <Shield className="h-2.5 w-2.5" />
                {tenant.plan_tier || "starter"}
              </Badge>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1 md:gap-2 flex-shrink-0">
          <span className="text-[11px] text-muted-foreground hidden md:block truncate max-w-[180px]">
            {user.email}
          </span>
          {tenant && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Settings">
              <Link to={`/wl/${tenant.slug}/settings`}>
                <Settings className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSignOut} title="Sign Out">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <main className="p-2 sm:p-3 md:p-6">
        <Suspense fallback={<PageLoader />}>
          <CheckCommandCenter />
        </Suspense>
      </main>
    </div>
  );
}
