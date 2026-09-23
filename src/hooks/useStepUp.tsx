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
  isCheckBoundAction,
  parseStepUpCacheEntry,
  resolveStepUpAuthorizedAt,
  stepUpCacheAllowsReuse,
  stepUpCacheKey,
  type FinancialStepUpRequest,
  type StepUpCacheEntry,
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

export type RequireStepUpOptions = { force?: boolean };

interface StepUpContextValue {
  /** Resolves true once the user has a currently unexpired server-aligned step-up. */
  requireStepUp: (request: StepUpRequest, options?: RequireStepUpOptions) => Promise<boolean>;
  /** Drop the browser cache immediately. Server financial_stepup_log remains authoritative. */
  invalidateStepUp: () => void;
  /** True when TOTP is already satisfied and the client cache is still unexpired. */
  verified: boolean;
  /** True when the signed-in user has at least one verified TOTP factor. */
  totpEnrolled: boolean | null;
  refreshFactors: () => Promise<void>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

function readVerifiedScope(userId: string | null): StepUpCacheEntry | null {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(VERIFIED_KEY);
    if (!raw) return null;
    const entry = parseStepUpCacheEntry(JSON.parse(raw), userId);
    if (!entry) {
      sessionStorage.removeItem(VERIFIED_KEY);
      sessionStorage.removeItem(LEGACY_VERIFIED_KEY);
    }
    return entry;
  } catch {
    return null;
  }
}

function writeVerifiedScope(entry: StepUpCacheEntry) {
  try {
    sessionStorage.setItem(VERIFIED_KEY, JSON.stringify(entry));
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
  const [verifiedEntry, setVerifiedEntry] = useState<StepUpCacheEntry | null>(null);
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
        setVerifiedEntry(null);
        setTotpEnrolled(null);
        clearVerifiedScope();
        return;
      }
      setVerifiedEntry(readVerifiedScope(resolved));
      await refreshFactors();

      if (!awsMfaAvailable()) {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (active && aal?.currentLevel === "aal2") {
          const sessionKey = stepUpCacheKey(resolved, "disbursement.send", null);
          if (sessionKey) {
            const resolvedAt = resolveStepUpAuthorizedAt({ clientNowMs: Date.now() });
            const entry: StepUpCacheEntry = {
              userId: resolved,
              key: sessionKey,
              authorizedAt: resolvedAt.authorizedAt,
              source: resolvedAt.source,
            };
            writeVerifiedScope(entry);
            setVerifiedEntry(entry);
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

  const invalidateStepUp = useCallback(() => {
    clearVerifiedScope();
    setVerifiedEntry(null);
  }, []);

  const requireStepUp = useCallback(
    (next: StepUpRequest, options?: RequireStepUpOptions) => {
      if (isCheckBoundAction(next.actionKey) && !next.checkId) {
        return Promise.resolve(false);
      }
      const nextKey = stepUpCacheKey(userId, next.actionKey, next.checkId);
      if (!options?.force && stepUpCacheAllowsReuse(verifiedEntry, nextKey)) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        requestRef.current = next;
        setRequest(next);
      });
    },
    [userId, verifiedEntry],
  );

  const finish = useCallback(
    (ok: boolean, meta?: { authorizedAt?: number | string | null }) => {
      const current = requestRef.current;
      if (ok && userId && current) {
        const key = stepUpCacheKey(userId, current.actionKey, current.checkId);
        if (key) {
          const resolvedAt = resolveStepUpAuthorizedAt({
            serverCreatedAt: meta?.authorizedAt,
            clientNowMs: Date.now(),
          });
          const entry: StepUpCacheEntry = {
            userId,
            key,
            authorizedAt: resolvedAt.authorizedAt,
            source: resolvedAt.source,
          };
          writeVerifiedScope(entry);
          setVerifiedEntry(entry);
        }
      }
      requestRef.current = null;
      setRequest(null);
      resolverRef.current?.(ok);
      resolverRef.current = null;
    },
    [userId],
  );

  const verified = Boolean(verifiedEntry && stepUpCacheAllowsReuse(verifiedEntry, verifiedEntry.key));
  const value = useMemo<StepUpContextValue>(
    () => ({ requireStepUp, invalidateStepUp, verified, totpEnrolled, refreshFactors }),
    [requireStepUp, invalidateStepUp, verified, totpEnrolled, refreshFactors],
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
    invalidateStepUp: () => {},
    verified: false,
    totpEnrolled: null,
    refreshFactors: async () => {},
  };
}
