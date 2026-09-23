import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { TenantAutoApproveCard } from "@/components/billing/TenantAutoApproveCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Banknote, ChevronDown, ChevronRight, Clock, Settings } from "lucide-react";
import { format, parseISO } from "date-fns";

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

/** Bank-credit day from persisted FinCapture depositDate (cleared_at) or submitted_at. */
export const bankDepositDayKey = (iso: string | null | undefined) => {
  if (!iso) return "unknown";
  const day = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "unknown";
};

export const sumDepositAmounts = (rows: { amount: number | null | undefined }[]) =>
  rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

/** Settled only when local status is cleared and provider depositDate was stored. */
export const isBankDepositSettled = (row: { status?: string | null; cleared_at?: string | null }) =>
  row?.status === "cleared" && Boolean(row?.cleared_at);

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
  settled: boolean;
  total: number;
  rows: DepositRow[];
}

export default function BankDepositReconciliation({ searchQuery = "" }: { searchQuery?: string }) {
  const { tenantId } = useTenantFilter();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [jumpDate, setJumpDate] = useState("");
  const [showSettings, setShowSettings] = useState(false);

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

  const groups = useMemo<DepositGroup[]>(() => {
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

    const map = new Map<string, DepositGroup>();
    for (const row of rows) {
      const settled = isBankDepositSettled(row);
      const dayKey = bankDepositDayKey(row.cleared_at ?? row.submitted_at);
      const key = `${settled ? "settled" : "pending"}:${dayKey}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          dayKey,
          label: labelForDay(dayKey),
          settled,
          total: 0,
          rows: [],
        });
      }
      const g = map.get(key)!;
      g.rows.push(row);
      g.total = sumDepositAmounts(g.rows);
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.settled !== b.settled) return a.settled ? 1 : -1;
      return b.key.localeCompare(a.key);
    });
  }, [data, searchQuery]);

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

  const settledTotal = visibleGroups.filter((g) => g.settled).reduce((s, g) => s + g.total, 0);
  const pendingTotal = visibleGroups.filter((g) => !g.settled).reduce((s, g) => s + g.total, 0);

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
        <Button
          type="button"
          size="sm"
          variant={showSettings ? "default" : "outline"}
          onClick={() => setShowSettings((v) => !v)}
          className="gap-1.5"
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </Button>
      </div>

      {showSettings && (
        <TenantAutoApproveCard tenantId={tenantId} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <Banknote className="h-3.5 w-3.5" /> Settled into your bank
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">{fmtMoney(settledTotal)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-3.5 w-3.5" /> In transit / not yet cleared
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">{fmtMoney(pendingTotal)}</div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Each row below is one bank credit. Expand a day to see exactly which checks make up that amount.
        Daily total equals the sum of the checks shown.
      </p>

      {visibleGroups.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {jumpDate ? `No deposits on ${labelForDay(jumpDate)}.` : "No deposits found yet."}
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
                <Badge variant={g.settled ? "default" : "secondary"} className="text-[10px]">
                  {g.settled ? "Settled" : "Pending"}
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
                          <TableCell className="max-w-[180px] truncate">{r.check_intake_items?.carrier_name ?? "—"}</TableCell>
                          <TableCell className="max-w-[220px] truncate">{r.check_intake_items?.payee_line ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{r.check_intake_items?.detected_claim_number ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">{r.checkalt_reference ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap capitalize text-xs text-muted-foreground">
                            {r.status ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums whitespace-nowrap">{fmtMoney(r.amount)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableCell colSpan={6} className="font-medium">TOTAL</TableCell>
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
