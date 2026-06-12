import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";

export function GlobalPaymentStatusBanner() {
  const { tenantId } = useTenantFilter();

  const { data } = useQuery({
    queryKey: ["global-payment-status", tenantId],
    enabled: !!tenantId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("disbursement_splits")
        .select("status")
        .eq("tenant_id", tenantId)
        .in("status", ["submitted", "settled", "returned", "failed"]);
      if (error) throw error;
      const counts = { submitted: 0, settled: 0, returned: 0 };
      for (const r of data ?? []) {
        if (r.status === "submitted") counts.submitted++;
        else if (r.status === "settled") counts.settled++;
        else if (r.status === "returned" || r.status === "failed") counts.returned++;
      }
      return counts;
    },
  });

  if (!data) return null;
  const { submitted, settled, returned } = data;
  if (!submitted && !settled && !returned) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-2 text-xs">
      {returned > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/10 text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          {returned} payment{returned > 1 ? "s" : ""} returned — action required
        </div>
      )}
      {submitted > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Clock className="h-3.5 w-3.5" />
          {submitted} payment{submitted > 1 ? "s" : ""} in transit
        </div>
      )}
      {settled > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {settled} payment{settled > 1 ? "s" : ""} settled
        </div>
      )}
    </div>
  );
}
