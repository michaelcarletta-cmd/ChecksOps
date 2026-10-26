import { useEffect } from "react";
import { isAwsStaging } from "@/lib/awsStaging";

/**
 * AWS staging has no Supabase Realtime websocket. When Cognito staging is active,
 * poll/refetch on an interval so ordinary UI freshness still works.
 * Production (Supabase) keeps realtime channels and skips this fallback.
 */
export function useAwsPollingFallback(
  enabled: boolean,
  onTick: () => void,
  intervalMs = 15_000,
) {
  useEffect(() => {
    // `vite build --mode aws` always uses the AWS adapter (whose realtime
    // channel is a no-op), even if VITE_AUTH_PROVIDER were left unset.
    if (!enabled || !(isAwsStaging() || import.meta.env.MODE === "aws")) return;
    const tick = () => {
      // A hidden tab does not poll; it catches up the moment it is shown again.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        onTick();
      } catch {
        /* ignore polling errors */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    const id = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, onTick, intervalMs]);
}
