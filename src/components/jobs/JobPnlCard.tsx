import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Calculator } from "lucide-react";
import { usePaidInvoiceRevenue } from "@/hooks/useWalletOps";
import { jobPnlFor, type JobRef } from "@/lib/jobPnl";
import { JOB_PNL_QUERY_KEY, loadJobPnlForJob, withInvoiceClaims } from "@/lib/jobPnlLoad";
import { ChecksPendingChip, JobPnlLines, JobPnlTiles, JobTypeChip } from "@/components/jobs/JobPnlDetail";

/**
 * Job P&L for one insurance job (a claim, or a check case) or cash job: Money in and Money out with
 * where each amount came from, and Revenue / Costs / Profit / Margin. The same calculation as
 * Payments & Financials > Revenue & Profit > By Job (jobPnl.ts). Shown on the owner's own pages
 * only (a partner viewing a shared check does not get it).
 */
export function JobPnlCard({ job }: { job: JobRef }) {
  const { tenant } = useTenant();
  const tenantId = tenant?.id ?? null;

  const { data, isLoading, error } = useQuery({
    queryKey: [JOB_PNL_QUERY_KEY, "job", tenantId, job.kind, job.id],
    enabled: !!tenantId && !!job.id,
    staleTime: 30_000,
    queryFn: () => loadJobPnlForJob(supabase, tenantId!, job),
  });
  // Paid invoices: the Totals view's own list and rules; only this claim's count here.
  const { data: paidInvoices } = usePaidInvoiceRevenue();

  const summary = useMemo(() => {
    if (!data) return null;
    const invoices = job.kind === "claim"
      ? withInvoiceClaims(paidInvoices, data.invoiceClaims).filter((invoice) => invoice.claimId === job.id)
      : [];
    return jobPnlFor({ ...data, invoices }, job);
  }, [data, paidInvoices, job]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calculator className="h-4 w-4" /> Job P&amp;L
          </CardTitle>
          {summary && (
            <div className="flex items-center gap-1.5">
              <JobTypeChip type={summary.type} />
              <ChecksPendingChip count={summary.pendingCount} amount={summary.pendingAmount} />
            </div>
          )}
        </div>
        {summary && (
          <p className="text-xs text-muted-foreground">
            {summary.name}{summary.subtitle ? ` · ${summary.subtitle}` : ""}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error || !summary ? (
          <p className="text-xs text-muted-foreground">The job's P&amp;L could not be loaded. Try again in a moment.</p>
        ) : (
          <>
            <JobPnlTiles revenue={summary.revenue} costs={summary.costs} profit={summary.profit} margin={summary.margin} />
            <JobPnlLines job={summary} />
            <p className="text-[11px] text-muted-foreground">
              Revenue counts checks once deposited or released; pending checks are not counted. Payroll and other
              company-wide costs are not allocated to jobs.
              {data?.incomplete ? " This job has more checks than could be loaded; figures may be incomplete." : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
