import { useEffect } from "react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { TenantProvider, useTenant } from "@/contexts/TenantContext";
import { TenantThemeProvider } from "@/components/white-label/TenantThemeProvider";
import { useAuth } from "@/hooks/useAuth";
import { INACTIVE_ORG_LOGIN_MESSAGE, NO_MEMBERSHIP_LOGIN_MESSAGE, type LoginMembershipRow } from "@/lib/loginMembership";
import { cn } from "@/lib/utils";
import {
  resolveVendorWorkspace,
  VENDOR_OPS_LOGIN_PATH,
  VENDOR_OPS_MEMBERSHIP_SELECT,
  VENDOR_OPS_NAV,
  VENDOR_OPS_TITLE,
} from "@/lib/vendorOps";

const Spinner = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

function Blocked({ title, description, onSignOut }: { title: string; description: string; onSignOut: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="text-center space-y-3 max-w-md">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
        <Button variant="outline" onClick={onSignOut}>Sign out</Button>
      </div>
    </div>
  );
}

/**
 * Authenticated shell for /vendor-ops/*.
 *
 * The wallet and ledger components read the organization from TenantContext and
 * the user from useAuth (the main ChecksOps session). So this shell resolves the
 * signed-in member's organization itself and mounts TenantProvider with that slug.
 * The URL never carries a slug, so /:slug/* never sees "vendor-ops".
 */
export default function VendorOpsLayout() {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = VENDOR_OPS_TITLE;
  }, []);

  const { data: workspace, isLoading } = useQuery({
    queryKey: ["vendor-ops-workspace", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select(VENDOR_OPS_MEMBERSHIP_SELECT)
        .eq("user_id", user!.id);
      if (error) throw error;
      return resolveVendorWorkspace(data as LoginMembershipRow[] | null);
    },
  });

  const handleSignOut = async () => {
    await signOut();
    navigate(VENDOR_OPS_LOGIN_PATH, { replace: true });
  };

  if (authLoading) return <Spinner />;
  if (!user) return <Navigate to={VENDOR_OPS_LOGIN_PATH} replace />;
  if (isLoading || !workspace) return <Spinner />;

  if (workspace.kind !== "active") {
    const message = workspace.kind === "inactive" ? INACTIVE_ORG_LOGIN_MESSAGE : NO_MEMBERSHIP_LOGIN_MESSAGE;
    return <Blocked title={message.title} description={message.description} onSignOut={() => void handleSignOut()} />;
  }

  return (
    <TenantProvider slug={workspace.slug}>
      <TenantThemeProvider>
        <VendorOpsShell onSignOut={() => void handleSignOut()} />
      </TenantThemeProvider>
    </TenantProvider>
  );
}

function VendorOpsShell({ onSignOut }: { onSignOut: () => void }) {
  const { tenant, loading, error } = useTenant();

  if (loading) return <Spinner />;
  if (error || !tenant) {
    return (
      <Blocked
        title="Organization unavailable"
        description="We couldn't load your organization. Try again, or contact your ChecksOps administrator."
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-3 py-3 sm:px-6">
          <CheckOpsLogo className="h-8" />
          <div className="mr-auto min-w-0">
            <p className="text-sm font-semibold leading-tight">Vendor Portal</p>
            <p className="truncate text-xs text-muted-foreground">{tenant.name}</p>
          </div>
          <nav className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {VENDOR_OPS_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                    isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <Button variant="ghost" size="sm" onClick={onSignOut} className="gap-1.5">
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-2 sm:p-3 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
