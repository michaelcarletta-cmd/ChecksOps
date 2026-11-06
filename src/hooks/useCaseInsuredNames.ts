import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * check_cases.insured_name for a set of case ids (read only), the same lookup the Deposited
 * Checks report uses. Feeds depositCustomerName when a check's insured comes from its case.
 */
export function useCaseInsuredNames(caseIds: string[], scope: string) {
  const { data = new Map<string, string | null>() } = useQuery({
    queryKey: ["case-insured-names", scope, caseIds.join(",")],
    enabled: caseIds.length > 0,
    queryFn: async () => {
      const map = new Map<string, string | null>();
      for (let i = 0; i < caseIds.length; i += 200) {
        const { data: rows, error } = await supabase
          .from("check_cases")
          .select("id, insured_name")
          .in("id", caseIds.slice(i, i + 200));
        if (error) throw error;
        for (const row of (rows ?? []) as { id: string; insured_name: string | null }[]) map.set(row.id, row.insured_name);
      }
      return map;
    },
  });
  return data;
}
