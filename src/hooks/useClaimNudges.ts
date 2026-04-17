import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type NudgeSeverity = "critical" | "high" | "medium" | "low";

export interface ClaimNudgeSummary {
  claimId: string;
  topSeverity: NudgeSeverity;
  count: number;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Fetches active proactive nudges and rolls them up per claim.
 * Returns a map keyed by claim_id with the highest severity + count.
 */
export function useClaimNudges() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["claim-nudges-summary"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_warnings_log")
        .select("claim_id, severity")
        .eq("source", "proactive")
        .eq("is_dismissed", false)
        .eq("is_resolved", false);

      if (error) throw error;

      const byClaim = new Map<string, ClaimNudgeSummary>();
      for (const row of data || []) {
        const sev = (row.severity || "low").toLowerCase() as NudgeSeverity;
        const existing = byClaim.get(row.claim_id);
        if (!existing) {
          byClaim.set(row.claim_id, { claimId: row.claim_id, topSeverity: sev, count: 1 });
        } else {
          existing.count += 1;
          if ((SEVERITY_RANK[sev] ?? 0) > (SEVERITY_RANK[existing.topSeverity] ?? 0)) {
            existing.topSeverity = sev;
          }
        }
      }

      // Totals by severity for the chip filters
      const totals = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const summary of byClaim.values()) {
        totals[summary.topSeverity] += 1;
      }

      return { byClaim, totals };
    },
    staleTime: 30_000,
  });

  // Refresh when warnings change
  useEffect(() => {
    const channel = supabase
      .channel("claim-nudges-summary")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "claim_warnings_log" },
        () => queryClient.invalidateQueries({ queryKey: ["claim-nudges-summary"] })
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return {
    nudgesByClaim: query.data?.byClaim ?? new Map<string, ClaimNudgeSummary>(),
    totals: query.data?.totals ?? { critical: 0, high: 0, medium: 0, low: 0 },
    isLoading: query.isLoading,
  };
}

export function severityRank(sev: NudgeSeverity): number {
  return SEVERITY_RANK[sev] ?? 0;
}

export function severityBadgeClasses(sev: NudgeSeverity): string {
  switch (sev) {
    case "critical":
      return "bg-destructive/15 text-destructive border-destructive/40";
    case "high":
      return "bg-warning/15 text-warning border-warning/40";
    case "medium":
      return "bg-warning/10 text-warning border-warning/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export function severityLabel(sev: NudgeSeverity): string {
  return sev.charAt(0).toUpperCase() + sev.slice(1);
}
