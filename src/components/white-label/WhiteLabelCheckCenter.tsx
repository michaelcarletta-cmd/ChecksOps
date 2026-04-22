import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { lazy, Suspense, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { LogOut, Settings, Users } from "lucide-react";
import { TenantUserManager } from "./TenantUserManager";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

const CheckCommandCenter = lazy(() => import("@/pages/CheckCommandCenter"));

const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

export function WhiteLabelCheckCenter() {
  const { tenant, isWhiteLabel } = useTenant();
  const { user, loading } = useAuth();
  const [usersOpen, setUsersOpen] = useState(false);

  if (loading) return <PageLoader />;
  if (!user) {
    // Support both /wl/{slug} routes and custom domain routes
    const loginPath = tenant?.slug && window.location.pathname.startsWith("/wl/")
      ? `/wl/${tenant.slug}/login`
      : "/login";
    return <Navigate to={loginPath} replace />;
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 border-b border-border/70 bg-background/95 backdrop-blur flex items-center px-4 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          {tenant?.logo_url && (
            <img src={tenant.logo_url} alt={tenant.name} className="h-8 object-contain" />
          )}
          <span className="text-sm font-medium">{tenant?.name || "Check Center"}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground hidden md:block">
            {user.email}
          </span>
          {tenant && (
            <Sheet open={usersOpen} onOpenChange={setUsersOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" title="Manage Users">
                  <Users className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Team Members</SheetTitle>
                </SheetHeader>
                <div className="mt-4">
                  <TenantUserManager tenantId={tenant.id} />
                </div>
              </SheetContent>
            </Sheet>
          )}
          <Button variant="ghost" size="icon" onClick={handleSignOut} title="Sign Out">
            <LogOut className="h-4 w-4" />
          </Button>
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
