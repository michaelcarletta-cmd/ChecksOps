import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isAwsStaging } from "@/lib/awsStaging";
import { useAuth } from "@/hooks/useAuth";
import { CURSOR_TABLES, createCursorPoller, type CursorResults } from "@/lib/liveCursor";
import { createRefreshScheduler, onDataChange } from "@/lib/liveUpdates";

/** One round: per table, the newest timestamp and the row count (tenant-scoped like any list). */
async function readCursor(): Promise<CursorResults> {
  const settled = await Promise.allSettled(CURSOR_TABLES.map(async ({ table, column }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table names come from CURSOR_TABLES
    const { data, count, error } = await (supabase.from(table as any) as any)
      .select(column, { count: "exact" })
      .order(column, { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : null;
    return { count: typeof count === "number" ? count : null, latest: row?.[column] ? String(row[column]) : null };
  }));
  const results: CursorResults = {};
  settled.forEach((result, i) => {
    results[CURSOR_TABLES[i].table] = result.status === "fulfilled" ? result.value : "error";
  });
  return results;
}

/**
 * Other users' changes: while signed in and the tab is visible, poll the change cursor
 * (lib/liveCursor.ts) and refresh the queries on screen when it moves. This tab's own writes
 * are already refreshed by useLiveDataRefresh; they only move the cursor's baseline here.
 */
export function useRemoteChangeCursor() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const signedIn = !!user;

  useEffect(() => {
    // Same switch as useAwsPollingFallback: the AWS adapter has no realtime channel.
    if (!signedIn || !(isAwsStaging() || import.meta.env.MODE === "aws")) return;
    const scheduler = createRefreshScheduler({
      refresh: () => {
        void qc.invalidateQueries({ refetchType: "active" }, { cancelRefetch: false });
      },
    });
    const poller = createCursorPoller({
      read: readCursor,
      onChange: () => scheduler.signal(),
      isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    });
    const poke = () => {
      if (document.visibilityState !== "hidden") poller.poke();
    };
    const offLocal = onDataChange(() => poller.rebase());
    document.addEventListener("visibilitychange", poke);
    window.addEventListener("focus", poke);
    poller.start();
    return () => {
      offLocal();
      document.removeEventListener("visibilitychange", poke);
      window.removeEventListener("focus", poke);
      poller.stop();
      scheduler.cancel();
    };
  }, [qc, signedIn]);
}

export function RemoteChangeCursor() {
  useRemoteChangeCursor();
  return null;
}
