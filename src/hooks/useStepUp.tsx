import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { StepUpDialog } from "@/components/auth/StepUpDialog";
import { awsAuthUserId, awsMfaAvailable, getAwsMfaStatus } from "@/lib/awsMfa";

/**
 * Two-factor step-up gate for money movement.
 *
 * Every financial action (deposit approval, disbursement, wallet funding,
 * bank account changes) must call `requireStepUp()` first. The user proves
 * possession of their TOTP authenticator once per login session; the result
 * is remembered in sessionStorage so a page refresh inside the same tab
 * session does not re-prompt, but a fresh login always does.
 */

const VERIFIED_KEY = "checksops_stepup_verified_user";

export interface StepUpRequest {
  actionKey: string;
  title?: string;
  description?: string;
  tenantId?: string | null;
}

interface StepUpContextValue {
  /** Resolves true once the user has passed two-factor for this session. */
  requireStepUp: (request: StepUpRequest) => Promise<boolean>;
  /** True when TOTP is already satisfied for this login session. */
  verified: boolean;
  /** True when the signed-in user has at least one verified TOTP factor. */
  totpEnrolled: boolean | null;
  refreshFactors: () => Promise<void>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

function readVerified(userId: string | null) {
  if (!userId) return false;
  try {
    return sessionStorage.getItem(VERIFIED_KEY) === userId;
  } catch {
    return false;
  }
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [totpEnrolled, setTotpEnrolled] = useState<boolean | null>(null);
  const [request, setRequest] = useState<StepUpRequest | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const refreshFactors = useCallback(async () => {
    if (awsMfaAvailable()) {
      try {
        const status = await getAwsMfaStatus();
        setTotpEnrolled(Boolean(status.totpEnrolled));
      } catch {
        setTotpEnrolled(false);
      }
      return;
    }
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      setTotpEnrolled(null);
      return;
    }
    setTotpEnrolled((data?.totp ?? []).some((f) => f.status === "verified"));
  }, []);

  useEffect(() => {
    let active = true;

    const hydrate = async (uid: string | null) => {
      if (!active) return;
      const resolved = uid || (awsMfaAvailable() ? awsAuthUserId() : null);
      setUserId(resolved);
      if (!resolved) {
        setVerified(false);
        setTotpEnrolled(null);
        try {
          sessionStorage.removeItem(VERIFIED_KEY);
        } catch {
          /* ignore */
        }
        return;
      }
      setVerified(readVerified(resolved));
      await refreshFactors();

      if (!awsMfaAvailable()) {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (active && aal?.currentLevel === "aal2") {
          try {
            sessionStorage.setItem(VERIFIED_KEY, resolved);
          } catch {
            /* ignore */
          }
          setVerified(true);
        }
      }
    };

    supabase.auth.getSession().then(({ data }) => hydrate(data.session?.user?.id ?? null));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        try {
          sessionStorage.removeItem(VERIFIED_KEY);
        } catch {
          /* ignore */
        }
      }
      const nextId = session?.user?.id ?? null;
      setUserId((prev) => {
        if (prev !== nextId) void hydrate(nextId);
        return nextId;
      });
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [refreshFactors]);

  const requireStepUp = useCallback(
    (next: StepUpRequest) => {
      if (verified) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        setRequest(next);
      });
    },
    [verified],
  );

  const finish = useCallback(
    (ok: boolean) => {
      if (ok && userId) {
        try {
          sessionStorage.setItem(VERIFIED_KEY, userId);
        } catch {
          /* ignore */
        }
        setVerified(true);
      }
      setRequest(null);
      resolverRef.current?.(ok);
      resolverRef.current = null;
    },
    [userId],
  );

  const value = useMemo<StepUpContextValue>(
    () => ({ requireStepUp, verified, totpEnrolled, refreshFactors }),
    [requireStepUp, verified, totpEnrolled, refreshFactors],
  );

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <StepUpDialog
        request={request}
        onResolved={finish}
        onFactorsChanged={refreshFactors}
      />
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpContextValue {
  const ctx = useContext(StepUpContext);
  if (ctx) return ctx;
  // Safe fallback outside the provider: never silently allow a financial action.
  return {
    requireStepUp: async () => false,
    verified: false,
    totpEnrolled: null,
    refreshFactors: async () => {},
  };
}
