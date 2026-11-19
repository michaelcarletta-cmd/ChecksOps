import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { PUSH_REGISTER_FUNCTION, startNativePush } from "@/lib/nativePush";

/**
 * In the iOS/Android app, once someone is signed in: ask to send notifications, register the
 * phone and open the screen a tapped notification points to. Renders nothing; does nothing on the
 * website or while push is off for the platform (see lib/nativePush.ts).
 */
export function NativePushRegistration() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let cleanup: () => void = () => {};
    startNativePush({
      registerDevice: (token, platform) =>
        supabase.functions.invoke(PUSH_REGISTER_FUNCTION, { body: { token, platform } }),
      openLink: (path) => navigate(path),
      onError: (error) => console.warn("Push notifications unavailable", error),
    })
      .then((stop) => {
        if (cancelled) stop();
        else cleanup = stop;
      })
      .catch((error) => console.warn("Push notifications unavailable", error));
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [userId, navigate]);

  return null;
}
