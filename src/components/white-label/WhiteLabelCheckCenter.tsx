import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";

const CheckCommandCenter = lazy(() => import("@/pages/CheckCommandCenter"));

const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

export function WhiteLabelCheckCenter() {
  const { tenant, isWhiteLabel } = useTenant();
  const { user, loading } = useAuth();

  if (loading) return <PageLoader />;
  if (!user) return <Navigate to={`/wl/${tenant?.slug}/login`} replace />;

  return (
    <div className="min-h-screen bg-background">
      {/* Tenant header */}
      <header className="h-14 border-b border-border/70 bg-background/95 backdrop-blur flex items-center px-4 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          {tenant?.logo_url && (
            <img src={tenant.logo_url} alt={tenant.name} className="h-8 object-contain" />
          )}
          <span className="text-sm font-medium">{tenant?.name || "Check Center"}</span>
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          Check Command Center
        </div>
      </header>
      <main className="p-3 md:p-6">
        <Suspense fallback={<PageLoader />}>
          <CheckCommandCenter />
        </Suspense>
      </main>
    </div>
  );
}
