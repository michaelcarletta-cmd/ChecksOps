import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
  manual_branch: "Branch",
  internal_ready: "Internal",
  synctera: "Synctera",
  treasury_prime: "Treasury Prime",
};

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

/* ------------------------------------------------------------------ */
/*  Daily Deposit Log                                                  */
/* ------------------------------------------------------------------ */
function DailyDepositLog() {
  const { data: logs = [] } = useQuery({
    queryKey: ["deposit-daily-log"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_daily_log" as string)
        .select("*")
        .order("deposit_date", { ascending: false })
        .limit(60);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

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

/* ------------------------------------------------------------------ */
/*  NSF/Return Report                                                  */
/* ------------------------------------------------------------------ */
function NSFReturnReport() {
  const { data: items = [] } = useQuery({
    queryKey: ["deposit-nsf-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*")
        .or("nsf_flag.eq.true,status.eq.returned")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Ban className="h-4 w-4 text-destructive" />NSF &amp; Return Report ({items.length})
          </CardTitle>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => exportCSV(items, `nsf-report-${format(new Date(), "yyyy-MM-dd")}.csv`)}>
            <Download className="h-3 w-3 mr-1" />CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[400px]">
          {items.length === 0 ? (
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
                {items.map((item) => (
                  <TableRow key={item.id as string}>
                    <TableCell className="font-mono text-xs">#{(item.check_number as string) || "—"}</TableCell>
                    <TableCell className="text-xs">{(item.carrier_name as string) || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">{fmtMoney(item.amount as number)}</TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{(item.return_reason as string) || (item.exception_reason as string) || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{format(new Date(item.created_at as string), "MMM d")}</TableCell>
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

/* ------------------------------------------------------------------ */
/*  Variance Report                                                    */
/* ------------------------------------------------------------------ */
function VarianceReport() {
  const { data: items = [] } = useQuery({
    queryKey: ["deposit-variance-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*")
        .not("variance_amount", "is", null)
        .neq("variance_amount", 0)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />Variance Report ({items.length})
          </CardTitle>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => exportCSV(items, `variance-report-${format(new Date(), "yyyy-MM-dd")}.csv`)}>
            <Download className="h-3 w-3 mr-1" />CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[400px]">
          {items.length === 0 ? (
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
                {items.map((item) => (
                  <TableRow key={item.id as string}>
                    <TableCell className="font-mono text-xs">#{(item.check_number as string) || "—"}</TableCell>
                    <TableCell className="text-xs">{(item.carrier_name as string) || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(item.amount as number)}</TableCell>
                    <TableCell className="text-right tabular-nums text-amber-400 font-medium">
                      {(item.variance_amount as number) >= 0 ? "+" : ""}{fmtMoney(item.variance_amount as number)}
                    </TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{(item.variance_reason as string) || "—"}</TableCell>
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

/* ------------------------------------------------------------------ */
/*  Unreconciled Cash Report                                           */
/* ------------------------------------------------------------------ */
function UnreconciledCashReport() {
  const { data: items = [] } = useQuery({
    queryKey: ["deposit-unreconciled-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*")
        .eq("status", "succeeded")
        .is("reconciled_at", null)
        .order("cleared_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const total = items.reduce((s, i) => s + ((i.amount as number) || 0), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Scale className="h-4 w-4 text-orange-400" />Unreconciled Cash ({items.length}) — {fmtMoney(total)}
          </CardTitle>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => exportCSV(items, `unreconciled-${format(new Date(), "yyyy-MM-dd")}.csv`)}>
            <Download className="h-3 w-3 mr-1" />CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[400px]">
          {items.length === 0 ? (
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
                {items.map((item) => {
                  const days = item.cleared_at ? Math.floor((Date.now() - new Date(item.cleared_at as string).getTime()) / 86400000) : 0;
                  return (
                    <TableRow key={item.id as string}>
                      <TableCell className="font-mono text-xs">#{(item.check_number as string) || "—"}</TableCell>
                      <TableCell className="text-xs">{(item.carrier_name as string) || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(item.amount as number)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{(item.bank_reference as string) || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{item.cleared_at ? format(new Date(item.cleared_at as string), "MMM d") : "—"}</TableCell>
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

/* ------------------------------------------------------------------ */
/*  Main Reports container                                             */
/* ------------------------------------------------------------------ */
export function DepositReports() {
  return (
    <Tabs defaultValue="daily" className="space-y-4">
      <TabsList>
        <TabsTrigger value="daily" className="text-xs">Daily Log</TabsTrigger>
        <TabsTrigger value="unreconciled" className="text-xs">Unreconciled</TabsTrigger>
        <TabsTrigger value="nsf" className="text-xs">NSF/Returns</TabsTrigger>
        <TabsTrigger value="variance" className="text-xs">Variances</TabsTrigger>
      </TabsList>
      <TabsContent value="daily"><DailyDepositLog /></TabsContent>
      <TabsContent value="unreconciled"><UnreconciledCashReport /></TabsContent>
      <TabsContent value="nsf"><NSFReturnReport /></TabsContent>
      <TabsContent value="variance"><VarianceReport /></TabsContent>
    </Tabs>
  );
}
