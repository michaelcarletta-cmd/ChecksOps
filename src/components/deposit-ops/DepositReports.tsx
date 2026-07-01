import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Printer, Download, FileText, Ban, AlertTriangle, Scale } from "lucide-react";
import { format } from "date-fns";

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
        <ScrollArea className="max-h-[500px]">
          {logs.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No deposit activity</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Confirmed</TableHead>
                  <TableHead className="text-right">Reconciled</TableHead>
                  <TableHead className="text-right">NSF</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{row.deposit_date ? format(new Date(row.deposit_date as string), "MMM d, yyyy") : "—"}</TableCell>
                    <TableCell className="text-xs">{providerLabels[row.provider as string] ?? (row.provider as string)}</TableCell>
                    <TableCell className="text-right text-sm">{row.item_count as number}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(row.total_amount as number)}</TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-400">{fmtMoney(row.confirmed_amount as number)}</TableCell>
                    <TableCell className="text-right tabular-nums text-primary">{fmtMoney(row.reconciled_amount as number)}</TableCell>
                    <TableCell className="text-right text-sm">{(row.nsf_count as number) > 0 ? <Badge variant="destructive" className="text-[9px]">{row.nsf_count as number}</Badge> : "0"}</TableCell>
                    <TableCell className={`text-right tabular-nums ${(row.total_variance as number) !== 0 ? "text-amber-400" : ""}`}>{fmtMoney(row.total_variance as number)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function NSFReturnReport({ items }: { items: TenantDepositItem[] }) {
  const rows = items.filter((item) => item.nsf_flag || item.status === "returned");

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Ban className="h-4 w-4 text-destructive" />NSF &amp; Return Report ({rows.length})
          </CardTitle>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => exportCSV(rows as unknown as Record<string, unknown>[], `nsf-report-${format(new Date(), "yyyy-MM-dd")}.csv`)}>
            <Download className="h-3 w-3 mr-1" />CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[400px]">
          {rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No NSF/returns</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check #</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">#{item.check_number || "—"}</TableCell>
                    <TableCell className="text-xs">{item.carrier_name || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">{fmtMoney(item.amount)}</TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{item.return_reason || item.exception_reason || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{format(new Date(item.created_at), "MMM d")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function VarianceReport({ items }: { items: TenantDepositItem[] }) {
  const rows = items.filter((item) => (item.variance_amount ?? 0) !== 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />Variance Report ({rows.length})
          </CardTitle>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => exportCSV(rows as unknown as Record<string, unknown>[], `variance-report-${format(new Date(), "yyyy-MM-dd")}.csv`)}>
            <Download className="h-3 w-3 mr-1" />CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[400px]">
          {rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No variances detected</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check #</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead className="text-right">Deposited</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">#{item.check_number || "—"}</TableCell>
                    <TableCell className="text-xs">{item.carrier_name || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(item.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums text-amber-400 font-medium">
                      {(item.variance_amount ?? 0) >= 0 ? "+" : ""}{fmtMoney(item.variance_amount)}
                    </TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{item.variance_reason || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function UnreconciledCashReport({ items }: { items: TenantDepositItem[] }) {
  const rows = items.filter((item) => item.status === "succeeded" && !item.reconciled_at);
  const total = rows.reduce((s, i) => s + (i.amount || 0), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Scale className="h-4 w-4 text-orange-400" />Unreconciled Cash ({rows.length}) — {fmtMoney(total)}
          </CardTitle>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => exportCSV(rows as unknown as Record<string, unknown>[], `unreconciled-${format(new Date(), "yyyy-MM-dd")}.csv`)}>
            <Download className="h-3 w-3 mr-1" />CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[400px]">
          {rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">All deposits reconciled ✓</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check #</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Bank Ref</TableHead>
                  <TableHead>Cleared</TableHead>
                  <TableHead>Days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => {
                  const days = item.cleared_at ? Math.floor((Date.now() - new Date(item.cleared_at).getTime()) / 86400000) : 0;
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono text-xs">#{item.check_number || "—"}</TableCell>
                      <TableCell className="text-xs">{item.carrier_name || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(item.amount)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{item.bank_reference || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{item.cleared_at ? format(new Date(item.cleared_at), "MMM d") : "—"}</TableCell>
                      <TableCell className={`text-sm font-medium ${days > 3 ? "text-destructive" : "text-muted-foreground"}`}>{days}d</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
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
    <Tabs defaultValue="daily" className="space-y-4">
      <TabsList>
        <TabsTrigger value="daily" className="text-xs">Daily Log</TabsTrigger>
        <TabsTrigger value="unreconciled" className="text-xs">Unreconciled</TabsTrigger>
        <TabsTrigger value="nsf" className="text-xs">NSF/Returns</TabsTrigger>
        <TabsTrigger value="variance" className="text-xs">Variances</TabsTrigger>
      </TabsList>
      <TabsContent value="daily"><DailyDepositLog logs={dailyLogs} /></TabsContent>
      <TabsContent value="unreconciled"><UnreconciledCashReport items={depositItems} /></TabsContent>
      <TabsContent value="nsf"><NSFReturnReport items={depositItems} /></TabsContent>
      <TabsContent value="variance"><VarianceReport items={depositItems} /></TabsContent>
    </Tabs>
  );
}
