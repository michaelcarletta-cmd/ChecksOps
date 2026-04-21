import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ClaimBoardEntry, ClaimOperationalState } from "@/services/claimOperationsService";

/**
 * Fetches all active claims joined with their operational state
 * for the Claims Control Board.
 */
export function useClaimControlBoard() {
  const queryClient = useQueryClient();

  // Realtime subscription: refetch when microtasks change
  useEffect(() => {
    const channel = supabase
      .channel("control-board-microtasks")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "claim_microtasks" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["claim-control-board"] });
          queryClient.invalidateQueries({ queryKey: ["global-immediate-microtasks"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return useQuery({
    queryKey: ["claim-control-board"],
    queryFn: async (): Promise<ClaimBoardEntry[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];

      // Fetch active claims with operational state
      const { data: claims, error } = await supabase
        .from("claims")
        .select(`
          id,
          claim_number,
          policyholder_name,
          policyholder_address,
          insurance_company,
          status,
          claim_operational_state (*)
        `)
        .not("status", "in", '("Claim Settled","Dead File","Closed")')
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) {
        console.error("[ClaimControlBoard] fetch error", error);
        return [];
      }

      // Fetch microtask counts per claim
      const claimIds = (claims || []).map((c: any) => c.id);
      let microtaskCounts: Record<string, { immediate: number; blocking: number }> = {};

      if (claimIds.length > 0) {
        const { data: microtasks } = await supabase
          .from("claim_microtasks")
          .select("claim_id, priority, is_blocking")
          .in("claim_id", claimIds)
          .in("status", ["pending", "in_progress"]);

        if (microtasks) {
          for (const mt of microtasks) {
            if (!microtaskCounts[mt.claim_id]) {
              microtaskCounts[mt.claim_id] = { immediate: 0, blocking: 0 };
            }
            if (mt.priority === "immediate") microtaskCounts[mt.claim_id].immediate++;
            if (mt.is_blocking) microtaskCounts[mt.claim_id].blocking++;
          }
        }
      }

      return (claims || []).map((c: any) => ({
        claim_id: c.id,
        claim_number: c.claim_number,
        policyholder_name: c.policyholder_name,
        property_address: c.policyholder_address,
        insurance_carrier: c.insurance_company,
        status: c.status,
        sub_status: null,
        ops: c.claim_operational_state?.[0] || c.claim_operational_state || null,
        immediate_microtasks: microtaskCounts[c.id]?.immediate || 0,
        blocking_microtasks: microtaskCounts[c.id]?.blocking || 0,
      }));
    },
    refetchInterval: 60000,
  });
}
