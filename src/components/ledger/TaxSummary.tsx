import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Download, FileText, CheckCircle2, Info } from "lucide-react";
import { startOfYear, endOfYear, getYear } from "date-fns";

const THRESHOLD = 600;
const CURRENT_YEAR = getYear(new Date());
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  operating: "Operating",
  vendor: "Vendor",
  subcontractor: "Subcontractor",
  overhead: "Overhead",
  insured: "Insured",
  contractor: "Contractor",
  supplier: "Supplier",
  other: "Other",
};

const REQUIRES_1099_TYPES = ["subcontractor", "vendor", "other"];

export function TaxSummary() {
  const { tenant } = useTenant();
  const [year, setYear] = useState(CURRENT_YEAR);

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["tax-summary", tenant?.id, year],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("disbursement_splits")
        .select(`
          id, amount, status, created_at,
          stakeholder_accounts (
            id, nickname, custname, account_type, chk_acct
          )
        `)
        .eq("tenant_id", tenant!.id)
        .eq("status", "settled")
        .gte("created_at", startOfYear(new Date(year, 0, 1)).toISOString())
        .lte("created_at", endOfYear(new Date(year, 0, 1)).toISOString());

      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: cashPayments = [] } = useQuery({
    queryKey: ["tax-summary-cash", tenant?.id, year],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("cash_job_payments")
        .select(`id, amount, payment_date, stakeholder_account_id, payee_name,
          stakeholder_accounts:stakeholder_account_id (id, nickname, custname, account_type, chk_acct)`)
        .eq("tenant_id", tenant!.id)
        .not("stakeholder_account_id", "is", null)
        .gte("payment_date", `${year}-01-01`)
        .lte("payment_date", `${year}-12-31`);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: depositedChecks = [] } = useQuery({
    queryKey: ["tax-summary-income", tenant?.id, year],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("check_intake_items")
        .select("id, amount, deposited_at, status")
        .eq("tenant_id", tenant!.id)
        .eq("status", "deposited")
        .gte("deposited_at", startOfYear(new Date(year, 0, 1)).toISOString())
        .lte("deposited_at", endOfYear(new Date(year, 0, 1)).toISOString());
      if (error) throw error;
      return data ?? [];
    },
  });


  const recipients = useMemo(() => {
    const map: Record<string, {
      id: string; nickname: string; custname: string;
      account_type: string; chk_acct: string;
      total: number; payment_count: number;
      requires_1099: boolean; needs_1099: boolean;
    }> = {};

    for (const p of payments as any[]) {
      const acct = p.stakeholder_accounts;
      if (!acct) continue;
      if (!map[acct.id]) {
        map[acct.id] = {
          id: acct.id,
          nickname: acct.nickname,
          custname: acct.custname,
          account_type: acct.account_type,
          chk_acct: acct.chk_acct,
          total: 0,
          payment_count: 0,
          requires_1099: REQUIRES_1099_TYPES.includes(acct.account_type),
          needs_1099: false,
        };
      }
      map[acct.id].total += Number(p.amount);
      map[acct.id].payment_count += 1;
    }

    for (const r of Object.values(map)) {
      r.needs_1099 = r.requires_1099 && r.total >= THRESHOLD;
    }

    for (const p of cashPayments as any[]) {
      const acct = p.stakeholder_accounts;
      if (!acct) continue;
      if (!map[acct.id]) {
        map[acct.id] = {
          id: acct.id,
          nickname: acct.nickname,
          custname: acct.custname,
          account_type: acct.account_type,
          chk_acct: acct.chk_acct,
          total: 0,
          payment_count: 0,
          requires_1099: REQUIRES_1099_TYPES.includes(acct.account_type),
          needs_1099: false,
        };
      }
      map[acct.id].total += Number(p.amount);
      map[acct.id].payment_count += 1;
    }

    for (const r of Object.values(map)) {
      r.needs_1099 = r.requires_1099 && r.total >= THRESHOLD;
    }

    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [payments, cashPayments]);

  const flag1099Count = recipients.filter(r => r.needs_1099).length;
  const totalPaid = recipients.reduce((s, r) => s + r.total, 0);
  const totalSubsPaid = recipients.filter(r => r.account_type === "subcontractor").reduce((s, r) => s + r.total, 0);
  const totalIncome = (depositedChecks as any[]).reduce((s, c) => s + Number(c.amount ?? 0), 0);
  const depositedCount = (depositedChecks as any[]).length;
  const netRetained = totalIncome - totalPaid;
  const payoutRatio = totalIncome > 0 ? (totalPaid / totalIncome) * 100 : 0;


  const exportCSV = () => {
    const headers = ["Recipient Nickname", "Account Holder Name", "Type", "Account (last 4)", `Total Paid ${year}`, "Payment Count", "May Require 1099"];
    const rows = recipients.map(r => [
      r.nickname,
      r.custname,
      ACCOUNT_TYPE_LABELS[r.account_type] ?? r.account_type,
      `••••${r.chk_acct?.slice(-4) ?? ""}`,
      r.total.toFixed(2),
      r.payment_count,
      r.needs_1099 ? "YES" : "No",
    ]);

    const csv = [headers, ...rows].map(row => row.map(v => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `1099_summary_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium">Tax & 1099 Summary</h3>
          <p className="text-xs text-muted-foreground">Recipients paid ${THRESHOLD}+ may require a 1099-NEC filing</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">Includes both insurance disbursements and cash job payments</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="h-8 text-sm w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {YEARS.map(y => (<SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={exportCSV}>
            <Download className="h-3.5 w-3.5 mr-1" />Export for accountant
          </Button>
        </div>
      </div>

      {flag1099Count > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
              {flag1099Count} recipient{flag1099Count !== 1 ? "s" : ""} may require a 1099-NEC for {year}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
              Any subcontractor, vendor, or individual paid $600 or more during the tax year must receive a 1099-NEC by January 31. Share the export below with your accountant.
            </p>
          </div>
        </div>
      )}

      <Card className="border-emerald-500/30 bg-emerald-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Income vs. Disbursements — {year}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <p className="text-[11px] text-muted-foreground">Total income (deposited checks)</p>
            <p className="text-lg font-semibold text-emerald-600">${totalIncome.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
            <p className="text-[10px] text-muted-foreground">{depositedCount} check{depositedCount !== 1 ? "s" : ""} deposited</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Total disbursed</p>
            <p className="text-lg font-semibold">${totalPaid.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
            <p className="text-[10px] text-muted-foreground">to subs, vendors & reps</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Net retained</p>
            <p className={`text-lg font-semibold ${netRetained >= 0 ? "text-foreground" : "text-destructive"}`}>
              ${netRetained.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-muted-foreground">income − disbursements</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Payout ratio</p>
            <p className="text-lg font-semibold">{payoutRatio.toFixed(1)}%</p>
            <p className="text-[10px] text-muted-foreground">disbursed of income</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="pt-3 pb-3 text-center">
          <p className="text-xs text-muted-foreground mb-1">Total paid out</p>
          <p className="text-base font-semibold">${totalPaid.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-3 pb-3 text-center">
          <p className="text-xs text-muted-foreground mb-1">To subcontractors</p>
          <p className="text-base font-semibold">${totalSubsPaid.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-3 pb-3 text-center">
          <p className="text-xs text-muted-foreground mb-1">1099 required</p>
          <p className={`text-base font-semibold ${flag1099Count > 0 ? "text-amber-500" : "text-emerald-500"}`}>{flag1099Count}</p>
        </CardContent></Card>
      </div>


      <div className="rounded-md border bg-muted/30 p-2.5 flex items-start gap-2">
        <Info className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground">
          This summary is for reference only and is not tax advice. 1099 requirements vary based on business structure, payment method, and other factors. Consult your accountant or tax advisor before filing.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />Recipient Breakdown — {year}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
          ) : recipients.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">No settled payments found for {year}.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left p-3 font-medium">Recipient</th>
                    <th className="text-left p-3 font-medium hidden md:table-cell">Type</th>
                    <th className="text-left p-3 font-medium hidden md:table-cell">Account</th>
                    <th className="text-right p-3 font-medium">Total Paid</th>
                    <th className="text-right p-3 font-medium hidden sm:table-cell">Payments</th>
                    <th className="text-center p-3 font-medium">1099</th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.map((r) => (
                    <tr key={r.id} className={`border-b last:border-0 hover:bg-muted/30 transition-colors ${r.needs_1099 ? "bg-amber-500/5" : ""}`}>
                      <td className="p-3">
                        <p className="font-medium text-xs">{r.nickname}</p>
                        <p className="text-[10px] text-muted-foreground">{r.custname}</p>
                      </td>
                      <td className="p-3 hidden md:table-cell">
                        <Badge variant="outline" className="text-[10px]">{ACCOUNT_TYPE_LABELS[r.account_type] ?? r.account_type}</Badge>
                      </td>
                      <td className="p-3 text-xs font-mono text-muted-foreground hidden md:table-cell">••••{r.chk_acct?.slice(-4)}</td>
                      <td className="p-3 text-right">
                        <p className={`font-semibold text-sm ${r.needs_1099 ? "text-amber-600" : ""}`}>
                          ${r.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </p>
                        {r.total >= THRESHOLD * 0.8 && !r.needs_1099 && r.requires_1099 && (
                          <p className="text-[10px] text-muted-foreground">${(THRESHOLD - r.total).toFixed(2)} to threshold</p>
                        )}
                      </td>
                      <td className="p-3 text-right text-xs text-muted-foreground hidden sm:table-cell">{r.payment_count}</td>
                      <td className="p-3 text-center">
                        {r.needs_1099 ? (
                          <div className="flex items-center justify-center gap-1">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                            <span className="text-xs text-amber-600 font-medium">Required</span>
                          </div>
                        ) : r.requires_1099 ? (
                          <span className="text-xs text-muted-foreground">Under $600</span>
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/20">
                    <td colSpan={3} className="p-3 text-xs text-muted-foreground">{recipients.length} recipient{recipients.length !== 1 ? "s" : ""}</td>
                    <td className="p-3 text-right font-semibold text-sm">${totalPaid.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                    <td colSpan={2} className="p-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
