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
import {
  cacheAllowsReuse,
  isCheckBoundAction,
  isTenantBoundAction,
  stepUpCacheKey,
  type FinancialStepUpRequest,
} from "@/lib/financialStepUp";

/**
 * Two-factor step-up gate for money movement.
 *
 * Deposit submit/approve are bound to a server-side check id. A successful
 * TOTP for one check cannot authorize a different check. Tenant and amount
 * are not taken from the browser as authority.
 */

const VERIFIED_KEY = "checksops_stepup_verified_scope";
const LEGACY_VERIFIED_KEY = "checksops_stepup_verified_user";

export type StepUpRequest = FinancialStepUpRequest;

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

function readVerifiedScope(userId: string | null): string | null {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(VERIFIED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.userId !== userId || typeof parsed?.key !== "string") return null;
    return parsed.key;
  } catch {
    return null;
  }
}

function writeVerifiedScope(userId: string, key: string) {
  try {
    sessionStorage.setItem(VERIFIED_KEY, JSON.stringify({ userId, key }));
    sessionStorage.removeItem(LEGACY_VERIFIED_KEY);
  } catch {
    /* ignore */
  }
}

function clearVerifiedScope() {
  try {
    sessionStorage.removeItem(VERIFIED_KEY);
    sessionStorage.removeItem(LEGACY_VERIFIED_KEY);
  } catch {
    /* ignore */
  }
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [verifiedKey, setVerifiedKey] = useState<string | null>(null);
  const [totpEnrolled, setTotpEnrolled] = useState<boolean | null>(null);
  const [request, setRequest] = useState<StepUpRequest | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  const requestRef = useRef<StepUpRequest | null>(null);

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
        setVerifiedKey(null);
        setTotpEnrolled(null);
        clearVerifiedScope();
        return;
      }
      setVerifiedKey(readVerifiedScope(resolved));
      await refreshFactors();

      if (!awsMfaAvailable()) {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (active && aal?.currentLevel === "aal2") {
          const sessionKey = stepUpCacheKey(resolved, "disbursement.send", null);
          if (sessionKey) {
            writeVerifiedScope(resolved, sessionKey);
            setVerifiedKey(sessionKey);
          }
        }
      }
    };

    supabase.auth.getSession().then(({ data }) => hydrate(data.session?.user?.id ?? null));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        clearVerifiedScope();
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
      if (isCheckBoundAction(next.actionKey) && !next.checkId) {
        return Promise.resolve(false);
      }
      if (isTenantBoundAction(next.actionKey) && !next.tenantId) {
        return Promise.resolve(false);
      }
      const nextKey = stepUpCacheKey(userId, next.actionKey, next.checkId, next.tenantId);
      if (cacheAllowsReuse(verifiedKey, nextKey)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        requestRef.current = next;
        setRequest(next);
      });
    },
    [userId, verifiedKey],
  );

  const finish = useCallback(
    (ok: boolean) => {
      const current = requestRef.current;
      if (ok && userId && current) {
        const key = stepUpCacheKey(userId, current.actionKey, current.checkId, current.tenantId);
        if (key) {
          writeVerifiedScope(userId, key);
          setVerifiedKey(key);
        }
      }
      requestRef.current = null;
      setRequest(null);
      resolverRef.current?.(ok);
      resolverRef.current = null;
    },
    [userId],
  );

  const verified = Boolean(verifiedKey);
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
