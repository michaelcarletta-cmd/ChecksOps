import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAwsPollingFallback } from "@/hooks/useAwsPollingFallback";
import {
  isQueueListInvalidation,
  refreshCheckQueues,
  refreshQueueDependents,
  shouldRefreshOnFocus,
} from "@/lib/checkQueueRefresh";

/**
 * Consolidated realtime subscription for the Check Command Center.
 *
 * Reflects check status/stage changes immediately without manual refresh.
 * Debounces invalidations so bursts of events (bulk decisions, webhook
 * fan-out, endorsement composites) coalesce into a single refetch instead
 * of hammering the queue query.
 *
 * NOTE: check_endorsements has no tenant_id, so we don't subscribe here.
 * The per-check detail view subscribes scoped by check_id.
 *
 * AWS backend (staging and production `--mode aws` builds): the adapter's
 * realtime channel is a no-op, so nothing above ever fires. Instead the queue
 * and every lane count refetch every 5s while the tab is visible, and again when the browser tab
 * regains focus (throttled to once per 10s). Every query root is refreshed
 * together, including the lane badge totals ("check-stage-totals"), which
 * previously stayed stale until a full page reload.
 *
 * Any invalidation of the queue list ("check-intake-items") — the upload
 * dialog, review decisions, deletes and other call sites that only refresh
 * the list — also refreshes the lane counts, so they never drift apart.
 */
export function useCheckCommandRealtime(tenantId: string | null | undefined) {
  const qc = useQueryClient();
  const lastRefreshAt = useRef(0);

  const poll = useCallback(() => {
    if (!tenantId) return;
    lastRefreshAt.current = Date.now();
    void refreshCheckQueues(qc);
  }, [qc, tenantId]);

  useAwsPollingFallback(!!tenantId, poll, 5_000);

  useEffect(() => {
    if (!tenantId) return;
    let queued = false;
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (!isQueueListInvalidation(event as any) || queued) return;
      // Coalesce a burst of list invalidations into one dependent refresh.
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void refreshQueueDependents(qc);
      });
    });
    return unsubscribe;
  }, [qc, tenantId]);

  // Refresh when the user comes back to the tab, so checks uploaded by other
  // users, homeowners or other devices show up without a page reload.
  useEffect(() => {
    if (!tenantId || typeof window === "undefined") return;
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!shouldRefreshOnFocus(lastRefreshAt.current, Date.now())) return;
      poll();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [tenantId, poll]);

  useEffect(() => {
    if (!tenantId) return;

    let pendingAll = false;
    const pendingDetailIds = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const ids = Array.from(pendingDetailIds);
      pendingDetailIds.clear();
      if (pendingAll) {
        pendingAll = false;
        lastRefreshAt.current = Date.now();
        void refreshCheckQueues(qc);
      }
      for (const id of ids) {
        qc.invalidateQueries({ queryKey: ["check-detail", id] });
      }
    };

    const schedule = (detailId?: string | null) => {
      pendingAll = true;
      if (detailId) pendingDetailIds.add(detailId);
      if (timer) return;
      timer = setTimeout(flush, 250);
    };

    const channel = supabase
      .channel(`check-command-center-${tenantId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "check_intake_items", filter: `tenant_id=eq.${tenantId}` },
        (payload: any) => {
          const id = payload?.new?.id ?? payload?.old?.id;
          schedule(id);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "check_files", filter: `tenant_id=eq.${tenantId}` },
        () => {
          schedule();
        },
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [tenantId, qc]);
}
