import { useState, useEffect, useCallback } from "react";
import type { User, Session } from "@supabase/supabase-js";
import { mortgageSupabase } from "@/integrations/supabase/mortgageClient";

const ROLE_PRIORITY = ["admin", "staff", "mortgage_agent", "read_only", "guided", "contractor", "client"] as const;

function resolveHighestRole(roles: string[]): string | null {
  if (!roles.length) return null;
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r;
  return roles[0] ?? null;
}

/**
 * Auth hook scoped to the Mortgage Ops portal. Uses a dedicated Supabase
 * client (mortgageSupabase) with its own storage key, so this session is
 * fully independent from the ChecksOps session.
 */
export function useMortgageAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRole = useCallback(async (userId: string) => {
    const { data } = await mortgageSupabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    const roles = Array.from(new Set((data ?? []).map((r) => r.role).filter(Boolean)));
    setUserRole(resolveHighestRole(roles));
  }, []);

  useEffect(() => {
    let mounted = true;

    mortgageSupabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) fetchRole(session.user.id).finally(() => setLoading(false));
      else setLoading(false);
    });

    const { data: { subscription } } = mortgageSupabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setUser(next?.user ?? null);
      if (next?.user) fetchRole(next.user.id);
      else setUserRole(null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [fetchRole]);

  const signOut = useCallback(async () => {
    await mortgageSupabase.auth.signOut();
    setUserRole(null);
  }, []);

  return { user, session, userRole, loading, signOut };
}
