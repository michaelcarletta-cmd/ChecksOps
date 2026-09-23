import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Clock, AlertTriangle, CheckCircle2, Landmark, BookCheck,
  Scale, FileWarning, ShieldCheck, Lock,
} from "lucide-react";
import { format } from "date-fns";

interface AgingItem {
  id: string;
  check_number: string | null;
  carrier_name: string | null;
  amount: number;
  status: string;
  provider: string | null;
  aging_bucket: string;
  days_in_state: number;
  sla_deposit_breach: boolean;
  sla_confirm_breach: boolean;
  sla_sync_breach: boolean;
  deposit_slip_count: number;
  stamped_receipt_count: number;
  bank_confirmation_count: number;
  open_exception_count: number;
  closeout_complete: boolean;
  cleared_at: string | null;
  bank_confirmed_at: string | null;
  reconciled_at: string | null;
  accounting_synced_at: string | null;
}

const bucketConfig: Record<string, { label: string; icon: typeof Clock; color: string }> = {
  awaiting_deposit: { label: "Awaiting Deposit", icon: Clock, color: "text-amber-400" },
  awaiting_bank_confirm: { label: "Awaiting Bank Confirm", icon: Landmark, color: "text-blue-400" },
  awaiting_reconciliation: { label: "Awaiting Reconciliation", icon: Scale, color: "text-orange-400" },
  awaiting_accounting_sync: { label: "Awaiting Accounting Sync", icon: BookCheck, color: "text-purple-400" },
  exception: { label: "Exception", icon: AlertTriangle, color: "text-destructive" },
  complete: { label: "Complete", icon: CheckCircle2, color: "text-emerald-400" },
  in_progress: { label: "In Progress", icon: Clock, color: "text-muted-foreground" },
};

const fmtMoney = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00";

export function DepositAgingDashboard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: summary } = useQuery({
    queryKey: ["deposit-aging-summary"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_deposit_aging_summary");
      if (error) throw error;
      return data as Record<string, number>;
    },
  });

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["deposit-aging-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_aging_dashboard")
        .select("*")
        .neq("aging_bucket", "complete")
        .order("days_in_state", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as AgingItem[];
    },
  });

  const closeoutMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const { data, error } = await supabase.rpc("mark_deposit_closeout", {
        p_deposit_item_id: itemId,
        p_actor_id: user!.id,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Closeout complete" });
      qc.invalidateQueries({ queryKey: ["deposit-aging"] });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
    },
    onError: (e: Error) => {
      toast({ title: "Closeout blocked", description: e.message, variant: "destructive" });
    },
  });

  const slaBreaches = items.filter((i) => i.sla_deposit_breach || i.sla_confirm_breach || i.sla_sync_breach);

  return (
    <div className="space-y-4">
      {/* SLA Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        {[
          { label: "Awaiting Deposit", value: summary?.awaiting_deposit ?? 0, icon: Clock, color: "text-amber-400" },
          { label: "Awaiting Confirm", value: summary?.awaiting_bank_confirm ?? 0, icon: Landmark, color: "text-blue-400" },
          { label: "Awaiting Recon", value: summary?.awaiting_reconciliation ?? 0, icon: Scale, color: "text-orange-400" },
          { label: "Awaiting Sync", value: summary?.awaiting_accounting_sync ?? 0, icon: BookCheck, color: "text-purple-400" },
          { label: "Open Exceptions", value: summary?.open_exceptions ?? 0, icon: AlertTriangle, color: "text-destructive" },
          { label: "SLA Breaches", value: (summary?.sla_deposit_breaches ?? 0) + (summary?.sla_confirm_breaches ?? 0) + (summary?.sla_sync_breaches ?? 0), icon: FileWarning, color: "text-destructive" },
          { label: "Complete", value: summary?.complete ?? 0, icon: ShieldCheck, color: "text-emerald-400" },
        ].map((c) => (
          <Card key={c.label}>
            <CardContent className="p-3 text-center">
              <c.icon className={`h-4 w-4 mx-auto mb-1 ${c.color}`} />
              <p className={`text-lg font-bold tabular-nums ${c.color}`}>{c.value}</p>
              <p className="text-[10px] text-muted-foreground">{c.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* SLA Breach Alerts */}
      {slaBreaches.length > 0 && (
        <Card className="border-destructive/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <FileWarning className="h-4 w-4" />
              SLA Breaches ({slaBreaches.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[400px] overflow-y-auto scroll-smooth">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check #</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Days</TableHead>
                    <TableHead>Breach Type</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slaBreaches.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono text-xs">#{item.check_number || "—"}</TableCell>
                      <TableCell className="text-sm tabular-nums">{fmtMoney(item.amount)}</TableCell>
                      <TableCell className="text-sm font-medium text-destructive">{item.days_in_state}d</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {item.sla_deposit_breach && <Badge variant="destructive" className="text-[9px]">Deposit &gt;2d</Badge>}
                          {item.sla_confirm_breach && <Badge variant="destructive" className="text-[9px]">Confirm &gt;3d</Badge>}
                          {item.sla_sync_breach && <Badge variant="destructive" className="text-[9px]">Sync &gt;5d</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Aging Queue */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Deposit Aging Queue ({items.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[400px] overflow-y-auto scroll-smooth">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading...</div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">All items closed out ✓</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check #</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Days</TableHead>
                    <TableHead>Checklist</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const bc = bucketConfig[item.aging_bucket] ?? bucketConfig.in_progress;
                    const BIcon = bc.icon;
                    const canCloseout = item.status === "reconciled" && item.bank_confirmed_at && item.accounting_synced_at && item.open_exception_count === 0;
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono text-xs">#{item.check_number || "—"}</TableCell>
                        <TableCell className="text-xs max-w-[100px] truncate">{item.carrier_name || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{fmtMoney(item.amount)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] gap-1 ${bc.color}`}>
                            <BIcon className="h-3 w-3" />{bc.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className={`text-sm font-medium ${item.days_in_state > 3 ? "text-destructive" : "text-muted-foreground"}`}>
                            {item.days_in_state}d
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-0.5">
                            <Badge variant="outline" className={`text-[8px] ${item.cleared_at ? "text-emerald-400 border-emerald-500/50" : "text-muted-foreground"}`}>DEP</Badge>
                            <Badge variant="outline" className={`text-[8px] ${item.bank_confirmed_at ? "text-emerald-400 border-emerald-500/50" : "text-muted-foreground"}`}>BNK</Badge>
                            <Badge variant="outline" className={`text-[8px] ${item.reconciled_at ? "text-emerald-400 border-emerald-500/50" : "text-muted-foreground"}`}>REC</Badge>
                            <Badge variant="outline" className={`text-[8px] ${item.accounting_synced_at ? "text-emerald-400 border-emerald-500/50" : "text-muted-foreground"}`}>ACC</Badge>
                            {item.open_exception_count > 0 && (
                              <Badge variant="destructive" className="text-[8px]">{item.open_exception_count} EXC</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {canCloseout && !item.closeout_complete && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7"
                              onClick={() => closeoutMutation.mutate(item.id)}
                              disabled={closeoutMutation.isPending}
                            >
                              <Lock className="h-3 w-3 mr-1" />Close Out
                            </Button>
                          )}
                          {item.closeout_complete && (
                            <Badge variant="outline" className="text-[9px] text-emerald-400">✓ Closed</Badge>
                          )}
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
