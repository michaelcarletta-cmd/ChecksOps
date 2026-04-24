import { useState, useEffect, useCallback, useRef } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const ROLE_CACHE_KEY = "cached_user_role";

function getCachedRole(forUserId?: string | null): string | null {
  try {
    const cached = localStorage.getItem(ROLE_CACHE_KEY);
    if (cached) {
      const { role, userId, expiry } = JSON.parse(cached);
      // Only return cache if it's for the same user and not expired
      if (Date.now() < expiry && (!forUserId || userId === forUserId)) {
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
      localStorage.setItem(ROLE_CACHE_KEY, JSON.stringify({
        role,
        userId,
        expiry: Date.now() + 30 * 60 * 1000, // 30 minutes
      }));
    } else {
      localStorage.removeItem(ROLE_CACHE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(getCachedRole);
  const [sessionExpiredReason, setSessionExpiredReason] = useState<string | null>(null);
  const sessionRegisteredRef = useRef(false);

  // Clear expired reason
  const clearSessionExpiredReason = useCallback(() => {
    setSessionExpiredReason(null);
  }, []);

  const fetchUserRole = useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("Error fetching user role:", error);
        setUserRole(null);
        setCachedRole(null, userId);
      } else {
        const role = data?.role ?? null;
        setUserRole(role);
        setCachedRole(role, userId);
      }
    } catch (error) {
      console.error("Error in fetchUserRole:", error);
      setUserRole(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    sessionRegisteredRef.current = false;
    localStorage.removeItem(ROLE_CACHE_KEY);
    await supabase.auth.signOut();
  }, []);

  useEffect(() => {
    // Check for existing session first
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      
      if (session?.user) {
        fetchUserRole(session.user.id);
      } else {
        setLoading(false);
      }
    });

    // Set up auth state listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        
        if (event === 'SIGNED_IN' && session?.user) {
          fetchUserRole(session.user.id);
        } else if (event === 'SIGNED_OUT') {
          setUserRole(null);
          localStorage.removeItem(ROLE_CACHE_KEY);
          setLoading(false);
        } else if (session?.user) {
          fetchUserRole(session.user.id);
        } else {
          setUserRole(null);
          setLoading(false);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [fetchUserRole]);

  return {
    user,
    session,
    userRole,
    loading,
    signOut,
    sessionExpiredReason,
    clearSessionExpiredReason,
  };
}
