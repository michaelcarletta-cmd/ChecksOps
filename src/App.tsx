import { lazy, Suspense, useEffect } from "react";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import { PlatformAnnouncementBanner } from "@/components/platform/PlatformAnnouncementBanner";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useCustomDomainTenant } from "./hooks/useCustomDomainTenant";
import { CustomDomainWhiteLabelApp } from "./components/white-label/CustomDomainWhiteLabelApp";
import { AuthProvider } from "./hooks/useAuth";
import { StepUpProvider } from "./hooks/useStepUp";
import { ThemeProvider, ThemeScope } from "./hooks/useTheme";


import { bootstrapEmbedContext } from "./lib/embedContext";

// Capture Freedom CRM embed params (?embed=1&partner=...&freedom_claim_id=...)
// on first script execution, before any route or upload component reads them.
bootstrapEmbedContext();

// ChecksOps-only route tree
const Sign = lazy(() => import("./pages/Sign"));
const Endorse = lazy(() => import("./pages/Endorse"));
const PaymentDirectionPage = lazy(() => import("./pages/PaymentDirectionPage"));
const WhiteLabelApp = lazy(() => import("./pages/WhiteLabelApp"));
const CheckOpsLanding = lazy(() => import("./pages/checkops/CheckOpsLanding"));
const CheckOpsPricing = lazy(() => import("./pages/checkops/CheckOpsPricing"));
const CheckOpsSecurity = lazy(() => import("./pages/checkops/CheckOpsSecurity"));
const CheckOpsLogin = lazy(() => import("./pages/checkops/CheckOpsLogin"));
const CheckOpsSignup = lazy(() => import("./pages/checkops/CheckOpsSignup"));
const AccountSecurity = lazy(() => import("./pages/AccountSecurity"));
const CheckOpsResetPassword = lazy(() => import("./pages/checkops/CheckOpsResetPassword"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Unsubscribe = lazy(() => import("./pages/Unsubscribe"));
const RecipientPaymentSetup = lazy(() => import("./pages/RecipientPaymentSetup"));
const AdminTenants = lazy(() => import("./pages/admin/AdminTenants"));
const AdminMortgageOps = lazy(() => import("./pages/admin/AdminMortgageOps"));
const AdminFinancialModel = lazy(() => import("./pages/admin/AdminFinancialModel"));
const VerifyAccountStart = lazy(() => import("./pages/VerifyAccountStart"));
const PrivacyNotice = lazy(() => import("./pages/PrivacyNotice"));
const Terms = lazy(() => import("./pages/Terms"));
const FindAPro = lazy(() => import("./pages/FindAPro"));
const HomeownerCheckUpload = lazy(() => import("./pages/HomeownerCheckUpload"));
const HomeownerClaimPortal = lazy(() => import("./pages/HomeownerClaimPortal"));
const HomeownerLedger = lazy(() => import("./pages/HomeownerLedger"));
const PublicInvoicePage = lazy(() => import("./pages/PublicInvoicePage"));
const MortgageOpsLogin = lazy(() => import("./pages/mortgage-ops/MortgageOpsLogin"));
const MortgageOpsQueue = lazy(() => import("./pages/mortgage-ops/MortgageOpsQueue"));


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
      <Route path="/signup" element={<Suspense fallback={<PageLoader />}><CheckOpsSignup /></Suspense>} />
      <Route path="/account/security" element={<Suspense fallback={<PageLoader />}><AccountSecurity /></Suspense>} />
      <Route path="/forgot-password" element={<Navigate to="/login" replace />} />
      <Route path="/reset-password" element={<Suspense fallback={<PageLoader />}><CheckOpsResetPassword /></Suspense>} />
      <Route path="/auth" element={<Navigate to="/login" replace />} />
      <Route path="/sign" element={<Suspense fallback={<PageLoader />}><Sign /></Suspense>} />
      <Route path="/endorse" element={<Suspense fallback={<PageLoader />}><Endorse /></Suspense>} />
      <Route path="/payment-direction/:token" element={<Suspense fallback={<PageLoader />}><PaymentDirectionPage /></Suspense>} />
      <Route path="/verify-account/complete" element={<Suspense fallback={<PageLoader />}><VerifyAccountStart /></Suspense>} />
      <Route path="/verify-account/:token" element={<Suspense fallback={<PageLoader />}><VerifyAccountStart /></Suspense>} />
      <Route path="/pay-setup/:token" element={<Suspense fallback={<PageLoader />}><RecipientPaymentSetup /></Suspense>} />
      <Route path="/unsubscribe" element={<Suspense fallback={<PageLoader />}><Unsubscribe /></Suspense>} />
      <Route path="/pricing" element={<Suspense fallback={<PageLoader />}><CheckOpsPricing /></Suspense>} />
      <Route path="/security" element={<Suspense fallback={<PageLoader />}><CheckOpsSecurity /></Suspense>} />
      <Route path="/privacy-notice" element={<Suspense fallback={<PageLoader />}><PrivacyNotice /></Suspense>} />
      <Route path="/terms" element={<Suspense fallback={<PageLoader />}><Terms /></Suspense>} />
      <Route path="/terms-of-service" element={<Navigate to="/terms" replace />} />
      <Route path="/admin/tenants" element={<Suspense fallback={<PageLoader />}><AdminTenants /></Suspense>} />
      <Route path="/admin/mortgage-ops" element={<Suspense fallback={<PageLoader />}><AdminMortgageOps /></Suspense>} />
      <Route path="/admin/financial-model" element={<Suspense fallback={<PageLoader />}><AdminFinancialModel /></Suspense>} />
      <Route path="/find-a-pro" element={<Suspense fallback={<PageLoader />}><FindAPro /></Suspense>} />

      <Route path="/pros" element={<Navigate to="/find-a-pro" replace />} />
      <Route path="/h/upload" element={<Suspense fallback={<PageLoader />}><HomeownerCheckUpload /></Suspense>} />
      <Route path="/h/claim/:token" element={<Suspense fallback={<PageLoader />}><HomeownerClaimPortal /></Suspense>} />
      <Route path="/ledger/:token" element={<Suspense fallback={<PageLoader />}><HomeownerLedger /></Suspense>} />
      <Route path="/start-claim/:token" element={<Suspense fallback={<PageLoader />}><HomeownerLedger preClaim /></Suspense>} />
      <Route path="/mortgage-ops/login" element={<Suspense fallback={<PageLoader />}><MortgageOpsLogin /></Suspense>} />
      <Route path="/mortgage-ops/queue" element={<Suspense fallback={<PageLoader />}><MortgageOpsQueue /></Suspense>} />
      <Route path="/mortgage-ops" element={<Navigate to="/mortgage-ops/login" replace />} />
      <Route path="/invoice/:token" element={<Suspense fallback={<PageLoader />}><PublicInvoicePage /></Suspense>} />
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

/**
 * Password-recovery links can land on ANY path (site root, login, etc.)
 * depending on which redirect URL the email used. Wherever one lands,
 * route it to the reset form so the user always sees "Set a new password".
 */
function RecoveryHashRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    const goToReset = () => {
      if (window.location.pathname !== "/reset-password") {
        navigate(
          { pathname: "/reset-password", hash: window.location.hash },
          { replace: true }
        );
      }
    };

    // Hash still present (client hasn't consumed it yet)
    if (window.location.hash.includes("type=recovery")) {
      goToReset();
    }

    // Fired once the Supabase client exchanges the recovery token
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") goToReset();
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  return null;
}

function AppRoutes() {
  const { tenantSlug, loading } = useCustomDomainTenant();
  const pathname = window.location.pathname;

  if (loading) {
    return <PageLoader />;
  }

  // Public token links must work on any host, including tenant custom domains.
  // Otherwise emailed homeowner links can be caught by the tenant app and redirected to login.
  if (isPublicTokenRoute(pathname)) {
    return <CheckOpsRoutes />;
  }

  // Tenant-owned custom domain (e.g. acme-inspections.com) → that tenant's Check Center
  if (tenantSlug) {
    return <CustomDomainWhiteLabelApp slug={tenantSlug} />;
  }

  // Everything else (checkops.com, checksops.com, lovable previews, localhost)
  // serves the ChecksOps marketing + platform.
  return <CheckOpsRoutes />;
}

function isPublicTokenRoute(pathname: string): boolean {
  return (
    pathname === "/sign" ||
    pathname === "/endorse" ||
    pathname === "/unsubscribe" ||
    pathname.startsWith("/ledger/") ||
    pathname.startsWith("/start-claim/") ||
    pathname.startsWith("/payment-direction/") ||
    pathname.startsWith("/verify-account/") ||
    pathname.startsWith("/h/upload") ||
    pathname.startsWith("/h/claim/") ||
    pathname.startsWith("/invoice/")
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <OfflineIndicator />
        <BrowserRouter>
          <AuthProvider>
            <StepUpProvider>
              <ThemeScope>
                <RecoveryHashRedirect />
                <PlatformAnnouncementBanner />
                <AppRoutes />
              </ThemeScope>
            </StepUpProvider>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
