import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, Loader2, Scale } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { extractInsuredName } from "@/features/check-command/status";
import { displayCase } from "@/lib/displayCase";
import { OUTSTANDING_CLAIMS_QUERY_KEY, loadOutstandingClaims } from "@/lib/outstandingClaimsLoad";
import { filterOutstandingClaimRows, outstandingTotals } from "@/lib/outstandingClaims";
import { ReportExportMenu, type ReportExportKind } from "@/components/ledger/ReportExportMenu";

const money = (n: number) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Checks → Outstanding (owner 2026-11-17): every claim with a balance above $0 by the claim ledger's
 * own figure (expected minus received), with recoverable depreciation and the deductible. A row opens
 * the claim's most recent check: the check file and its ledger. Excel and PDF as the recipient report.
 */
export default function OutstandingClaimsPanel({
  tenantId,
  companyName,
  searchQuery,
  selectedCheckId,
  onOpenCheck,
  compact,
}: {
  tenantId: string | null;
  companyName?: string | null;
  searchQuery: string;
  selectedCheckId: string | null;
  onOpenCheck: (checkId: string) => void;
  /** The list shares the row with an open check: show fewer columns. */
  compact?: boolean;
}) {
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery({
    queryKey: [OUTSTANDING_CLAIMS_QUERY_KEY, tenantId],
    enabled: !!tenantId,
    queryFn: () => loadOutstandingClaims(supabase, tenantId!, { insuredNameFromPayeeLine: extractInsuredName }),
  });

  // Deductibles can be hidden (owner 2026-11-17: public adjusters and attorneys do not collect deductibles, only
  // contractors do). The choice is this user's, remembered in this browser; the outstanding amount is unchanged.
  const { user } = useAuth();
  const deductibleKey = `checksops.outstanding.showDeductible.${user?.id ?? "anonymous"}`;
  const [showDeductible, setShowDeductible] = useState(true);
  useEffect(() => {
    try {
      setShowDeductible(window.localStorage.getItem(deductibleKey) !== "0");
    } catch {
      setShowDeductible(true);
    }
  }, [deductibleKey]);
  const changeShowDeductible = useCallback((next: boolean) => {
    setShowDeductible(next);
    try {
      window.localStorage.setItem(deductibleKey, next ? "1" : "0");
    } catch {
      // Storage unavailable (private mode): the choice lasts for this visit only.
    }
  }, [deductibleKey]);

  const rows = useMemo(() => filterOutstandingClaimRows(data?.rows ?? [], searchQuery), [data, searchQuery]);
  const totals = useMemo(() => outstandingTotals(rows), [rows]);
  const search = searchQuery.trim();

  // Excel and PDF of the list as shown (search applied), like the recipient report.
  const [exporting, setExporting] = useState<ReportExportKind | null>(null);
  const exportShown = async (kind: ReportExportKind) => {
    setExporting(kind);
    try {
      const { reportTablePdf, reportTableXlsx, reportFileName, PDF_MIME, XLSX_MIME } = await import("@/lib/payments/recipientReportExport");
      const { downloadReportFile } = await import("@/lib/depositedChecksExport");
      const { outstandingClaimsTable } = await import("@/lib/outstandingClaims");
      const now = new Date();
      const table = outstandingClaimsTable({
        rows,
        search,
        companyName: companyName ?? "",
        asOfLabel: `As of ${format(now, "MM/dd/yyyy")}`,
        displayName: displayCase,
        showDeductible,
      });
      const name = reportFileName(["outstanding-claims", format(now, "yyyy-MM-dd")], kind);
      if (kind === "pdf") downloadReportFile(reportTablePdf(table), name, PDF_MIME);
      else downloadReportFile(await reportTableXlsx(table), name, XLSX_MIME);
    } catch (e) {
      toast({ title: "Export failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setExporting(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Scale className="h-4 w-4 text-amber-500" aria-hidden="true" />
            Outstanding
            {!isLoading && !error && (
              <span className="text-xs font-normal text-muted-foreground">
                {totals.count} claim{totals.count === 1 ? "" : "s"} · {money(totals.outstanding)}
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch id="outstanding-show-deductible" checked={showDeductible} onCheckedChange={changeShowDeductible} />
              <Label htmlFor="outstanding-show-deductible" className="text-xs font-normal cursor-pointer">Show deductible</Label>
            </div>
            <ReportExportMenu onExport={exportShown} busy={exporting} disabled={isLoading || !!error || rows.length === 0} label="Export Outstanding claims" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Claims with a balance above $0: expected (full RCV plus any expected supplement) minus the checks received.
          A claim stays here until its balance is $0, even after its check is disbursed.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {data?.incomplete && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs" role="status">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
            <span>Not every check could be loaded, so some balances may be higher than the ledger shows. Open the claim to see its ledger.</span>
          </div>
        )}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading outstanding claims…
          </div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-destructive" role="alert">
            Outstanding claims could not be loaded. {error instanceof Error ? error.message : ""}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {search ? `No outstanding claims match "${search}".` : "No claims have an outstanding balance."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Claim</TableHead>
                  {!compact && <TableHead className="text-xs text-right">Expected</TableHead>}
                  {!compact && <TableHead className="text-xs text-right">Received</TableHead>}
                  {!compact && <TableHead className="text-xs text-right whitespace-nowrap">Recoverable Dep.</TableHead>}
                  {!compact && showDeductible && <TableHead className="text-xs text-right">Deductible</TableHead>}
                  <TableHead className="text-xs text-right">Outstanding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const isSelected = selectedCheckId === row.openCheckId;
                  const label = `Open claim ${row.claimNumber ?? "with no claim number"}: check file and ledger`;
                  return (
                    <TableRow
                      key={row.claimId}
                      role="button"
                      tabIndex={0}
                      aria-label={label}
                      aria-pressed={isSelected}
                      className={`cursor-pointer ${isSelected ? "bg-primary/5" : ""}`}
                      onClick={() => onOpenCheck(row.openCheckId)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpenCheck(row.openCheckId);
                        }
                      }}
                    >
                      <TableCell className="py-2">
                        <div className="text-sm font-medium">{row.claimNumber ? `#${row.claimNumber}` : "No claim number"}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.policyholderName ? displayCase(row.policyholderName) : "Unknown insured"}
                          {" · "}{row.checkCount} check{row.checkCount === 1 ? "" : "s"}
                        </div>
                        {compact && (
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {money(row.received)} of {money(row.expected)} · Dep. {money(row.recoverableDepreciation)}
                            {showDeductible ? ` · Ded. ${money(row.deductible)}` : ""}
                          </div>
                        )}
                      </TableCell>
                      {!compact && <TableCell className="py-2 text-right text-sm tabular-nums">{money(row.expected)}</TableCell>}
                      {!compact && <TableCell className="py-2 text-right text-sm tabular-nums">{money(row.received)}</TableCell>}
                      {!compact && <TableCell className="py-2 text-right text-sm tabular-nums">{money(row.recoverableDepreciation)}</TableCell>}
                      {!compact && showDeductible && <TableCell className="py-2 text-right text-sm tabular-nums">{money(row.deductible)}</TableCell>}
                      <TableCell className="py-2 text-right text-sm font-semibold tabular-nums text-amber-600">{money(row.outstanding)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="py-2 text-xs font-semibold">Total ({totals.count})</TableCell>
                  {!compact && <TableCell className="py-2 text-right text-xs font-semibold tabular-nums">{money(totals.expected)}</TableCell>}
                  {!compact && <TableCell className="py-2 text-right text-xs font-semibold tabular-nums">{money(totals.received)}</TableCell>}
                  {!compact && <TableCell className="py-2 text-right text-xs font-semibold tabular-nums">{money(totals.recoverableDepreciation)}</TableCell>}
                  {!compact && showDeductible && <TableCell className="py-2 text-right text-xs font-semibold tabular-nums">{money(totals.deductible)}</TableCell>}
                  <TableCell className="py-2 text-right text-xs font-semibold tabular-nums">{money(totals.outstanding)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
