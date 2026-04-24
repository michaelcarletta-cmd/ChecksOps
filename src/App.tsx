import { lazy, Suspense, useEffect } from "react";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { useAuth } from "./hooks/useAuth";
import { useToast } from "./hooks/use-toast";
import { useCustomDomainTenant } from "./hooks/useCustomDomainTenant";
import { CustomDomainWhiteLabelApp } from "./components/white-label/CustomDomainWhiteLabelApp";

// Lazy load all page components for code splitting
const Index = lazy(() => import("./pages/Index"));
const Claims = lazy(() => import("./pages/Claims"));
const ClaimDetail = lazy(() => import("./pages/ClaimDetail"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Inbox = lazy(() => import("./pages/Inbox"));
const Clients = lazy(() => import("./pages/Clients"));
const ClientDetail = lazy(() => import("./pages/ClientDetail"));
const Settings = lazy(() => import("./pages/Settings"));
const Networking = lazy(() => import("./pages/Networking"));
const Templates = lazy(() => import("./pages/Templates"));
const Sales = lazy(() => import("./pages/Sales"));
const Auth = lazy(() => import("./pages/Auth"));
const PortalLogin = lazy(() => import("./pages/PortalLogin"));
const ClientPortal = lazy(() => import("./pages/ClientPortal"));
const ClientPortalHelp = lazy(() => import("./pages/ClientPortalHelp"));
const ContractorPortal = lazy(() => import("./pages/ContractorPortal"));
const Sign = lazy(() => import("./pages/Sign"));
const Endorse = lazy(() => import("./pages/Endorse"));
const PaymentDirectionPage = lazy(() => import("./pages/PaymentDirectionPage"));
const GuidedAuth = lazy(() => import("./pages/GuidedAuth"));
const GuidedPortal = lazy(() => import("./pages/GuidedPortal"));

const NotFound = lazy(() => import("./pages/NotFound"));
const Workspaces = lazy(() => import("./pages/Workspaces"));
const WorkspaceDetailPage = lazy(() => import("./pages/WorkspaceDetailPage"));

const DarwinOperations = lazy(() => import("./pages/DarwinOperations"));
const CheckCommandCenter = lazy(() => import("./pages/CheckCommandCenter"));
const BuildingFootprintIngestion = lazy(() => import("./pages/admin/BuildingFootprintIngestion"));
const WhiteLabelApp = lazy(() => import("./pages/WhiteLabelApp"));

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

// Loading fallback component
const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
  </div>
);

function ProtectedRoute({ children, allowedRoles }: { children: React.ReactNode; allowedRoles?: string[] }) {
  const { user, userRole, loading } = useAuth();

  if (loading) {
    return <PageLoader />;
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  if (allowedRoles && userRole && !allowedRoles.includes(userRole)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function AppRoutesInner() {
  const { user, userRole, loading, sessionExpiredReason, clearSessionExpiredReason } = useAuth();
  const { toast } = useToast();
  const inPasswordRecoveryFlow =
    window.location.hash.includes("type=recovery") ||
    new URLSearchParams(window.location.search).get("type") === "recovery" ||
    new URLSearchParams(window.location.search).get("reset") === "1";

  // Show session expired toast
  useEffect(() => {
    if (sessionExpiredReason) {
      toast({
        title: "Session Expired",
        description: sessionExpiredReason,
        variant: "destructive",
      });
      clearSessionExpiredReason();
    }
  }, [sessionExpiredReason, clearSessionExpiredReason, toast]);

  if (loading) {
    return <PageLoader />;
  }

  // Public routes that don't require authentication
  const publicRoutes = (
    <>
      <Route
        path="/auth"
        element={
          user && userRole === "client"
            ? <Navigate to="/client-portal" replace />
            : user && userRole === "contractor"
            ? <Navigate to="/contractor-portal" replace />
            : user && userRole === "guided"
            ? <Navigate to="/guided" replace />
            : user && !inPasswordRecoveryFlow
            ? <Navigate to="/" replace />
            : <Suspense fallback={<PageLoader />}><Auth /></Suspense>
        }
      />
      
      <Route path="/sign" element={<Suspense fallback={<PageLoader />}><Sign /></Suspense>} />
      <Route path="/endorse" element={<Suspense fallback={<PageLoader />}><Endorse /></Suspense>} />
      <Route path="/payment-direction/:token" element={<Suspense fallback={<PageLoader />}><PaymentDirectionPage /></Suspense>} />
      <Route path="/portal" element={<Suspense fallback={<PageLoader />}><PortalLogin /></Suspense>} />
      <Route path="/guided/auth" element={<Suspense fallback={<PageLoader />}><GuidedAuth /></Suspense>} />
      <Route path="/guided" element={<Suspense fallback={<PageLoader />}><GuidedPortal /></Suspense>} />
      {/* Redirect unauthenticated portal visitors to PIN login */}
      {!user && (
        <>
          <Route path="/client-portal/*" element={<Navigate to="/portal" replace />} />
          <Route path="/contractor-portal/*" element={<Navigate to="/portal" replace />} />
        </>
      )}
    </>
  );

  // Redirect based on role
  if (user && userRole === "client") {
    return (
      <Routes>
        {publicRoutes}
        <Route path="/client-portal" element={<Suspense fallback={<PageLoader />}><ClientPortal /></Suspense>} />
        <Route path="/client-portal/help" element={<Suspense fallback={<PageLoader />}><ClientPortalHelp /></Suspense>} />
        <Route path="/claims/:id" element={<Suspense fallback={<PageLoader />}><ClaimDetail /></Suspense>} />
        <Route path="*" element={<Navigate to="/client-portal" replace />} />
      </Routes>
    );
  }

  if (user && userRole === "contractor") {
    return (
      <Routes>
        {publicRoutes}
        <Route path="/contractor-portal" element={<Suspense fallback={<PageLoader />}><ContractorPortal /></Suspense>} />
        <Route path="/claims/:id" element={<Suspense fallback={<PageLoader />}><ClaimDetail /></Suspense>} />
        <Route path="*" element={<Navigate to="/contractor-portal" replace />} />
      </Routes>
    );
  }

  if (user && userRole === "guided") {
    return (
      <Routes>
        {publicRoutes}
        <Route path="/guided" element={<Suspense fallback={<PageLoader />}><GuidedPortal /></Suspense>} />
        <Route path="*" element={<Navigate to="/guided" replace />} />
      </Routes>
    );
  }

  // Admin and staff routes
  return (
    <Routes>
      {publicRoutes}
      <Route path="/" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Index /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/claims" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Claims /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/claims/:id" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><ClaimDetail /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/tasks" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Tasks /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/control-board" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><ClaimsControlBoard /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/inbox" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Inbox /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/clients" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Clients /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/clients/:id" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><ClientDetail /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/networking" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Networking /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/sales" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Sales /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/templates" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Templates /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/workspaces" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Workspaces /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/workspaces/:workspaceId" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><WorkspaceDetailPage /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><Settings /></Suspense></AppLayout></ProtectedRoute>} />
      
      <Route path="/darwin-operations" element={<ProtectedRoute allowedRoles={["admin", "staff", "read_only"]}><AppLayout><Suspense fallback={<PageLoader />}><DarwinOperations /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/check-command-center" element={<ProtectedRoute allowedRoles={["admin", "staff"]}><AppLayout><Suspense fallback={<PageLoader />}><CheckCommandCenter /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/admin/building-footprints" element={<ProtectedRoute allowedRoles={["admin"]}><AppLayout><Suspense fallback={<PageLoader />}><BuildingFootprintIngestion /></Suspense></AppLayout></ProtectedRoute>} />
      <Route path="/wl/:slug/*" element={<Suspense fallback={<PageLoader />}><WhiteLabelApp /></Suspense>} />
      <Route path="*" element={<Suspense fallback={<PageLoader />}><NotFound /></Suspense>} />
    </Routes>
  );
}

// Custom domain detection wrapper
function AppRoutes() {
  const { tenantSlug, loading } = useCustomDomainTenant();

  if (loading) {
    return <PageLoader />;
  }

  // If a custom domain matched a tenant, render the white-label app directly
  if (tenantSlug) {
    return <CustomDomainWhiteLabelApp slug={tenantSlug} />;
  }

  // Normal app routing
  return <AppRoutesInner />;
}

// App component
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
