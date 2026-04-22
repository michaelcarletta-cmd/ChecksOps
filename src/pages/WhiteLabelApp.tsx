import { useParams, Routes, Route, Navigate } from "react-router-dom";
import { TenantProvider } from "@/contexts/TenantContext";
import { TenantThemeProvider } from "@/components/white-label/TenantThemeProvider";
import { WhiteLabelLogin } from "@/components/white-label/WhiteLabelLogin";
import { WhiteLabelCheckCenter } from "@/components/white-label/WhiteLabelCheckCenter";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

function WhiteLabelRoutes() {
  const { tenant, loading, error } = useTenant();
  const { user, loading: authLoading } = useAuth();

  // Check tenant membership
  const { data: isMember, isLoading: memberLoading } = useQuery({
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

  if (loading || authLoading) {
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
  if (user && !memberLoading && !isMember && window.location.pathname !== `/wl/${tenant.slug}/login`) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground">
            You don't have access to {tenant.name}'s Check Center. Contact your administrator for an invite.
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
            ? <Navigate to={`/wl/${tenant.slug}/checks`} replace />
            : <WhiteLabelLogin />
        }
      />
      <Route path="checks" element={<WhiteLabelCheckCenter />} />
      <Route path="*" element={<Navigate to={user && isMember ? "checks" : "login"} replace />} />
    </Routes>
  );
}

export default function WhiteLabelApp() {
  const { slug } = useParams<{ slug: string }>();

  return (
    <TenantProvider slug={slug}>
      <TenantThemeProvider>
        <div className="dark">
          <WhiteLabelRoutes />
        </div>
      </TenantThemeProvider>
    </TenantProvider>
  );
}
