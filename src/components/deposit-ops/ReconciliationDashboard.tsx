import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CheckCircle2, XCircle, AlertTriangle, Clock, RotateCcw, FileCheck, Scale } from "lucide-react";
import { format } from "date-fns";

interface ReconciliationItem {
  id: string;
  check_number: string | null;
  carrier_name: string | null;
  amount: number;
  status: string;
  provider: string | null;
  reconciled_amount: number | null;
  reconciled_at: string | null;
  cleared_at: string | null;
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
  const { data: summary } = useQuery({
    queryKey: ["deposit-recon-summary"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_deposit_reconciliation_summary");
      if (error) throw error;
      return data as Record<string, number>;
    },
  });

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["reconciliation-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*")
        .in("status", ["succeeded", "reconciled", "failed", "returned", "exception"])
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ReconciliationItem[];
    },
  });

  const { data: batches = [] } = useQuery({
    queryKey: ["deposit-batches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_batches")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });

  const fmtMoney = (n: number | null | undefined) =>
    n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00";

  const statusIcon = (s: string) => {
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-4 text-center">
            <Scale className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Approved</p>
            <p className="text-lg font-bold tabular-nums">{fmtMoney(summary?.in_flight_amount)}</p>
            <p className="text-[10px] text-muted-foreground">In flight</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <CheckCircle2 className="h-5 w-5 mx-auto mb-1 text-emerald-400" />
            <p className="text-xs text-muted-foreground">Cleared</p>
            <p className="text-lg font-bold tabular-nums text-emerald-400">{fmtMoney(summary?.cleared_amount)}</p>
            <p className="text-[10px] text-muted-foreground">{summary?.succeeded ?? 0} items</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <FileCheck className="h-5 w-5 mx-auto mb-1 text-primary" />
            <p className="text-xs text-muted-foreground">Reconciled</p>
            <p className="text-lg font-bold tabular-nums text-primary">{fmtMoney(summary?.reconciled_amount)}</p>
            <p className="text-[10px] text-muted-foreground">{summary?.reconciled ?? 0} items</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <XCircle className="h-5 w-5 mx-auto mb-1 text-destructive" />
            <p className="text-xs text-muted-foreground">Failed/Returned</p>
            <p className="text-lg font-bold tabular-nums text-destructive">{fmtMoney(summary?.failed_amount)}</p>
            <p className="text-[10px] text-muted-foreground">{(summary?.failed ?? 0) + (summary?.returned ?? 0)} items</p>
          </CardContent>
        </Card>
        <Card className={summary?.unreconciled_amount && summary.unreconciled_amount > 0 ? "border-orange-500/50" : ""}>
          <CardContent className="p-4 text-center">
            <AlertTriangle className="h-5 w-5 mx-auto mb-1 text-orange-400" />
            <p className="text-xs text-muted-foreground">Unreconciled</p>
            <p className="text-lg font-bold tabular-nums text-orange-400">{fmtMoney(summary?.unreconciled_amount)}</p>
            <p className="text-[10px] text-muted-foreground">Needs attention</p>
          </CardContent>
        </Card>
      </div>

      {/* Batch Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent Batches</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-48">
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
                  {batches.map((b: Record<string, unknown>) => (
                    <TableRow key={b.id as string}>
                      <TableCell className="font-mono text-xs">{String(b.batch_number ?? "").slice(0, 20)}</TableCell>
                      <TableCell className="text-xs">{providerLabels[(b.provider as string)] ?? b.provider}</TableCell>
                      <TableCell className="text-sm">{b.total_items as number}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{fmtMoney(b.total_amount as number)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-emerald-400">{fmtMoney(b.cleared_amount as number)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-destructive">{fmtMoney(b.failed_amount as number)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">{(b.status as string).replace(/_/g, " ")}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Item-Level Reconciliation */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Item Reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-700px)] min-h-[200px]">
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
                    <TableHead>Date</TableHead>
                    <TableHead>Exception</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const delta = item.reconciled_amount != null ? item.reconciled_amount - item.amount : null;
                    return (
                      <TableRow key={item.id}>
                        <TableCell>{statusIcon(item.status)}</TableCell>
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
                        <TableCell className="text-xs text-muted-foreground">
                          {item.cleared_at ? format(new Date(item.cleared_at), "MMM d") : item.reconciled_at ? format(new Date(item.reconciled_at), "MMM d") : "—"}
                        </TableCell>
                        <TableCell className="text-xs max-w-[150px] truncate text-destructive">
                          {item.exception_reason || "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
