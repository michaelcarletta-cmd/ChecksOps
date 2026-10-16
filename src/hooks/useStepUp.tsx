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
  stepUpCacheKey,
  type FinancialStepUpRequest,
} from "@/lib/financialStepUp";

/**
 * Two-factor step-up gate for money movement.
 *
 * Once per login: Check Alt deposits and approvals, like Moov wallet fund and
 * send, ask for a code once and then reuse that login's verification for
 * every check and amount until the user signs out. Each kind of step-up is
 * remembered separately for this tab's login (sessionStorage, cleared on sign
 * out). The server is the authority: when it answers step_up_required, the
 * caller asks again with `force`. Tenant and amount are not taken from the
 * browser as authority.
 */

const VERIFIED_KEY = "checksops_stepup_verified_scope";
const LEGACY_VERIFIED_KEY = "checksops_stepup_verified_user";

export type StepUpRequest = FinancialStepUpRequest;

interface StepUpContextValue {
  /**
   * Resolves true once the user has passed two-factor for this session.
   * `force` asks again even if this browser thinks the session is verified
   * (the server is the authority and may say otherwise).
   */
  requireStepUp: (request: StepUpRequest, options?: { force?: boolean }) => Promise<boolean>;
  /** True when TOTP is already satisfied for this login session. */
  verified: boolean;
  /** True when the signed-in user has at least one verified TOTP factor. */
  totpEnrolled: boolean | null;
  refreshFactors: () => Promise<void>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

function readVerifiedScopes(userId: string | null): string[] {
  if (!userId) return [];
  try {
    const raw = sessionStorage.getItem(VERIFIED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (parsed?.userId !== userId) return [];
    const keys = Array.isArray(parsed?.keys) ? parsed.keys : [parsed?.key];
    return keys.filter((key: unknown): key is string => typeof key === "string" && key.startsWith(`${userId}|`));
  } catch {
    return [];
  }
}

function writeVerifiedScopes(userId: string, keys: string[]) {
  try {
    sessionStorage.setItem(VERIFIED_KEY, JSON.stringify({ userId, keys }));
    sessionStorage.removeItem(LEGACY_VERIFIED_KEY);
  } catch {
    /* ignore */
  }
}

const withScope = (keys: string[], key: string) => (keys.includes(key) ? keys : [...keys, key]);

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
  const [verifiedKeys, setVerifiedKeys] = useState<string[]>([]);
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
        setVerifiedKeys([]);
        setTotpEnrolled(null);
        clearVerifiedScope();
        return;
      }
      setVerifiedKeys(readVerifiedScopes(resolved));
      await refreshFactors();

      if (!awsMfaAvailable()) {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (active && aal?.currentLevel === "aal2") {
          const sessionKey = stepUpCacheKey(resolved, "disbursement.send", null);
          if (sessionKey) {
            const keys = withScope(readVerifiedScopes(resolved), sessionKey);
            writeVerifiedScopes(resolved, keys);
            setVerifiedKeys(keys);
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
    (next: StepUpRequest, options?: { force?: boolean }) => {
      if (isCheckBoundAction(next.actionKey) && !next.checkId) {
        return Promise.resolve(false);
      }
      const nextKey = stepUpCacheKey(userId, next.actionKey, next.checkId);
      if (!options?.force && verifiedKeys.some((key) => cacheAllowsReuse(key, nextKey))) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        requestRef.current = next;
        setRequest(next);
      });
    },
    [userId, verifiedKeys],
  );

  const finish = useCallback(
    (ok: boolean) => {
      const current = requestRef.current;
      if (ok && userId && current) {
        const key = stepUpCacheKey(userId, current.actionKey, current.checkId);
        if (key) {
          const keys = withScope(readVerifiedScopes(userId), key);
          writeVerifiedScopes(userId, keys);
          setVerifiedKeys(keys);
        }
      }
      requestRef.current = null;
      setRequest(null);
      resolverRef.current?.(ok);
      resolverRef.current = null;
    },
    [userId],
  );

  const verified = verifiedKeys.length > 0;
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
