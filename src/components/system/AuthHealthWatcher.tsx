import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { getFriendlyAuthError, hardRefresh } from "@/lib/authErrorMessage";

/**
 * Watches for auth-layer failures that happen AFTER a user is signed in
 * (e.g. Supabase deprecates an API key mid-session, or the client bundle
 * goes stale after a backend update). When we detect one, we show a
 * persistent toast telling the user to refresh, with a one-click button.
 *
 * Implementation: monkey-patches window.fetch and inspects responses from
 * the Supabase auth endpoint. This is passive — normal requests are
 * untouched.
 */
export function AuthHealthWatcher() {
  const firedRef = useRef(false);

  useEffect(() => {
    const supabaseUrl = (import.meta as any).env?.VITE_SUPABASE_URL as
      | string
      | undefined;
    if (!supabaseUrl) return;

    const originalFetch = window.fetch.bind(window);

    const showSystemUpdateToast = (rawMessage: string) => {
      if (firedRef.current) return;
      firedRef.current = true;
      const friendly = getFriendlyAuthError(new Error(rawMessage));
      toast.error(friendly.title, {
        description: friendly.description,
        duration: Infinity,
        action: {
          label: "Refresh now",
          onClick: () => hardRefresh(),
        },
      });
    };

    window.fetch = async (input, init) => {
      const response = await originalFetch(input as any, init);
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;

        if (
          url.startsWith(supabaseUrl) &&
          url.includes("/auth/v1/") &&
          (response.status === 401 || response.status === 403)
        ) {
          const clone = response.clone();
          const text = await clone.text().catch(() => "");
          if (/legacy api key|api key.*disabled|invalid api key/i.test(text)) {
            showSystemUpdateToast(text);
          }
        }
      } catch {
        // never let the watcher break the app
      }
      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
