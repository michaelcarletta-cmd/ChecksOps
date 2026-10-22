import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Banknote, ChevronDown, ChevronRight, Clock } from "lucide-react";
import { format, parseISO } from "date-fns";
import { displayCaseOrNull } from "@/lib/displayCase";
import {
  bankDepositDayKey,
  groupBankDeposits,
  inTransitStatusLabel,
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
    return format(parseISO(`${dayKey}T12:00:00.000Z`), "EEE, MMM d, yyyy");
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
  const [jumpDate, setJumpDate] = useState("");

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
        .not("status", "in", "(rejected,returned,error,declined)")
        .order("submitted_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as DepositRow[];
    },
  });

  const [transitOpen, setTransitOpen] = useState(false);

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

    // groupBankDeposits (src/lib/bankDepositGroups.ts): deposited means
    // cleared with the Check Alt depositDate stored in cleared_at, grouped by
    // that day. Everything else is in transit and never lands on a deposit day.
    const split = groupBankDeposits(rows);
    const days: DepositGroup[] = split.days.map((d) => ({ ...d, label: labelForDay(d.dayKey) }));
    return { days, inTransit: split.inTransit, inTransitTotal: split.inTransitTotal };
  }, [data, searchQuery]);
  const groups = grouped.days;

  const visibleGroups = useMemo(() => {
    if (!jumpDate) return groups;
    return groups.filter((g) => g.dayKey === jumpDate);
  }, [groups, jumpDate]);

  useEffect(() => {
    if (!jumpDate) return;
    setExpanded((prev) => {
      const next = { ...prev };
      for (const g of groups) {
        if (g.dayKey === jumpDate) next[g.key] = true;
      }
      return next;
    });
  }, [jumpDate, groups]);

  const settledTotal = visibleGroups.reduce((s, g) => s + g.total, 0);
  const pendingTotal = grouped.inTransitTotal;

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
        <div className="space-y-1">
          <Label htmlFor="bank-deposit-date" className="text-xs text-muted-foreground">
            Jump to deposit date
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="bank-deposit-date"
              type="date"
              value={jumpDate}
              onChange={(e) => setJumpDate(e.target.value)}
              className="h-9 w-[11.5rem]"
            />
            {jumpDate && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setJumpDate("")}>
                All days
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <Banknote className="h-3.5 w-3.5" /> Deposited into your bank
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">{fmtMoney(settledTotal)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-3.5 w-3.5" /> In transit / waiting in Check Alt
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">{fmtMoney(pendingTotal)}</div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Each day below is one bank credit on the day Check Alt deposited it. Expand a day to see exactly
        which checks make up that amount. Daily total equals the sum of the checks shown. Checks that
        Check Alt has not deposited yet are listed separately under In transit.
      </p>

      {visibleGroups.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {jumpDate ? `No deposits on ${labelForDay(jumpDate)}.` : "No deposited checks yet."}
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
                <Badge variant="default" className="text-[10px]">
                  Deposited
                </Badge>
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

      {grouped.inTransit.length > 0 && (
        <Card className="border-dashed">
          <button
            type="button"
            onClick={() => setTransitOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-muted/40 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              {transitOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
              <span className="font-medium truncate">In transit / waiting in Check Alt</span>
              <Badge variant="secondary" className="text-[10px]">Not deposited yet</Badge>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {grouped.inTransit.length} check{grouped.inTransit.length === 1 ? "" : "s"}
              </span>
            </div>
            <span className="font-semibold tabular-nums whitespace-nowrap text-muted-foreground">
              {fmtMoney(grouped.inTransitTotal)}
            </span>
          </button>
          {transitOpen && (
            <CardContent className="pt-0">
              <p className="text-xs text-muted-foreground pb-2">
                Not on any deposit day: Check Alt has not reported a bank deposit date for these checks yet.
                They move to their deposit day once it does.
              </p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">Check #</TableHead>
                      <TableHead className="whitespace-nowrap">Carrier</TableHead>
                      <TableHead className="whitespace-nowrap">Payee</TableHead>
                      <TableHead className="whitespace-nowrap">Reference</TableHead>
                      <TableHead className="whitespace-nowrap">Sent to Check Alt</TableHead>
                      <TableHead className="whitespace-nowrap">Status</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grouped.inTransit.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{r.check_intake_items?.check_number ?? "—"}</TableCell>
                        <TableCell className="max-w-[180px] truncate">{displayCaseOrNull(r.check_intake_items?.carrier_name) ?? "—"}</TableCell>
                        <TableCell className="max-w-[220px] truncate">{displayCaseOrNull(r.check_intake_items?.payee_line) ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{r.checkalt_reference ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {bankDepositDayKey(r.submitted_at) === "unknown" ? "—" : labelForDay(bankDepositDayKey(r.submitted_at))}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {inTransitStatusLabel(r.status)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">{fmtMoney(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
