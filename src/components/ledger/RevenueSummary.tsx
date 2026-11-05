import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, DollarSign, Wallet, ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { displayCase } from "@/lib/displayCase";
import { usePaidInvoiceRevenue } from "@/hooks/useWalletOps";
import {
  PAYROLL_FINANCE_QUERY_KEY,
  PAYROLL_SOURCE_LABEL,
  fetchPayrollRuns,
  payrollExpenseTotal,
} from "@/lib/payments/payrollRows";

export function RevenueSummary() {
  const { tenant } = useTenant();

  const { data: revenueData, isLoading: revenueLoading } = useQuery({
    queryKey: ["revenue-summary-incoming", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, amount, status, deposited_at, check_number, carrier_name, claim_id, freedom_claim_number")
        .eq("tenant_id", tenant!.id)
        .in("status", ["deposited", "funds_released"])
        .order("deposited_at", { ascending: false });

      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: disbursementData, isLoading: disbursementLoading } = useQuery({
    queryKey: ["revenue-summary-outgoing", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("disbursement_splits")
        .select("amount, status")
        .eq("tenant_id", tenant!.id)
        .eq("status", "settled");

      if (error) throw error;
      return data ?? [];
    },
  });

  // Payroll sends record payroll_runs, not disbursement_splits; paid payroll is an expense.
  const { data: payrollRuns, isLoading: payrollLoading } = useQuery({
    queryKey: [PAYROLL_FINANCE_QUERY_KEY, "revenue-summary", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: () => fetchPayrollRuns(supabase, tenant!.id),
  });

  // Invoices a customer paid into the wallet are revenue too (no check is deposited for them).
  const { data: paidInvoices, isLoading: invoicesLoading } = usePaidInvoiceRevenue();

  const revenueSources = useMemo(() => {
    const checks = (revenueData ?? []).map((check) => ({
      key: `check-${check.id}`,
      at: check.deposited_at as string | null,
      title: check.freedom_claim_number || displayCase(check.carrier_name) || "—",
      subtitle: check.carrier_name ? displayCase(check.carrier_name) : null,
      reference: check.check_number || "—",
      amount: Number(check.amount || 0),
      status: check.status === "deposited" ? "Deposited" : "Released",
    }));
    const invoices = (paidInvoices ?? []).map((invoice) => ({
      key: `invoice-${invoice.id}`,
      at: invoice.at as string | null,
      title: invoice.customerName || "Invoice payment",
      subtitle: "Invoice payment",
      reference: invoice.invoiceNumber || "—",
      amount: invoice.amountCents / 100,
      status: "Invoice paid",
    }));
    return [...checks, ...invoices].sort(
      (a, b) => (b.at ? new Date(b.at).getTime() : 0) - (a.at ? new Date(a.at).getTime() : 0),
    );
  }, [revenueData, paidInvoices]);

  const stats = useMemo(() => {
    const checkIncoming = revenueData?.reduce((sum, item) => sum + Number(item.amount || 0), 0) || 0;
    const invoiceIncoming = (paidInvoices ?? []).reduce((sum, invoice) => sum + invoice.amountCents, 0) / 100;
    const totalIncoming = checkIncoming + invoiceIncoming;
    const disbursementOutgoing = disbursementData?.reduce((sum, item) => sum + Number(item.amount || 0), 0) || 0;
    const payroll = payrollExpenseTotal(payrollRuns);
    const totalOutgoing = disbursementOutgoing + payroll.total;
    const profit = totalIncoming - totalOutgoing;
    const margin = totalIncoming > 0 ? (profit / totalIncoming) * 100 : 0;

    return { totalIncoming, disbursementOutgoing, payrollOutgoing: payroll.total, payrollCount: payroll.count, totalOutgoing, profit, margin };
  }, [revenueData, paidInvoices, disbursementData, payrollRuns]);

  if (revenueLoading || disbursementLoading || invoicesLoading || payrollLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-[100px]" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-[120px] mb-1" />
              <Skeleton className="h-4 w-[80px]" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Received (Revenue)</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${stats.totalIncoming.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </div>
            <p className="text-xs text-muted-foreground">From deposited checks and paid invoices</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Paid (Expenses)</CardTitle>
            <TrendingDown className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${stats.totalOutgoing.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </div>
            {stats.payrollCount > 0 ? (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p className="flex justify-between gap-2">
                  <span>Settled disbursements</span>
                  <span>${stats.disbursementOutgoing.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                </p>
                <p className="flex justify-between gap-2">
                  <span>{PAYROLL_SOURCE_LABEL}</span>
                  <span>${stats.payrollOutgoing.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Settled disbursements and payroll</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
            <DollarSign className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">
              ${stats.profit.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-xs text-muted-foreground">Retained earnings</p>
              <Badge variant="outline" className="text-[10px] font-mono py-0 h-4">
                {stats.margin.toFixed(1)}% margin
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Wallet className="h-4 w-4" /> Revenue Sources
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left p-3 font-medium">Date Received</th>
                  <th className="text-left p-3 font-medium">Claim / Carrier / Customer</th>
                  <th className="text-left p-3 font-medium">Check / Invoice #</th>
                  <th className="text-right p-3 font-medium">Amount</th>
                  <th className="text-right p-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {revenueSources.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground italic">No deposited checks or paid invoices found.</td>
                  </tr>
                ) : (
                  revenueSources.map((source) => (
                    <tr key={source.key} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                        {source.at ? format(new Date(source.at), "MMM d, yyyy") : "—"}
                      </td>
                      <td className="p-3">
                        <p className="font-medium text-xs">{source.title}</p>
                        {source.subtitle && <p className="text-[10px] text-muted-foreground">{source.subtitle}</p>}
                      </td>
                      <td className="p-3 text-xs font-mono">{source.reference}</td>
                      <td className="p-3 text-right font-medium text-sm text-emerald-600">
                        +${source.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="p-3 text-right">
                        <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
                          {source.status}
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
