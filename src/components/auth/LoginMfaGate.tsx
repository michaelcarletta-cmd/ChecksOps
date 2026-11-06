import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, LogOut, ShieldCheck } from "lucide-react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { StepUpDialog } from "@/components/auth/StepUpDialog";
import { useAuth } from "@/hooks/useAuth";
import { useMortgageAuth } from "@/hooks/useMortgageAuth";
import { awsMfaAvailable, getAwsMfaStatus, LOGIN_MFA_ACTION } from "@/lib/awsMfa";
import { isPublicTokenRoute } from "@/lib/publicTokenRoutes";
import type { StepUpRequest } from "@/hooks/useStepUp";

const LOGIN_MFA_REQUEST: StepUpRequest = {
  actionKey: LOGIN_MFA_ACTION,
  checkId: null,
  title: "Two-factor sign-in",
  description:
    "Enter the 6-digit code from your authenticator app to finish signing in. If you haven't set one up yet, we'll walk you through it.",
};

type GateState = "idle" | "checking" | "required" | "passed";

type GateAuth = { userId: string | null; loading: boolean; signOut: () => Promise<void> | void };

/**
 * Login MFA (owner, 2026-11-06: "Login MFA - yes for everyone"). After a signed-in user's
 * email-code or passkey sign-in, asks for the authenticator code before showing the app, and
 * enrolls an authenticator first when the user has none (StepUpDialog). The API enforces the same
 * rule on every request (aws/functions/api/login-mfa.mjs); this screen is how a user passes it.
 * Shows nothing extra while the API reports the requirement as off, for signed-out visitors and
 * on public token links.
 */
function LoginMfaGateCore({ children, auth }: { children: ReactNode; auth: GateAuth }) {
  const { userId, loading, signOut } = auth;
  const [state, setState] = useState<GateState>("idle");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const { pathname } = useLocation();
  const publicRoute = isPublicTokenRoute(pathname);
  const applies = Boolean(userId) && !publicRoute && awsMfaAvailable();

  const check = useCallback(async () => {
    setState("checking");
    setCheckError(null);
    try {
      const status = await getAwsMfaStatus();
      if (status.loginMfaRequired && !status.loginMfaSatisfied) {
        setState("required");
        setDialogOpen(true);
      } else {
        setState("passed");
      }
    } catch (err: unknown) {
      // Fail closed: the API refuses every other request until the check passes.
      setCheckError(err instanceof Error ? err.message : String(err));
      setState("required");
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!applies) {
      setState("idle");
      setDialogOpen(false);
      return;
    }
    void check();
  }, [applies, loading, userId, check]);

  if (!applies || state === "passed") return <>{children}</>;

  // Before the first answer, show nothing of the app: its requests would be refused.
  if (state === "idle" || state === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 text-center shadow-sm">
        <ShieldCheck className="mx-auto h-10 w-10 text-primary" />
        <h1 className="text-xl font-semibold">Two-factor sign-in</h1>
        <p className="text-sm text-muted-foreground">
          ChecksOps asks every user for a code from an authenticator app after signing in.
        </p>
        {checkError && (
          <p className="text-sm text-destructive">Could not check your sign-in: {checkError}</p>
        )}
        <div className="flex flex-col gap-2">
          <Button onClick={() => (checkError ? void check() : setDialogOpen(true))}>
            {checkError ? "Try again" : "Enter code"}
          </Button>
          <Button variant="outline" onClick={() => void signOut()}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>
      <StepUpDialog
        request={dialogOpen ? LOGIN_MFA_REQUEST : null}
        onResolved={(ok) => {
          setDialogOpen(false);
          if (ok) void check();
        }}
        onFactorsChanged={() => undefined}
      />
    </div>
  );
}

/** App-wide gate on the default (CheckOps / white-label / vendor) session. Mortgage Desk has its own. */
export function LoginMfaGate({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const { pathname } = useLocation();
  const mortgagePath = pathname.startsWith("/mortgage-ops");
  return (
    <LoginMfaGateCore auth={{ userId: mortgagePath ? null : user?.id ?? null, loading, signOut }}>
      {children}
    </LoginMfaGateCore>
  );
}

/** Mortgage Desk pages: the same check on the Mortgage Desk session (awsMfa mfaSessionKey). */
export function MortgageLoginMfaGate({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useMortgageAuth();
  return (
    <LoginMfaGateCore auth={{ userId: user?.id ?? null, loading, signOut }}>
      {children}
    </LoginMfaGateCore>
  );
}
