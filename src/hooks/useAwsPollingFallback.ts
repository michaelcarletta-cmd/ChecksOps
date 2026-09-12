import { useEffect } from "react";
import { isAwsAuth } from "@/lib/awsStaging";

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
    if (!enabled || !isAwsAuth()) return;
    const id = window.setInterval(() => {
      try {
        onTick();
      } catch {
        /* ignore polling errors */
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, onTick, intervalMs]);
}
