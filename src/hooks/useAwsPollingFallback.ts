import { useEffect } from "react";
import { isAwsDataPlane } from "@/lib/awsStaging";

/**
 * AWS data plane has no Supabase Realtime websocket. When the AWS adapter is
 * active, poll/refetch on an interval so ordinary UI freshness still works.
 * Supabase data (including Cognito-auth + Supabase-data) keeps realtime.
 */
export function useAwsPollingFallback(
  enabled: boolean,
  onTick: () => void,
  intervalMs = 15_000,
) {
  useEffect(() => {
    if (!enabled || !isAwsDataPlane()) return;
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
