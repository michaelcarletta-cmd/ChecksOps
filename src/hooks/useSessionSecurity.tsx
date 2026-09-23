import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/aws/client";
import { useToast } from "@/hooks/use-toast";

interface SessionSecurityOptions {
  inactivityTimeoutMs?: number; // Default: 30 minutes
  onSessionInvalid?: (reason: string) => void;
}

const DEFAULT_INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const ACTIVITY_CHECK_INTERVAL = 60 * 1000; // Check every minute

export function useSessionSecurity(options: SessionSecurityOptions = {}) {
  const { 
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT,
    onSessionInvalid 
  } = options;
  
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const lastActivityRef = useRef<number>(Date.now());
  const sessionTokenRef = useRef<string | null>(null);
  const { toast } = useToast();

  // Generate a unique session token
  const generateSessionToken = useCallback(() => {
    return crypto.randomUUID() + '-' + Date.now().toString(36);
  }, []);

  // Register session on login
  const registerSession = useCallback(async () => {
    try {
      const token = generateSessionToken();
      sessionTokenRef.current = token;
      
      // Store in localStorage for persistence
      localStorage.setItem('session_token', token);
      
      const { data, error } = await supabase.rpc('register_session', {
        p_session_token: token,
        p_device_info: navigator.userAgent,
        p_ip_address: null // Would need server-side to get real IP
      });
      
      if (error) {
        console.error('Failed to register session:', error);
        return null;
      }
      
      setSessionId(data);
      lastActivityRef.current = Date.now();
      return data;
    } catch (error) {
      console.error('Session registration error:', error);
      return null;
    }
  }, [generateSessionToken]);

  // Validate current session
  const validateSession = useCallback(async () => {
    const token = sessionTokenRef.current || localStorage.getItem('session_token');
    if (!token) return { isValid: false, reason: 'No session token' };
    
    setIsValidating(true);
    try {
      const { data, error } = await supabase.rpc('validate_session', {
        p_session_token: token
      });
      
      if (error) {
        console.error('Session validation error:', error);
        return { isValid: false, reason: error.message };
      }
      
      const result = data?.[0];
      if (!result?.is_valid) {
        return { isValid: false, reason: result?.reason || 'Invalid session' };
      }
      
      return { isValid: true, reason: 'Valid' };
    } catch (error) {
      console.error('Session validation error:', error);
      return { isValid: false, reason: 'Validation failed' };
    } finally {
      setIsValidating(false);
    }
  }, []);

  // Invalidate session on logout
  const invalidateSession = useCallback(async () => {
    const token = sessionTokenRef.current || localStorage.getItem('session_token');
    if (!token) return;
    
    try {
      await supabase.rpc('invalidate_session', {
        p_session_token: token
      });
    } catch (error) {
      console.error('Failed to invalidate session:', error);
    } finally {
      localStorage.removeItem('session_token');
      sessionTokenRef.current = null;
      setSessionId(null);
    }
  }, []);

  // Update last activity timestamp
  const updateActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // Check for inactivity
  const checkInactivity = useCallback(() => {
    const timeSinceLastActivity = Date.now() - lastActivityRef.current;
    if (timeSinceLastActivity > inactivityTimeoutMs) {
      return true;
    }
    return false;
  }, [inactivityTimeoutMs]);

  // Handle session invalidation
  const handleSessionInvalid = useCallback(async (reason: string) => {
    toast({
      title: "Session Expired",
      description: reason,
      variant: "destructive",
    });
    
    await invalidateSession();
    await supabase.auth.signOut();
    
    onSessionInvalid?.(reason);
  }, [invalidateSession, onSessionInvalid, toast]);

  // Set up activity tracking + visibility-change session recovery
  useEffect(() => {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    
    const handleActivity = () => {
      updateActivity();
    };

    // When phone/tab wakes up, reset activity and refresh JWT only if it's expiring soon
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        // Reset activity so the inactivity check doesn't fire immediately
        updateActivity();
        // Only refresh the Supabase JWT if it expires within the next 60 seconds.
        // Refreshing unconditionally issues a new token every tab-switch, which
        // triggers onAuthStateChange → hydrateAuthState → full app re-render,
        // resetting the UI back to its default state (e.g. wrong tab selected).
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const expiresAt = session?.expires_at; // unix seconds
          const needsRefresh = !expiresAt || expiresAt - Date.now() / 1000 < 60;
          if (needsRefresh) {
            await supabase.auth.refreshSession();
          }
        } catch (e) {
          console.warn('Session refresh on wake failed:', e);
        }
      }
    };
    
    events.forEach(event => {
      document.addEventListener(event, handleActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      events.forEach(event => {
        document.removeEventListener(event, handleActivity);
      });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [updateActivity]);

  // Set up periodic session validation
  useEffect(() => {
    const token = localStorage.getItem('session_token');
    if (token) {
      sessionTokenRef.current = token;
    }
    
    const intervalId = setInterval(async () => {
      // First check client-side inactivity
      if (checkInactivity()) {
        await handleSessionInvalid('Session timed out due to inactivity');
        return;
      }
      
      // Then validate with server
      const { isValid, reason } = await validateSession();
      if (!isValid && reason !== 'No session token') {
        await handleSessionInvalid(reason);
      }
    }, ACTIVITY_CHECK_INTERVAL);
    
    return () => clearInterval(intervalId);
  }, [checkInactivity, handleSessionInvalid, validateSession]);

  // Listen for auth state changes to register/invalidate sessions
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          // Register new session on login
          await registerSession();
        } else if (event === 'SIGNED_OUT') {
          // Clean up session on logout
          await invalidateSession();
        }
      }
    );
    
    return () => subscription.unsubscribe();
  }, [registerSession, invalidateSession]);

  return {
    sessionId,
    isValidating,
    registerSession,
    validateSession,
    invalidateSession,
    updateActivity,
  };
}
