import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ClaimMicrotask } from "@/services/claimOperationsService";

/**
 * Fetches only immediate + blocking microtasks across all claims
 * for the lightweight "Needs Action Now" strip.
 */
export function useGlobalImmediateMicrotasks() {
  return useQuery({
    queryKey: ["global-immediate-microtasks"],
    queryFn: async (): Promise<(ClaimMicrotask & { claim_number?: string; policyholder_name?: string })[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];

      const { data, error } = await supabase
        .from("claim_microtasks")
        .select("*, claims(claim_number, policyholder_name)")
        .in("status", ["pending", "in_progress"])
        .or("priority.eq.immediate,is_blocking.eq.true")
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) {
        console.error("[GlobalImmediateMicrotasks] fetch error", error);
        return [];
      }

      return (data || []).map((d: any) => ({
        ...d,
        claim_number: d.claims?.claim_number,
        policyholder_name: d.claims?.policyholder_name,
      }));
    },
    refetchInterval: 30000,
  });
}
