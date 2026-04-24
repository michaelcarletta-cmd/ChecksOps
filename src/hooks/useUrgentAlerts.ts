import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface UrgentAlert {
  id: string;
  claim_id: string;
  claim_number: string | null;
  policyholder_name: string | null;
  reason: "escalation" | "high_pressure";
  label: string;
  pressure_score: number;
  created_at: string;
}

const PRESSURE_THRESHOLD = 60;

export function useUrgentAlerts() {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const prevCountRef = useRef(0);

  const query = useQuery({
    queryKey: ["urgent-alerts"],
    queryFn: async (): Promise<UrgentAlert[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];

      const alerts: UrgentAlert[] = [];

      // 1. Escalation claims
      const { data: escalated } = await supabase
        .from("claim_operational_state")
        .select("claim_id, pressure_score, follow_up_status, updated_at")
        .eq("follow_up_status", "escalation");

      // 2. High pressure claims
      const { data: highPressure } = await supabase
        .from("claim_operational_state")
        .select("claim_id, pressure_score, follow_up_status, updated_at")
        .gte("pressure_score", PRESSURE_THRESHOLD)
        .neq("follow_up_status", "escalation"); // avoid duplicates

      // Get claim details for all relevant claim IDs
      const claimIds = new Set<string>();
      escalated?.forEach(e => claimIds.add(e.claim_id));
      highPressure?.forEach(e => claimIds.add(e.claim_id));

      const ids = Array.from(claimIds);
      if (ids.length === 0) return [];

      const { data: claims } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name")
        .in("id", ids);

      const claimMap = new Map(claims?.map(c => [c.id, c]) || []);

      escalated?.forEach(e => {
        const c = claimMap.get(e.claim_id);
        alerts.push({
          id: `esc-${e.claim_id}`,
          claim_id: e.claim_id,
          claim_number: c?.claim_number || null,
          policyholder_name: c?.policyholder_name || null,
          reason: "escalation",
          label: `${c?.policyholder_name || "Claim"} needs escalation`,
          pressure_score: e.pressure_score || 0,
          created_at: e.updated_at,
        });
      });

      highPressure?.forEach(e => {
        const c = claimMap.get(e.claim_id);
        alerts.push({
          id: `hp-${e.claim_id}`,
          claim_id: e.claim_id,
          claim_number: c?.claim_number || null,
          policyholder_name: c?.policyholder_name || null,
          reason: "high_pressure",
          label: `${c?.policyholder_name || "Claim"} — pressure ${e.pressure_score}`,
          pressure_score: e.pressure_score || 0,
          created_at: e.updated_at,
        });
      });

      // Sort by pressure desc, then date
      alerts.sort((a, b) => b.pressure_score - a.pressure_score || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      return alerts;
    },
    refetchInterval: 60000,
  });

  const activeAlerts = (query.data || []).filter(a => !dismissed.has(a.id));

  // Toast on new alerts
  useEffect(() => {
    if (activeAlerts.length > prevCountRef.current && prevCountRef.current > 0) {
      const newCount = activeAlerts.length - prevCountRef.current;
      toast.warning(`${newCount} new urgent alert${newCount > 1 ? "s" : ""}`, {
        description: "Check the notification bell for details",
        duration: 6000,
      });
    }
    prevCountRef.current = activeAlerts.length;
  }, [activeAlerts.length]);

  const dismiss = useCallback((id: string) => {
    setDismissed(prev => new Set(prev).add(id));
  }, []);

  const dismissAll = useCallback(() => {
    setDismissed(new Set((query.data || []).map(a => a.id)));
  }, [query.data]);

  return {
    alerts: activeAlerts,
    totalCount: activeAlerts.length,
    isLoading: query.isLoading,
    dismiss,
    dismissAll,
    refetch: query.refetch,
  };
}
