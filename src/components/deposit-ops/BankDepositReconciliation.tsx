import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight } from "lucide-react";
import { format, parseISO } from "date-fns";
import { displayCaseOrNull } from "@/lib/displayCase";
import {
  bankDepositDayInRange,
  bankDepositDayKey,
  groupBankDeposits,
  isBankDepositSettled,
  sumDepositAmounts,
} from "@/lib/bankDepositGroups";

export { bankDepositDayKey, isBankDepositSettled, sumDepositAmounts };

interface DepositRow {
  id: string;
  checkalt_reference: string | null;
  amount: number | null;
  status: string | null;
  cleared_at: string | null;
  submitted_at: string | null;
  check_intake_items: {
    check_number: string | null;
    carrier_name: string | null;
    payee_line: string | null;
    detected_claim_number: string | null;
  } | null;
}

const fmtMoney = (n: number | null | undefined) =>
  `$${(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const labelForDay = (dayKey: string) => {
  if (dayKey === "unknown") return "Date unknown";
  try {
    return format(parseISO(`${dayKey}T12:00:00`), "MMMM d, yyyy");
  } catch {
    return dayKey;
  }
};

interface DepositGroup {
  key: string;
  dayKey: string;
  label: string;
  total: number;
  rows: DepositRow[];
}

export default function BankDepositReconciliation({ searchQuery = "" }: { searchQuery?: string }) {
  const { tenantId } = useTenantFilter();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const dateFilterOn = Boolean(fromDate || toDate);

  const { data, isLoading } = useQuery({
    queryKey: ["bank-deposit-reconciliation", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_deposits")
        .select(
          "id, checkalt_reference, amount, status, cleared_at, submitted_at, check_intake_items(check_number, carrier_name, payee_line, detected_claim_number)",
        )
        .eq("tenant_id", tenantId as string)
        .in("status", ["submitted", "cleared"])
        .order("submitted_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as DepositRow[];
    },
  });

  const grouped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const rows = (data ?? []).filter((r) => {
      if (!q) return true;
      const item = r.check_intake_items;
      return [
        r.checkalt_reference,
        item?.check_number,
        item?.carrier_name,
        item?.payee_line,
        item?.detected_claim_number,
        r.amount != null ? String(r.amount) : null,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });

    // groupBankDeposits (src/lib/bankDepositGroups.ts): every check that passed
    // to Check Alt, under its deposit day (the Check Alt depositDate once it
    // cleared, else the day it was sent).
    const split = groupBankDeposits(rows);
    const days: DepositGroup[] = split.days.map((d) => ({ ...d, label: labelForDay(d.dayKey) }));
    return { days };
  }, [data, searchQuery]);
  const groups = grouped.days;

  const visibleGroups = useMemo(
    () => groups.filter((g) => bankDepositDayInRange(g.dayKey, fromDate, toDate)),
    [groups, fromDate, toDate],
  );
  const visibleTotal = useMemo(() => visibleGroups.reduce((s, g) => s + g.total, 0), [visibleGroups]);
  const visibleChecks = useMemo(() => visibleGroups.reduce((s, g) => s + g.rows.length, 0), [visibleGroups]);

  // A single date opens that day's deposit.
  useEffect(() => {
    if (!fromDate || toDate) return;
    setExpanded((prev) => {
      const next = { ...prev };
      for (const g of groups) {
        if (g.dayKey === fromDate) next[g.key] = true;
      }
      return next;
    });
  }, [fromDate, toDate, groups]);

  const rangeLabel = !dateFilterOn
    ? ""
    : fromDate && !toDate
      ? labelForDay(fromDate)
      : !fromDate
        ? `through ${labelForDay(toDate)}`
        : `${labelForDay(fromDate <= toDate ? fromDate : toDate)} – ${labelForDay(fromDate <= toDate ? toDate : fromDate)}`;

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="bank-deposit-date" className="text-xs text-muted-foreground">
              Deposit date (or start of range)
            </Label>
            <Input
              id="bank-deposit-date"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 w-[11.5rem]"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bank-deposit-date-end" className="text-xs text-muted-foreground">
              End date (optional)
            </Label>
            <Input
              id="bank-deposit-date-end"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 w-[11.5rem]"
            />
          </div>
          {dateFilterOn && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
            >
              All days
            </Button>
          )}
        </div>
      </div>

      {dateFilterOn && visibleGroups.length > 0 && (
        <p className="text-sm">
          {rangeLabel}: {visibleGroups.length} deposit{visibleGroups.length === 1 ? "" : "s"}, {visibleChecks} check
          {visibleChecks === 1 ? "" : "s"}, <span className="font-semibold tabular-nums">{fmtMoney(visibleTotal)}</span>
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Each date is one deposit. Click a date to see the checks deposited that day. The total equals
        the sum of the checks shown.
      </p>

      {visibleGroups.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {!dateFilterOn
              ? "No deposited checks yet."
              : fromDate && !toDate
                ? `No deposits on ${rangeLabel}.`
                : `No deposits ${fromDate ? "from" : ""} ${rangeLabel}.`.replace(/\s+/g, " ")}
          </CardContent>
        </Card>
      )}

      {visibleGroups.map((g) => {
        const isOpen = expanded[g.key] ?? false;
        const displayedSum = sumDepositAmounts(g.rows);
        return (
          <Card key={g.key}>
            <button
              type="button"
              onClick={() => setExpanded((p) => ({ ...p, [g.key]: !isOpen }))}
              className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <span className="font-medium truncate">{g.label}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {g.rows.length} check{g.rows.length === 1 ? "" : "s"}
                </span>
              </div>
              <span className="font-semibold tabular-nums whitespace-nowrap">{fmtMoney(g.total)}</span>
            </button>

            {isOpen && (
              <CardContent className="pt-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap">Check #</TableHead>
                        <TableHead className="whitespace-nowrap">Carrier</TableHead>
                        <TableHead className="whitespace-nowrap">Payee</TableHead>
                        <TableHead className="whitespace-nowrap">Claim #</TableHead>
                        <TableHead className="whitespace-nowrap">Reference</TableHead>
                        <TableHead className="whitespace-nowrap">Status</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.rows.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap">{r.check_intake_items?.check_number ?? "—"}</TableCell>
                          <TableCell className="max-w-[180px] truncate">{displayCaseOrNull(r.check_intake_items?.carrier_name) ?? "—"}</TableCell>
                          <TableCell className="max-w-[220px] truncate">{displayCaseOrNull(r.check_intake_items?.payee_line) ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{r.check_intake_items?.detected_claim_number ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">{r.checkalt_reference ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap capitalize text-xs text-muted-foreground">
                            {r.status ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums whitespace-nowrap">{fmtMoney(r.amount)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableCell colSpan={6} className="font-medium">Total</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums whitespace-nowrap">
                          {fmtMoney(displayedSum)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
                <div className="flex justify-end pt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const header = "Check #,Carrier,Payee,Claim #,Reference,Status,Amount";
                      const lines = g.rows.map((r) =>
                        [
                          r.check_intake_items?.check_number ?? "",
                          r.check_intake_items?.carrier_name ?? "",
                          r.check_intake_items?.payee_line ?? "",
                          r.check_intake_items?.detected_claim_number ?? "",
                          r.checkalt_reference ?? "",
                          r.status ?? "",
                          (r.amount ?? 0).toFixed(2),
                        ]
                          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
                          .join(","),
                      );
                      const csv = [header, ...lines, `"TOTAL","","","","","","${displayedSum.toFixed(2)}"`].join("\n");
                      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `bank-deposit-${g.key.replace(":", "-")}.csv`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Export CSV
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}

    </div>
  );
}
