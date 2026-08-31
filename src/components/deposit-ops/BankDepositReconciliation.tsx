import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Banknote, ChevronDown, ChevronRight, Clock } from "lucide-react";
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

const safeDate = (iso: string | null) => {
  if (!iso) return null;
  try {
    return parseISO(iso);
  } catch {
    return null;
  }
};

interface DepositGroup {
  key: string;
  label: string;
  settled: boolean;
  total: number;
  rows: DepositRow[];
}

export default function BankDepositReconciliation({ searchQuery = "" }: { searchQuery?: string }) {
  const { tenantId } = useTenantFilter();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
      const settled = !!row.cleared_at;
      const basis = row.cleared_at ?? row.submitted_at;
      const d = safeDate(basis);
      const dayKey = d ? format(d, "yyyy-MM-dd") : "unknown";
      const key = `${settled ? "settled" : "pending"}:${dayKey}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: d ? format(d, "EEE, MMM d, yyyy") : "Date unknown",
          settled,
          total: 0,
          rows: [],
        });
      }
      const g = map.get(key)!;
      g.total += Number(row.amount ?? 0);
      g.rows.push(row);
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.settled !== b.settled) return a.settled ? 1 : -1;
      return b.key.localeCompare(a.key);
    });
  }, [data, searchQuery]);

  const settledTotal = groups.filter((g) => g.settled).reduce((s, g) => s + g.total, 0);
  const pendingTotal = groups.filter((g) => !g.settled).reduce((s, g) => s + g.total, 0);

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
      </p>

      {groups.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No deposits found yet.
          </CardContent>
        </Card>
      )}

      {groups.map((g) => {
        const isOpen = expanded[g.key] ?? false;
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
                      const csv = [header, ...lines, `"TOTAL","","","","","","${g.total.toFixed(2)}"`].join("\n");
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
