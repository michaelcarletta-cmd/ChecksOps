import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

/**
 * Review row for a check uploaded from a Cash Job: the job's name, linking back
 * to the job. The Command Center is the tenant's "checks" page, a sibling of
 * "cash-jobs" in both white-label route trees, so the link is path-relative.
 */
export function CashJobReviewLink({ cashJobId }: { cashJobId: string }) {
  const { data: job } = useQuery({
    queryKey: ["cash-job-name", cashJobId],
    enabled: !!cashJobId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cash_jobs")
        .select("id, job_name, customer_name")
        .eq("id", cashJobId)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; job_name: string | null; customer_name: string | null } | null;
    },
  });

  const label = job?.job_name || job?.customer_name || "Cash job";
  return (
    <div className="flex justify-between gap-2 text-sm py-1">
      <span className="text-muted-foreground">Cash Job</span>
      <Link
        to={`../cash-jobs?job=${encodeURIComponent(cashJobId)}`}
        relative="path"
        className="font-medium text-primary hover:underline truncate text-right"
      >
        {label}
      </Link>
    </div>
  );
}
