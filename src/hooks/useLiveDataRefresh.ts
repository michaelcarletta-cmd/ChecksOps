import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createRefreshScheduler, onDataChange } from "@/lib/liveUpdates";

/**
 * App-wide live updates: after any successful write (in this tab or another tab of the same
 * browser), refetch every query on screen and mark the rest stale, so they refetch when their
 * screen opens. Mounted once, inside QueryClientProvider (App.tsx).
 */
export function useLiveDataRefresh() {
  const qc = useQueryClient();

  useEffect(() => {
    const scheduler = createRefreshScheduler({
      refresh: () => {
        void qc.invalidateQueries({ refetchType: "active" }, { cancelRefetch: false });
      },
    });
    const off = onDataChange(() => scheduler.signal());
    return () => {
      off();
      scheduler.cancel();
    };
  }, [qc]);
}

export function LiveDataRefresh() {
  useLiveDataRefresh();
  return null;
}
