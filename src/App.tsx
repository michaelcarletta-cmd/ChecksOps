import { lazy, Suspense } from "react";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useCustomDomainTenant } from "./hooks/useCustomDomainTenant";
import { CustomDomainWhiteLabelApp } from "./components/white-label/CustomDomainWhiteLabelApp";
import { AuthProvider } from "./hooks/useAuth";

// ChecksOps-only route tree
const Sign = lazy(() => import("./pages/Sign"));
const Endorse = lazy(() => import("./pages/Endorse"));
const PaymentDirectionPage = lazy(() => import("./pages/PaymentDirectionPage"));
const WhiteLabelApp = lazy(() => import("./pages/WhiteLabelApp"));
const CheckOpsLanding = lazy(() => import("./pages/checkops/CheckOpsLanding"));
const CheckOpsPricing = lazy(() => import("./pages/checkops/CheckOpsPricing"));
const CheckOpsLogin = lazy(() => import("./pages/checkops/CheckOpsLogin"));
const CheckOpsForgotPassword = lazy(() => import("./pages/checkops/CheckOpsForgotPassword"));
const CheckOpsResetPassword = lazy(() => import("./pages/checkops/CheckOpsResetPassword"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Unsubscribe = lazy(() => import("./pages/Unsubscribe"));
const AdminTenants = lazy(() => import("./pages/admin/AdminTenants"));

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 30,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    },
  },
});

const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
  </div>
);

/**
 * ChecksOps-only route tree.
 * - /             → ChecksOps marketing landing (with Sign In CTA)
 * - /login        → ChecksOps login (resolves tenant, redirects to /{slug}/checks)
 * - /sign         → Document signing flow (public token-based)
 * - /endorse      → Check endorsement flow (public token-based)
 * - /payment-direction/:token → Payment direction flow (public token-based)
 * - /:slug/*      → Tenant Check Center (white-label)
 * - /wl/:slug/*   → Legacy redirect to /:slug/*
 */
function CheckOpsRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Suspense fallback={<PageLoader />}><CheckOpsLanding /></Suspense>} />
      <Route path="/login" element={<Suspense fallback={<PageLoader />}><CheckOpsLogin /></Suspense>} />
      <Route path="/forgot-password" element={<Suspense fallback={<PageLoader />}><CheckOpsForgotPassword /></Suspense>} />
      <Route path="/reset-password" element={<Suspense fallback={<PageLoader />}><CheckOpsResetPassword /></Suspense>} />
      <Route path="/auth" element={<Navigate to="/login" replace />} />
      <Route path="/sign" element={<Suspense fallback={<PageLoader />}><Sign /></Suspense>} />
      <Route path="/endorse" element={<Suspense fallback={<PageLoader />}><Endorse /></Suspense>} />
      <Route path="/payment-direction/:token" element={<Suspense fallback={<PageLoader />}><PaymentDirectionPage /></Suspense>} />
      <Route path="/unsubscribe" element={<Suspense fallback={<PageLoader />}><Unsubscribe /></Suspense>} />
      <Route path="/pricing" element={<Suspense fallback={<PageLoader />}><CheckOpsPricing /></Suspense>} />
      <Route path="/admin/tenants" element={<Suspense fallback={<PageLoader />}><AdminTenants /></Suspense>} />
      <Route path="/wl/:slug/*" element={<LegacyWlRedirect />} />
      <Route path="/:slug/*" element={<Suspense fallback={<PageLoader />}><WhiteLabelApp /></Suspense>} />
      <Route path="*" element={<Suspense fallback={<PageLoader />}><NotFound /></Suspense>} />
    </Routes>
  );
}

function LegacyWlRedirect() {
  const pathname = window.location.pathname;
  const rest = pathname.replace(/^\/wl\//, "/");
  return <Navigate to={rest || "/"} replace />;
}

function AppRoutes() {
  const { tenantSlug, loading } = useCustomDomainTenant();

  if (loading) {
    return <PageLoader />;
  }

  // Tenant-owned custom domain (e.g. acme-inspections.com) → that tenant's Check Center
  if (tenantSlug) {
    return <CustomDomainWhiteLabelApp slug={tenantSlug} />;
  }

  // Everything else (checkops.com, checksops.com, lovable previews, localhost)
  // serves the ChecksOps marketing + platform.
  return <CheckOpsRoutes />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <OfflineIndicator />
      <BrowserRouter>
        <div className="dark">
          <AppRoutes />
        </div>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
