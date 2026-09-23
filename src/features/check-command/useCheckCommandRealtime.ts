import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAwsPollingFallback } from "@/hooks/useAwsPollingFallback";

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
 * AWS staging: Supabase realtime is a no-op — poll/refetch every 15s.
 */
export function useCheckCommandRealtime(tenantId: string | null | undefined) {
  const qc = useQueryClient();

  const poll = useCallback(() => {
    if (!tenantId) return;
    qc.invalidateQueries({ queryKey: ["check-intake-items"] });
    qc.invalidateQueries({ queryKey: ["check-review-queue"] });
    qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
    qc.invalidateQueries({ queryKey: ["loss-draft-counts", tenantId] });
  }, [qc, tenantId]);

  useAwsPollingFallback(!!tenantId, poll, 15_000);

  useEffect(() => {
    if (!tenantId) return;

    const pending = new Set<string>();
    const pendingDetailIds = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const keys = Array.from(pending);
      pending.clear();
      const ids = Array.from(pendingDetailIds);
      pendingDetailIds.clear();
      for (const k of keys) {
        if (k === "loss-draft-counts") {
          qc.invalidateQueries({ queryKey: ["loss-draft-counts", tenantId] });
        } else {
          qc.invalidateQueries({ queryKey: [k] });
        }
      }
      for (const id of ids) {
        qc.invalidateQueries({ queryKey: ["check-detail", id] });
      }
    };

    const schedule = (keys: string[], detailId?: string | null) => {
      for (const k of keys) pending.add(k);
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
          schedule(
            ["check-intake-items", "check-review-queue", "check-dashboard-counts", "loss-draft-counts"],
            id,
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "check_files", filter: `tenant_id=eq.${tenantId}` },
        () => {
          schedule(["check-intake-items", "check-review-queue", "check-dashboard-counts"]);
        },
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [tenantId, qc]);
}
