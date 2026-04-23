import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle2, XCircle, AlertTriangle, RotateCcw, FileCheck,
  Scale, Landmark, Ban, FileWarning, BookCheck,
} from "lucide-react";
import { format } from "date-fns";

interface ReconciliationItem {
  id: string;
  batch_id?: string | null;
  check_number: string | null;
  carrier_name: string | null;
  amount: number;
  status: string;
  provider: string | null;
  reconciled_amount: number | null;
  reconciled_at: string | null;
  cleared_at: string | null;
  bank_reference: string | null;
  bank_confirmed_at: string | null;
  variance_amount: number | null;
  variance_reason: string | null;
  nsf_flag: boolean | null;
  return_reason: string | null;
  accounting_synced_at: string | null;
  exception_reason: string | null;
  created_at: string;
}

const providerLabels: Record<string, string> = {
  manual_branch: "Branch",
  internal_ready: "Internal",
  synctera: "Synctera",
  treasury_prime: "Treasury Prime",
};

export function ReconciliationDashboard() {
  const { tenantId } = useTenantFilter();

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["reconciliation-items", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!)
        .in("status", ["succeeded", "reconciled", "failed", "returned", "exception"])
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Array<ReconciliationItem & { check_intake_items?: { tenant_id: string | null } | null }>).map(({ check_intake_items, ...item }) => item);
    },
    enabled: !!tenantId,
  });

  const itemIds = items.map((item) => item.id);
  const batchIds = [...new Set(items.map((item) => item.batch_id).filter(Boolean))] as string[];

  const { data: batchMeta = [] } = useQuery({
    queryKey: ["deposit-batches", tenantId, batchIds.join(",")],
    queryFn: async () => {
      if (batchIds.length === 0) return [];
      const { data, error } = await supabase.from("deposit_batches").select("id, batch_number, provider, status").in("id", batchIds);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!tenantId && batchIds.length > 0,
  });

  const { data: unresolvedExceptions = [] } = useQuery({
    queryKey: ["unresolved-deposit-exceptions", tenantId, itemIds.join(",")],
    queryFn: async () => {
      if (itemIds.length === 0) return [];
      const { data, error } = await supabase
        .from("deposit_exceptions")
        .select("*")
        .in("deposit_item_id", itemIds)
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!tenantId && itemIds.length > 0,
  });

  const summary = useMemo(() => items.reduce<Record<string, number>>((acc, item) => {
    acc.in_flight_amount += ["pending_assignment", "provider_assigned", "submitted", "processing"].includes(item.status) ? item.amount ?? 0 : 0;
    acc.cleared_amount += item.status === "succeeded" ? item.amount ?? 0 : 0;
    acc.reconciled_amount += item.status === "reconciled" ? item.reconciled_amount ?? item.amount ?? 0 : 0;
    acc.failed_amount += ["failed", "returned"].includes(item.status) ? item.amount ?? 0 : 0;
    acc.succeeded += item.status === "succeeded" ? 1 : 0;
    acc.reconciled += item.status === "reconciled" ? 1 : 0;
    acc.unconfirmed_count += item.bank_confirmed_at ? 0 : 1;
    acc.total_variance += item.variance_amount ?? 0;
    acc.variance_count += item.variance_amount && item.variance_amount !== 0 ? 1 : 0;
    acc.nsf_count += item.nsf_flag ? 1 : 0;
    acc.unsynced_count += item.accounting_synced_at ? 0 : 1;
    return acc;
  }, {
    in_flight_amount: 0,
    cleared_amount: 0,
    reconciled_amount: 0,
    failed_amount: 0,
    succeeded: 0,
    reconciled: 0,
    unconfirmed_count: 0,
    total_variance: 0,
    variance_count: 0,
    nsf_count: 0,
    unsynced_count: 0,
  }), [items]);

  const batches = useMemo(() => {
    const metaMap = new Map(batchMeta.map((batch: any) => [batch.id, batch]));
    const grouped = new Map<string, Record<string, string | number | null>>();

    items.forEach((item) => {
      if (!item.batch_id) return;
      const meta = metaMap.get(item.batch_id);
      const current = grouped.get(item.batch_id) ?? {
        id: item.batch_id,
        batch_number: meta?.batch_number ?? item.batch_id,
        provider: meta?.provider ?? item.provider,
        status: meta?.status ?? item.status,
        total_items: 0,
        total_amount: 0,
        cleared_amount: 0,
        failed_amount: 0,
      };

      current.total_items = Number(current.total_items) + 1;
      current.total_amount = Number(current.total_amount) + (item.amount ?? 0);
      current.cleared_amount = Number(current.cleared_amount) + (item.status === "succeeded" ? item.amount ?? 0 : 0);
      current.failed_amount = Number(current.failed_amount) + (["failed", "returned"].includes(item.status) ? item.amount ?? 0 : 0);
      grouped.set(item.batch_id, current);
    });

    return Array.from(grouped.values());
  }, [batchMeta, items]);

  const fmtMoney = (n: number | null | undefined) =>
    n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00";

  const statusIcon = (s: string, nsf: boolean | null) => {
    if (nsf) return <Ban className="h-3 w-3 text-destructive" />;
    switch (s) {
      case "succeeded": return <CheckCircle2 className="h-3 w-3 text-emerald-400" />;
      case "reconciled": return <FileCheck className="h-3 w-3 text-primary" />;
      case "failed": return <XCircle className="h-3 w-3 text-destructive" />;
      case "returned": return <RotateCcw className="h-3 w-3 text-orange-400" />;
      default: return <AlertTriangle className="h-3 w-3 text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        <Card>
          <CardContent className="p-3 text-center">
            <Scale className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold tabular-nums">{fmtMoney(summary?.in_flight_amount)}</p>
            <p className="text-[10px] text-muted-foreground">In Flight</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <CheckCircle2 className="h-4 w-4 mx-auto mb-1 text-emerald-400" />
            <p className="text-lg font-bold tabular-nums text-emerald-400">{fmtMoney(summary?.cleared_amount)}</p>
            <p className="text-[10px] text-muted-foreground">Cleared ({summary?.succeeded ?? 0})</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <FileCheck className="h-4 w-4 mx-auto mb-1 text-primary" />
            <p className="text-lg font-bold tabular-nums text-primary">{fmtMoney(summary?.reconciled_amount)}</p>
            <p className="text-[10px] text-muted-foreground">Reconciled ({summary?.reconciled ?? 0})</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <XCircle className="h-4 w-4 mx-auto mb-1 text-destructive" />
            <p className="text-lg font-bold tabular-nums text-destructive">{fmtMoney(summary?.failed_amount)}</p>
            <p className="text-[10px] text-muted-foreground">Failed/Returned</p>
          </CardContent>
        </Card>
        <Card className={summary?.unconfirmed_count && summary.unconfirmed_count > 0 ? "border-amber-500/30" : ""}>
          <CardContent className="p-3 text-center">
            <Landmark className="h-4 w-4 mx-auto mb-1 text-amber-400" />
            <p className="text-lg font-bold tabular-nums text-amber-400">{summary?.unconfirmed_count ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">Unconfirmed</p>
          </CardContent>
        </Card>
        <Card className={summary?.variance_count && summary.variance_count > 0 ? "border-orange-500/30" : ""}>
          <CardContent className="p-3 text-center">
            <FileWarning className="h-4 w-4 mx-auto mb-1 text-orange-400" />
            <p className="text-lg font-bold tabular-nums text-orange-400">{fmtMoney(summary?.total_variance)}</p>
            <p className="text-[10px] text-muted-foreground">Variance ({summary?.variance_count ?? 0})</p>
          </CardContent>
        </Card>
        <Card className={summary?.nsf_count && summary.nsf_count > 0 ? "border-destructive/30" : ""}>
          <CardContent className="p-3 text-center">
            <Ban className="h-4 w-4 mx-auto mb-1 text-destructive" />
            <p className="text-lg font-bold tabular-nums text-destructive">{summary?.nsf_count ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">NSF Returns</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <BookCheck className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold tabular-nums">{summary?.unsynced_count ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">Unsynced</p>
          </CardContent>
        </Card>
      </div>

      {/* Unresolved Exceptions */}
      {unresolvedExceptions.length > 0 && (
        <Card className="border-destructive/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Open Exceptions ({unresolvedExceptions.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[400px] overflow-y-auto scroll-smooth">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unresolvedExceptions.map((ex) => {
                    const e = ex as Record<string, unknown>;
                    return (
                      <TableRow key={e.id as string}>
                        <TableCell className="text-xs">{(e.exception_type as string).replace(/_/g, " ")}</TableCell>
                        <TableCell><Badge variant="outline" className="text-[10px]">{e.exception_code as string}</Badge></TableCell>
                        <TableCell className="text-xs max-w-[250px] truncate">{e.description as string}</TableCell>
                        <TableCell>
                          <Badge variant={(e.severity as string) === "critical" ? "destructive" : "outline"} className="text-[10px]">
                            {e.severity as string}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{format(new Date(e.created_at as string), "MMM d")}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Batch Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent Batches</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[400px] overflow-y-auto scroll-smooth">
            {batches.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No batches yet</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Cleared</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((b) => {
                    const batch = b as Record<string, string | number | null>;
                    return (
                      <TableRow key={String(batch.id)}>
                        <TableCell className="font-mono text-xs">{String(batch.batch_number ?? "").slice(0, 20)}</TableCell>
                        <TableCell className="text-xs">{providerLabels[String(batch.provider)] ?? String(batch.provider)}</TableCell>
                        <TableCell className="text-sm">{Number(batch.total_items)}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{fmtMoney(Number(batch.total_amount))}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-emerald-400">{fmtMoney(Number(batch.cleared_amount))}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-destructive">{fmtMoney(Number(batch.failed_amount))}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">{String(batch.status ?? "").replace(/_/g, " ")}</Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Item-Level Reconciliation */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Item Reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[400px] overflow-y-auto scroll-smooth">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading...</div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">No items to reconcile</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead>Check #</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Deposited</TableHead>
                    <TableHead className="text-right">Reconciled</TableHead>
                    <TableHead className="text-right">Δ</TableHead>
                    <TableHead>Bank Ref</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const delta = item.variance_amount ?? (item.reconciled_amount != null ? item.reconciled_amount - item.amount : null);
                    return (
                      <TableRow key={item.id}>
                        <TableCell>{statusIcon(item.status, item.nsf_flag)}</TableCell>
                        <TableCell className="font-mono text-sm">#{item.check_number || "—"}</TableCell>
                        <TableCell className="text-sm">{item.carrier_name || "—"}</TableCell>
                        <TableCell className="text-xs">{item.provider ? providerLabels[item.provider] ?? item.provider : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(item.amount)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {item.reconciled_amount != null ? fmtMoney(item.reconciled_amount) : "—"}
                        </TableCell>
                        <TableCell className={`text-right tabular-nums ${delta && delta !== 0 ? "text-orange-400 font-medium" : ""}`}>
                          {delta != null ? (delta >= 0 ? "+" : "") + fmtMoney(delta) : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-[100px]">
                          {item.bank_reference || (item.bank_confirmed_at ? "✓" : "—")}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.cleared_at ? format(new Date(item.cleared_at), "MMM d") : item.reconciled_at ? format(new Date(item.reconciled_at), "MMM d") : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {item.nsf_flag && <Badge variant="destructive" className="text-[9px]">NSF</Badge>}
                            {!item.accounting_synced_at && item.status === "reconciled" && (
                              <Badge variant="outline" className="text-[9px]">Unsynced</Badge>
                            )}
                            {item.exception_reason && !item.nsf_flag && (
                              <Badge variant="outline" className="text-[9px] border-destructive/50 text-destructive">Exc</Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
