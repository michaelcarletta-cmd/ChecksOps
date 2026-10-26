import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  checkNumberQueryValues,
  findDuplicateChecks,
  type DuplicateCandidate,
} from "@/lib/duplicateChecks";

const DUPLICATE_COLUMNS = "id, check_number, amount, carrier_name, status, check_stage, created_at, deposited_at";

/**
 * Duplicate flags for the checks on screen: each one is compared with every check in the tenant
 * that has the same check number, including deposited and archived ones (src/lib/duplicateChecks.ts).
 */
export function useDuplicateChecks(tenantId: string | null | undefined, rows: DuplicateCandidate[]) {
  const values = useMemo(() => checkNumberQueryValues(rows.map((r) => r.check_number)), [rows]);

  const { data: matches = [] } = useQuery({
    queryKey: ["check-duplicates", tenantId, values],
    enabled: !!tenantId && values.length > 0,
    queryFn: async () => {
      const found: DuplicateCandidate[] = [];
      // Keep each request's filter list short.
      for (let i = 0; i < values.length; i += 100) {
        const { data, error } = await supabase
          .from("check_intake_items")
          .select(DUPLICATE_COLUMNS)
          .eq("tenant_id", tenantId!)
          .in("check_number", values.slice(i, i + 100))
          .limit(2000);
        if (error) throw error;
        found.push(...((data ?? []) as DuplicateCandidate[]));
      }
      return found;
    },
  });

  return useMemo(() => findDuplicateChecks([...rows, ...matches]), [rows, matches]);
}
