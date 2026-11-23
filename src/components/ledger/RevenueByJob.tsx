import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Briefcase, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { buildJobPnl, type JobPnlCheck, type JobPnlInput, type JobPnlOtherRevenue, type JobPnlSplit, type JobRef } from "@/lib/jobPnl";
import { JOB_PNL_QUERY_KEY, loadJobPnlNames, loadJobPnlTenantRows, withInvoiceClaims } from "@/lib/jobPnlLoad";
import type { SendLeg } from "@/lib/payments/transferFinanceRows";
import {
  ChecksPendingChip,
  JobPnlLines,
  JobPnlTiles,
  JobTypeChip,
  marginLabel,
  money,
  signedMoney,
} from "@/components/jobs/JobPnlDetail";

type PaidInvoice = { id: string; at: string | null; invoiceNumber: string | null; customerName: string | null; amountCents: number };

interface Props {
  /** The Totals view's deposited / funds-released checks, with the insured name already resolved. */
  countedChecks: JobPnlCheck[];
  /** The Totals view's settled splits. */
  splits: JobPnlSplit[] | null | undefined;
  paidInvoices: PaidInvoice[] | null | undefined;
  sentLegs: SendLeg[] | null | undefined;
  /** The Totals view's partner payments into the wallet (never one of this organization's jobs). */
  partnerPayments: JobPnlOtherRevenue[];
  /** The Totals view's payroll and payroll speed fees: company-wide, not allocated to jobs. */
  payrollNotAllocated: number;
}

/**
 * Revenue & Profit > By Job: the same money as Totals, one row per insurance job (claim or check
 * case) and cash job, with an Unassigned row for money linked to neither. The math is jobPnl.ts,
 * shared with the Job P&L card on a claim's Funds tab and on a cash job.
 */
export function RevenueByJob({ countedChecks, splits, paidInvoices, sentLegs, partnerPayments, payrollNotAllocated }: Props) {
  const { tenant } = useTenant();
  const [open, setOpen] = useState<string | null>(null);

  const { data: extra, isLoading, error } = useQuery({
    queryKey: [JOB_PNL_QUERY_KEY, "tenant-rows", tenant?.id],
    enabled: !!tenant?.id,
    staleTime: 30_000,
    queryFn: () => loadJobPnlTenantRows(supabase, tenant!.id),
  });

  const input = useMemo<JobPnlInput>(() => ({
    checks: [...countedChecks, ...(extra?.pendingChecks ?? [])],
    invoices: withInvoiceClaims(paidInvoices, extra?.invoiceClaims),
    cashPayments: extra?.cashPayments ?? [],
    splits: splits ?? [],
    sends: sentLegs ?? [],
    fees: extra?.fees ?? [],
    // Step 3: job expenses entered by hand go here.
    expenses: [],
    otherRevenue: partnerPayments,
  }), [countedChecks, extra, paidInvoices, splits, sentLegs, partnerPayments]);

  const refs = useMemo(
    () => buildJobPnl(input).jobs.map((job) => job.ref).filter((ref): ref is JobRef => !!ref),
    [input],
  );
  const refsKey = refs.map((r) => `${r.kind}:${r.id}`).sort().join(",");
  const { data: names } = useQuery({
    queryKey: [JOB_PNL_QUERY_KEY, "names", tenant?.id, refsKey],
    enabled: !!tenant?.id && refs.length > 0,
    staleTime: 5 * 60_000,
    queryFn: () => loadJobPnlNames(supabase, refs),
  });

  const result = useMemo(() => buildJobPnl({ ...input, ...(names ?? {}) }), [input, names]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          The job breakdown could not be loaded. The Totals view is unaffected; try again in a moment.
        </CardContent>
      </Card>
    );
  }

  const { totals, reconciliation } = result;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <div className="rounded-md border bg-background p-3">
          <p className="text-xs text-muted-foreground">Jobs</p>
          <p className="text-lg font-semibold">{totals.jobCount}</p>
          {totals.pendingCount > 0 && (
            <p className="text-[11px] text-amber-600">{totals.pendingCount} check{totals.pendingCount === 1 ? "" : "s"} pending · {money(totals.pendingAmount)}</p>
          )}
        </div>
        <div className="col-span-1 md:col-span-4">
          <JobPnlTiles revenue={totals.revenue} costs={totals.costs} profit={totals.profit} margin={totals.margin} />
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Briefcase className="h-4 w-4" /> By Job
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-3 text-left font-medium">Job</th>
                  <th className="p-3 text-left font-medium">Type</th>
                  <th className="p-3 text-right font-medium">Revenue</th>
                  <th className="p-3 text-right font-medium">Costs</th>
                  <th className="p-3 text-right font-medium">Profit</th>
                  <th className="p-3 text-right font-medium">Margin</th>
                </tr>
              </thead>
              <tbody>
                {result.jobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center italic text-muted-foreground">No job money yet.</td>
                  </tr>
                ) : (
                  result.jobs.map((job) => {
                    const expanded = open === job.key;
                    return (
                      <Fragment key={job.key}>
                        <tr
                          className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/30"
                          onClick={() => setOpen(expanded ? null : job.key)}
                          aria-expanded={expanded}
                        >
                          <td className="p-3">
                            <div className="flex items-start gap-1.5">
                              {expanded ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                              <div className="min-w-0">
                                <p className="text-xs font-medium">{job.name}</p>
                                {job.subtitle && <p className="text-[10px] text-muted-foreground">{job.subtitle}</p>}
                                <div className="mt-1"><ChecksPendingChip count={job.pendingCount} amount={job.pendingAmount} /></div>
                              </div>
                            </div>
                          </td>
                          <td className="p-3"><JobTypeChip type={job.type} /></td>
                          <td className="p-3 text-right text-emerald-600">{money(job.revenue)}</td>
                          <td className="p-3 text-right text-rose-600">{money(job.costs)}</td>
                          <td className={`p-3 text-right font-medium ${job.profit < 0 ? "text-rose-600" : ""}`}>{signedMoney(job.profit)}</td>
                          <td className="p-3 text-right font-mono text-xs">{marginLabel(job.margin)}</td>
                        </tr>
                        {expanded && (
                          <tr className="border-b bg-muted/20">
                            <td colSpan={6} className="p-3">
                              {job.ref?.kind === "cash_job" && (
                                <Link
                                  to={`../cash-jobs?job=${encodeURIComponent(job.ref.id)}`}
                                  relative="path"
                                  className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                >
                                  Open cash job <ExternalLink className="h-3 w-3" />
                                </Link>
                              )}
                              <JobPnlLines job={job} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
              {result.jobs.length > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/20 text-sm font-semibold">
                    <td className="p-3" colSpan={2}>All jobs</td>
                    <td className="p-3 text-right text-emerald-600">{money(totals.revenue)}</td>
                    <td className="p-3 text-right text-rose-600">{money(totals.costs)}</td>
                    <td className="p-3 text-right">{signedMoney(totals.profit)}</td>
                    <td className="p-3 text-right font-mono text-xs">{marginLabel(totals.margin)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Revenue counts checks once they are deposited or funds are released (the same rule as Totals); checks still in
          process show as "Checks pending" and are not counted. Click a job to see where each amount came from.
        </p>
        <p>
          Payroll and other company-wide costs are not allocated to jobs
          {payrollNotAllocated > 0 ? ` (${money(payrollNotAllocated)} of payroll and payroll speed fees)` : ""}; the Totals view
          still includes them.
          {reconciliation.fees > 0 ? ` Job costs include ChecksOps fees (${money(reconciliation.fees)}), which Totals does not count.` : ""}
          {reconciliation.cashPaymentsRevenue > 0
            ? ` Revenue includes cash-job payments not tied to a deposited check (${money(reconciliation.cashPaymentsRevenue)}), which Totals does not count.`
            : ""}
          {" "}Money not linked to a claim or cash job is in the Unassigned row.
        </p>
        {extra?.unavailable.length ? (
          <p className="text-amber-600">Not included (could not be read): {extra.unavailable.join(", ")}.</p>
        ) : null}
        {extra?.incomplete ? (
          <p className="text-amber-600">Some lists were longer than could be loaded; figures may be incomplete.</p>
        ) : null}
      </div>
    </div>
  );
}
