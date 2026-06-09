import { useState, useEffect, useCallback, createContext, useContext, ReactNode, useMemo } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const ROLE_CACHE_KEY = "cached_user_role";
const ROLE_PRIORITY = ["admin", "staff", "read_only", "guided", "contractor", "client"] as const;

function getCachedRole(forUserId?: string | null): string | null {
  try {
    const cached = localStorage.getItem(ROLE_CACHE_KEY);
    if (cached) {
      const { role, userId, expiry } = JSON.parse(cached);
      if (Date.now() < expiry && forUserId && userId === forUserId) {
        return role;
      }
      localStorage.removeItem(ROLE_CACHE_KEY);
    }
  } catch {
    localStorage.removeItem(ROLE_CACHE_KEY);
  }
  return null;
}

function setCachedRole(role: string | null, userId: string) {
  try {
    if (role) {
      localStorage.setItem(
        ROLE_CACHE_KEY,
        JSON.stringify({
          role,
          userId,
          expiry: Date.now() + 30 * 60 * 1000,
        })
      );
    } else {
      localStorage.removeItem(ROLE_CACHE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

function resolveHighestRole(roles: string[]): string | null {
  if (!roles.length) return null;
  for (const role of ROLE_PRIORITY) {
    if (roles.includes(role)) return role;
  }
  return roles[0] ?? null;
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  userRole: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
  sessionExpiredReason: string | null;
  clearSessionExpiredReason: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [sessionExpiredReason, setSessionExpiredReason] = useState<string | null>(null);

  const clearSessionExpiredReason = useCallback(() => {
    setSessionExpiredReason(null);
  }, []);

  const fetchUserRole = useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId);

      if (error) {
        console.error("Error fetching user role:", error);
        setUserRole(null);
        setCachedRole(null, userId);
      } else {
        const roles = Array.from(new Set((data ?? []).map((e) => e.role).filter(Boolean)));
        const role = resolveHighestRole(roles);
        setUserRole(role);
        setCachedRole(role, userId);
      }
    } catch (error) {
      console.error("Error in fetchUserRole:", error);
      setUserRole(null);
      setCachedRole(null, userId);
    } finally {
      setLoading(false);
    }
  }, []);

  const hydrateAuthState = useCallback((nextSession: Session | null) => {
    setSession((prev) => {
      const sameUser = prev?.user?.id === nextSession?.user?.id;

      // When the user hasn't changed, preserve the existing session object even
      // if the access token rotated. Supabase's autoRefreshToken fires an internal
      // visibilitychange listener that refreshes the JWT every time the tab becomes
      // visible, emitting TOKEN_REFRESHED with a new access_token string. Updating
      // React state on every token rotation changes the memoized AuthContext value,
      // which re-renders every useAuth() consumer and resets all local UI state
      // (active tabs, scroll position, etc.). The Supabase client stores the live
      // token in localStorage and uses it for all API calls — React state doesn't
      // need to track it.
      if (sameUser) {
        // On first hydration prev is null — resolve loading regardless of whether
        // there is a session (covers both logged-in and logged-out initial state).
        if (!prev) setLoading(false);
        return prev ?? nextSession;
      }

      // Actual user change (sign-in, sign-out, account switch).
      setUser(nextSession?.user ?? null);

      if (nextSession?.user) {
        const cachedRole = getCachedRole(nextSession.user.id);
        if (cachedRole) setUserRole(cachedRole);
        fetchUserRole(nextSession.user.id);
      } else {
        setUserRole(null);
        localStorage.removeItem(ROLE_CACHE_KEY);
        setLoading(false);
      }

      return nextSession;
    });
  }, [fetchUserRole]);

  const signOut = useCallback(async () => {
    setUserRole(null);
    localStorage.removeItem(ROLE_CACHE_KEY);
    await supabase.auth.signOut();
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      hydrateAuthState(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      hydrateAuthState(nextSession);
    });

    return () => subscription.unsubscribe();
  }, [hydrateAuthState]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    session,
    userRole,
    loading,
    signOut,
    sessionExpiredReason,
    clearSessionExpiredReason,
  }), [user, session, userRole, loading, signOut, sessionExpiredReason, clearSessionExpiredReason]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx) return ctx;
  // Fallback (e.g. tests / out-of-tree usage) — returns safe defaults.
  // In normal app flow AuthProvider wraps everything, so this branch is rare.
  return {
    user: null,
    session: null,
    userRole: null,
    loading: true,
    signOut: async () => { await supabase.auth.signOut(); },
    sessionExpiredReason: null,
    clearSessionExpiredReason: () => {},
  };
}
