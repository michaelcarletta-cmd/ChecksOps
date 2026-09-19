import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { PayoutOrchestratorPlan } from "@/lib/payoutOrchestrator";

export function usePayoutOrchestrator() {
  return useMutation({
    mutationFn: async (tenantId: string) => {
      const { data, error } = await supabase.functions.invoke("moov-payout-orchestrate", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      if ((data as any)?.ok === false) {
        throw new Error((data as any)?.message || (data as any)?.error || "Payout plan failed");
      }
      return data as PayoutOrchestratorPlan;
    },
  });
}
