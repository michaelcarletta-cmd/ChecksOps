import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type ReferralAlertType = "needs_contractor" | "needs_public_adjuster" | "needs_attorney";

export interface ReferralAlert {
  id: string;
  claim_id: string;
  alert_type: ReferralAlertType;
  trigger_reason: string;
  message: string | null;
  is_dismissed: boolean;
  is_actioned: boolean;
  created_at: string;
}

export function useReferralAlerts(claimId: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["referral-alerts", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("referral_alerts")
        .select("*")
        .eq("claim_id", claimId)
        .eq("is_dismissed", false)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data || []) as ReferralAlert[];
    },
    enabled: !!claimId && !!user?.id,
  });

  // Realtime refresh
  useEffect(() => {
    if (!claimId) return;
    const channel = supabase
      .channel(`referral-alerts-${claimId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "referral_alerts", filter: `claim_id=eq.${claimId}` },
        () => queryClient.invalidateQueries({ queryKey: ["referral-alerts", claimId] })
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [claimId, queryClient]);

  const dismissAlert = async (alertId: string) => {
    await supabase
      .from("referral_alerts")
      .update({ is_dismissed: true })
      .eq("id", alertId);
    queryClient.invalidateQueries({ queryKey: ["referral-alerts", claimId] });
  };

  const markActioned = async (alertId: string) => {
    await supabase
      .from("referral_alerts")
      .update({ is_actioned: true, actioned_at: new Date().toISOString() })
      .eq("id", alertId);
    queryClient.invalidateQueries({ queryKey: ["referral-alerts", claimId] });
  };

  return {
    alerts: query.data || [],
    isLoading: query.isLoading,
    dismissAlert,
    markActioned,
  };
}
