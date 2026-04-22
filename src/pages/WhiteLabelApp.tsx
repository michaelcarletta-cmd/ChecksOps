import { useParams, Routes, Route, Navigate } from "react-router-dom";
import { TenantProvider } from "@/contexts/TenantContext";
import { TenantThemeProvider } from "@/components/white-label/TenantThemeProvider";
import { WhiteLabelLogin } from "@/components/white-label/WhiteLabelLogin";
import { WhiteLabelCheckCenter } from "@/components/white-label/WhiteLabelCheckCenter";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";

function WhiteLabelRoutes() {
  const { tenant, loading, error } = useTenant();
  const { user, loading: authLoading } = useAuth();

  if (loading) {
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

  return (
    <Routes>
      <Route
        path="login"
        element={
          user && !authLoading
            ? <Navigate to={`/wl/${tenant.slug}/checks`} replace />
            : <WhiteLabelLogin />
        }
      />
      <Route path="checks" element={<WhiteLabelCheckCenter />} />
      <Route path="*" element={<Navigate to={user ? "checks" : "login"} replace />} />
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
