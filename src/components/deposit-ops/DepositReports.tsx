import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Printer, Download, FileText, FileSpreadsheet } from "lucide-react";
import { format } from "date-fns";
import { useTenant } from "@/contexts/TenantContext";
import { toast } from "sonner";
import {
  buildDepositedCheckRows,
  depositedChecksTitle,
  depositedChecksTotal,
  formatReportDay,
  formatReportMoney,
  type DepositedCheckSource,
} from "@/lib/depositedChecksReport";


const fmtMoney = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00";

const providerLabels: Record<string, string> = {
  checkalt: "ChecksOps",
  checksops: "ChecksOps",
  fincapture: "ChecksOps",
  manual_branch: "Bank",
  branch: "Bank",
  mobile: "Bank",
  mobile_deposit: "Bank",
  internal_ready: "Bank",
  synctera: "Bank",
  treasury_prime: "Bank",
};

const providerLabel = (p: string | null | undefined) => {
  if (!p) return "—";
  return providerLabels[p] ?? "Bank";
};


interface TenantDepositItem {
  id: string;
  amount: number | null;
  provider: string | null;
  check_number: string | null;
  carrier_name: string | null;
  bank_reference: string | null;
  status: string;
  created_at: string;
  cleared_at: string | null;
  bank_confirmed_at: string | null;
  reconciled_at: string | null;
  reconciled_amount: number | null;
  nsf_flag: boolean | null;
  variance_amount: number | null;
  variance_reason: string | null;
  return_reason: string | null;
  exception_reason: string | null;
}

function exportCSV(rows: Record<string, unknown>[], filename: string) {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(","), ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function DailyDepositLog({ logs }: { logs: Record<string, unknown>[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />Daily Deposit Log
          </CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => window.print()}>
              <Printer className="h-3 w-3 mr-1" />Print
            </Button>
            <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => exportCSV(logs, `deposit-log-${format(new Date(), "yyyy-MM-dd")}.csv`)}>
              <Download className="h-3 w-3 mr-1" />CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[560px] overflow-y-auto overflow-x-auto">
          {logs.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No deposit activity</div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{row.deposit_date ? format(new Date(row.deposit_date as string), "MMM d, yyyy") : "—"}</TableCell>
                    <TableCell className="text-xs">{providerLabel(row.provider as string)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(row.total_amount as number)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>

    </Card>
  );
}




const DEPOSITED_CHECKS_LIMIT = 5000;

/** Start of a local day and the start of the next one, as ISO timestamps. */
const localDayBounds = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return { start: new Date(y, m - 1, d).toISOString(), next: new Date(y, m - 1, d + 1).toISOString() };
};

/**
 * Deposited Checks (owner, 2026-10-26): insured name, date deposited, amount, check # and
 * claim # for every deposited check, for one date, a range or all dates, as PDF or Excel.
 */
function DepositedChecksReport() {
  const { tenantId } = useTenantFilter();
  const { tenant } = useTenant();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);

  // Server-side bounds keep a long history from hitting the row limit; the exact day rule is
  // applied again on the client (bankDepositDayInRange through buildDepositedCheckRows).
  const [lo, hi] = fromDate && toDate && toDate < fromDate ? [toDate, fromDate] : [fromDate, toDate];
  const startIso = lo ? localDayBounds(lo).start : null;
  const endIso = hi ? localDayBounds(hi).next : lo && !hi ? localDayBounds(lo).next : null;

  const { data: checks = [], isLoading } = useQuery({
    queryKey: ["deposited-checks-report", tenantId, startIso, endIso],
    enabled: !!tenantId,
    queryFn: async () => {
      let query = supabase
        .from("check_intake_items")
        .select(
          "id, check_number, amount, deposited_at, detected_claim_number, freedom_claim_number, case_id, claims(claim_number, policyholder_name), check_payees(payee_name, payee_type)",
        )
        .eq("tenant_id", tenantId as string)
        .not("deposited_at", "is", null);
      if (startIso) query = query.gte("deposited_at", startIso);
      if (endIso) query = query.lt("deposited_at", endIso);
      const { data, error } = await query.order("deposited_at", { ascending: false }).limit(DEPOSITED_CHECKS_LIMIT);
      if (error) throw error;
      return (data ?? []) as unknown as DepositedCheckSource[];
    },
  });

  const caseIds = useMemo(
    () => Array.from(new Set(checks.map((c) => c.case_id).filter((id): id is string => Boolean(id)))).sort(),
    [checks],
  );
  const { data: caseNames = new Map<string, string | null>() } = useQuery({
    queryKey: ["deposited-checks-report-cases", caseIds.join(",")],
    enabled: caseIds.length > 0,
    queryFn: async () => {
      const map = new Map<string, string | null>();
      for (let i = 0; i < caseIds.length; i += 200) {
        const { data, error } = await supabase
          .from("check_cases")
          .select("id, insured_name")
          .in("id", caseIds.slice(i, i + 200));
        if (error) throw error;
        for (const row of (data ?? []) as { id: string; insured_name: string | null }[]) map.set(row.id, row.insured_name);
      }
      return map;
    },
  });

  const rows = useMemo(() => buildDepositedCheckRows(checks, caseNames, fromDate, toDate), [checks, caseNames, fromDate, toDate]);
  const total = depositedChecksTotal(rows);
  const title = depositedChecksTitle(fromDate, toDate);
  const fileBase = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const truncated = checks.length >= DEPOSITED_CHECKS_LIMIT;

  const exportReport = async (kind: "pdf" | "xlsx") => {
    setExporting(kind);
    try {
      const { depositedChecksPdf, depositedChecksXlsx, downloadReportFile } = await import("@/lib/depositedChecksExport");
      if (kind === "pdf") {
        downloadReportFile(depositedChecksPdf(rows, title, tenant?.name ?? ""), `${fileBase}.pdf`, "application/pdf");
      } else {
        downloadReportFile(
          depositedChecksXlsx(rows, title),
          `${fileBase}.xlsx`,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
      }
    } catch (error) {
      toast.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />Deposited Checks
          </CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="text-xs h-7" disabled={!!exporting || isLoading} onClick={() => exportReport("pdf")}>
              <Download className="h-3 w-3 mr-1" />{exporting === "pdf" ? "Preparing…" : "PDF"}
            </Button>
            <Button size="sm" variant="outline" className="text-xs h-7" disabled={!!exporting || isLoading} onClick={() => exportReport("xlsx")}>
              <FileSpreadsheet className="h-3 w-3 mr-1" />{exporting === "xlsx" ? "Preparing…" : "Excel"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="deposited-report-date" className="text-xs text-muted-foreground">Date deposited (or start of range)</Label>
            <Input id="deposited-report-date" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-8 w-[11.5rem]" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="deposited-report-date-end" className="text-xs text-muted-foreground">End date (optional)</Label>
            <Input id="deposited-report-date-end" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-8 w-[11.5rem]" />
          </div>
          {(fromDate || toDate) && (
            <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => { setFromDate(""); setToDate(""); }}>
              All dates
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {title}: {rows.length} check{rows.length === 1 ? "" : "s"}, <span className="font-semibold tabular-nums">{formatReportMoney(total)}</span>
          {truncated && ` (showing the newest ${DEPOSITED_CHECKS_LIMIT.toLocaleString("en-US")}; narrow the dates to see all)`}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[560px] overflow-y-auto overflow-x-auto">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No deposited checks for this selection</div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Insured Name</TableHead>
                  <TableHead>Date Deposited</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Check #</TableHead>
                  <TableHead>Claim #</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm max-w-[260px] truncate">{r.insuredName || "—"}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{formatReportDay(r.depositedOn)}</TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">{formatReportMoney(r.amount)}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{r.checkNumber || "—"}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{r.claimNumber || "—"}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={2} className="font-medium">Total</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatReportMoney(total)}</TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function DepositReports() {
  const { tenantId } = useTenantFilter();
  const { data: depositItems = [] } = useQuery({
    queryKey: ["deposit-report-items", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Array<TenantDepositItem & { check_intake_items?: { tenant_id: string | null } | null }>).map(({ check_intake_items, ...item }) => item);
    },
    enabled: !!tenantId,
  });

  const dailyLogs = useMemo(() => {
    const grouped = new Map<string, Record<string, unknown>>();

    depositItems.forEach((item) => {
      const rawDate = item.cleared_at || item.created_at;
      const depositDate = rawDate ? rawDate.slice(0, 10) : "unknown";
      const provider = item.provider || "unknown";
      const key = `${depositDate}:${provider}`;
      const current = grouped.get(key) ?? {
        deposit_date: depositDate,
        provider,
        item_count: 0,
        total_amount: 0,
        confirmed_amount: 0,
        reconciled_amount: 0,
        nsf_count: 0,
        total_variance: 0,
      };

      current.item_count = Number(current.item_count) + 1;
      current.total_amount = Number(current.total_amount) + (item.amount || 0);
      current.confirmed_amount = Number(current.confirmed_amount) + (item.bank_confirmed_at ? item.amount || 0 : 0);
      current.reconciled_amount = Number(current.reconciled_amount) + (item.reconciled_at ? item.reconciled_amount ?? item.amount ?? 0 : 0);
      current.nsf_count = Number(current.nsf_count) + (item.nsf_flag ? 1 : 0);
      current.total_variance = Number(current.total_variance) + (item.variance_amount || 0);

      grouped.set(key, current);
    });

    return Array.from(grouped.values()).sort((a, b) => String(b.deposit_date).localeCompare(String(a.deposit_date)));
  }, [depositItems]);

  return (
    <div className="space-y-4">
      <DepositedChecksReport />
      <DailyDepositLog logs={dailyLogs} />
    </div>
  );
}

