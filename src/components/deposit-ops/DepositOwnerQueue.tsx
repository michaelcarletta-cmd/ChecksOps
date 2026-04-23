import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  TrendingUp, Clock, Landmark, Scale, BookCheck, ShieldCheck,
  AlertTriangle, Users, Zap, Lock, CheckCircle2, ArrowRight,
  Upload, FileCheck, Ban, BarChart3,
} from "lucide-react";
import { format } from "date-fns";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DepositQueueItem {
  id: string;
  check_number: string | null;
  carrier_name: string | null;
  amount: number;
  status: string;
  provider: string | null;
  owner_id: string | null;
  next_action: string | null;
  next_action_reason: string | null;
  created_at: string;
  cleared_at: string | null;
  bank_confirmed_at: string | null;
  reconciled_at: string | null;
  accounting_synced_at: string | null;
  closeout_complete: boolean;
  nsf_flag: boolean | null;
  variance_amount: number | null;
}

interface ReminderItem {
  deposit_item_id: string;
  check_number: string | null;
  carrier_name: string | null;
  amount: number;
  status: string;
  owner_id: string | null;
  reminder_type: string | null;
  open_exception_count: number;
  created_at: string;
}

interface TeamMember {
  user_id: string;
  email?: string;
}

const fmtMoney = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00";

const actionConfig: Record<string, { label: string; icon: typeof Clock; color: string }> = {
  assign_provider: { label: "Assign Route", icon: ArrowRight, color: "text-amber-400" },
  mark_deposited: { label: "Mark Deposited", icon: Landmark, color: "text-blue-400" },
  upload_deposit_slip: { label: "Upload Slip", icon: Upload, color: "text-orange-400" },
  bank_confirm: { label: "Bank Confirm", icon: Landmark, color: "text-blue-400" },
  reconcile: { label: "Reconcile", icon: Scale, color: "text-purple-400" },
  sync_accounting: { label: "Sync Accounting", icon: BookCheck, color: "text-primary" },
  closeout: { label: "Close Out", icon: Lock, color: "text-emerald-400" },
  resolve_exceptions: { label: "Resolve Exceptions", icon: AlertTriangle, color: "text-destructive" },
  review: { label: "Manual Review", icon: Clock, color: "text-muted-foreground" },
};

const reminderLabels: Record<string, { label: string; color: string }> = {
  sla_deposit_breach: { label: "Deposit SLA breach", color: "text-destructive" },
  sla_confirm_breach: { label: "Confirm SLA breach", color: "text-destructive" },
  missing_deposit_slip: { label: "Missing deposit slip", color: "text-orange-400" },
  unsynced_reconciled: { label: "Unsynced reconciled", color: "text-purple-400" },
  stale_unreconciled: { label: "Stale unreconciled", color: "text-amber-400" },
  stale_open_exception: { label: "Stale open exception", color: "text-destructive" },
};

/* ------------------------------------------------------------------ */
/*  KPI Dashboard                                                      */
/* ------------------------------------------------------------------ */

export function DepositKPIDashboard() {
  const { tenantId } = useTenantFilter();

  const { data: items = [] } = useQuery({
    queryKey: ["deposit-kpi-items", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Array<DepositQueueItem & { check_intake_items?: { tenant_id: string | null } | null }>).map(({ check_intake_items, ...item }) => item);
    },
    enabled: !!tenantId,
  });

  const kpis = {
    avg_days_to_deposit: "—",
    avg_days_to_bank_confirm: "—",
    avg_days_to_reconcile: "—",
    avg_days_to_sync: "—",
    avg_days_to_closeout: "—",
    nsf_rate_pct: items.length ? ((items.filter((item) => item.nsf_flag).length / items.length) * 100).toFixed(1) : "—",
    variance_rate_pct: items.length ? ((items.filter((item) => (item.variance_amount ?? 0) !== 0).length / items.length) * 100).toFixed(1) : "—",
    total_items: items.length,
    closed_out: items.filter((item) => item.closeout_complete).length,
    total_closed_amount: items.filter((item) => item.closeout_complete).reduce((sum, item) => sum + (item.amount ?? 0), 0),
    in_pipeline: items.filter((item) => !item.closeout_complete).length,
    total_open_amount: items.filter((item) => !item.closeout_complete).reduce((sum, item) => sum + (item.amount ?? 0), 0),
  };

  const excKpis = {
    avg_hours_to_resolve: "—",
    open_count: items.filter((item) => item.status === "exception").length,
    resolved_count: 0,
    reopen_count: 0,
    critical_open: items.filter((item) => item.status === "exception").length,
  };

  const kpiCards = [
    { label: "Avg Days to Deposit", value: kpis.avg_days_to_deposit, icon: Clock, color: "text-amber-400" },
    { label: "Avg Days to Confirm", value: kpis.avg_days_to_bank_confirm, icon: Landmark, color: "text-blue-400" },
    { label: "Avg Days to Reconcile", value: kpis.avg_days_to_reconcile, icon: Scale, color: "text-purple-400" },
    { label: "Avg Days to Sync", value: kpis.avg_days_to_sync, icon: BookCheck, color: "text-primary" },
    { label: "Avg Days to Closeout", value: kpis.avg_days_to_closeout, icon: Lock, color: "text-emerald-400" },
    { label: "NSF Rate", value: kpis.nsf_rate_pct !== "—" ? `${kpis.nsf_rate_pct}%` : "—", icon: Ban, color: "text-destructive" },
    { label: "Variance Rate", value: kpis.variance_rate_pct !== "—" ? `${kpis.variance_rate_pct}%` : "—", icon: AlertTriangle, color: "text-amber-400" },
    { label: "Avg Exc Resolution (hrs)", value: excKpis.avg_hours_to_resolve, icon: ShieldCheck, color: "text-emerald-400" },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {kpiCards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-3 text-center">
              <c.icon className={`h-4 w-4 mx-auto mb-1 ${c.color}`} />
              <p className={`text-lg font-bold tabular-nums ${c.color}`}>{c.value}</p>
              <p className="text-[10px] text-muted-foreground">{c.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid md:grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold tabular-nums">{kpis.total_items}</p>
            <p className="text-xs text-muted-foreground">Total Items</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold tabular-nums text-emerald-400">{kpis.closed_out}</p>
            <p className="text-xs text-muted-foreground">Closed Out ({fmtMoney(kpis.total_closed_amount)})</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold tabular-nums text-amber-400">{kpis.in_pipeline}</p>
            <p className="text-xs text-muted-foreground">Open ({fmtMoney(kpis.total_open_amount)})</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-2">
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground mb-2">Exception Health</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-lg font-bold tabular-nums text-destructive">{excKpis.open_count}</p>
                <p className="text-[10px] text-muted-foreground">Open</p>
              </div>
              <div>
                <p className="text-lg font-bold tabular-nums text-emerald-400">{excKpis.resolved_count}</p>
                <p className="text-[10px] text-muted-foreground">Resolved</p>
              </div>
              <div>
                <p className="text-lg font-bold tabular-nums text-amber-400">{excKpis.reopen_count}</p>
                <p className="text-[10px] text-muted-foreground">Reopened</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground mb-2">Critical Exceptions</p>
            <p className={`text-3xl font-bold tabular-nums text-center ${excKpis.critical_open > 0 ? "text-destructive" : "text-emerald-400"}`}>
              {excKpis.critical_open}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Owner Queue & Bulk Actions                                         */
/* ------------------------------------------------------------------ */

interface DepositOwnerQueueProps {
  searchQuery?: string;
}

export function DepositOwnerQueue({ searchQuery = "" }: DepositOwnerQueueProps = {}) {
  const { user } = useAuth();
  const { tenantId } = useTenantFilter();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [bulkDialog, setBulkDialog] = useState<string | null>(null);
  const [bulkOwner, setBulkOwner] = useState("");
  const [bulkNotes, setBulkNotes] = useState("");

  // Fetch items (non-closed)
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["deposit-owner-queue", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!)
        .eq("closeout_complete", false)
        .not("status", "in", "(failed,returned)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return ((data ?? []) as Array<DepositQueueItem & { check_intake_items?: { tenant_id: string | null } | null }>).map(({ check_intake_items, ...item }) => item);
    },
    enabled: !!tenantId,
  });

  const itemIds = items.map((item) => item.id);

  // Reminders
  const { data: reminders = [] } = useQuery({
    queryKey: ["deposit-reminders", tenantId, itemIds.join(",")],
    queryFn: async () => {
      if (itemIds.length === 0) return [];
      const { data, error } = await supabase
        .from("deposit_reminder_queue")
        .select("*")
        .in("deposit_item_id", itemIds)
        .not("reminder_type", "is", null)
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as ReminderItem[];
    },
    enabled: !!tenantId && itemIds.length > 0,
  });

  // Team members
  const { data: team = [] } = useQuery({
    queryKey: ["deposit-team"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("role", ["staff", "admin"]);
      if (error) throw error;
      return (data ?? []) as TeamMember[];
    },
  });

  // Generate next actions
  const genMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await supabase.rpc("generate_next_deposit_action", { p_deposit_item_id: id });
      }
    },
    onSuccess: () => {
      toast({ title: "Next actions generated" });
      qc.invalidateQueries({ queryKey: ["deposit-owner-queue"] });
    },
  });

  // Bulk assign owner
  const assignMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("assign_deposit_owner", {
        p_deposit_item_ids: Array.from(selected),
        p_owner_id: bulkOwner,
        p_actor_id: user!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Owners assigned" });
      qc.invalidateQueries({ queryKey: ["deposit-owner-queue"] });
      setSelected(new Set());
      setBulkDialog(null);
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Bulk sync accounting
  const syncMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("bulk_sync_deposit_accounting", {
        p_deposit_item_ids: Array.from(selected),
        p_actor_id: user!.id,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const result = data as Record<string, number>;
      toast({ title: `Synced ${result?.synced ?? 0} items` });
      qc.invalidateQueries({ queryKey: ["deposit-owner-queue"] });
      qc.invalidateQueries({ queryKey: ["deposit-aging"] });
      setSelected(new Set());
      setBulkDialog(null);
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Bulk closeout
  const closeoutMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("bulk_deposit_closeout", {
        p_deposit_item_ids: Array.from(selected),
        p_actor_id: user!.id,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const result = data as Record<string, number>;
      toast({ title: `Closed ${result?.closed ?? 0}, skipped ${result?.skipped ?? 0}` });
      qc.invalidateQueries({ queryKey: ["deposit-owner-queue"] });
      qc.invalidateQueries({ queryKey: ["deposit-aging"] });
      setSelected(new Set());
      setBulkDialog(null);
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Bulk resolve exceptions
  const bulkResolveMutation = useMutation({
    mutationFn: async () => {
      // Get open exception IDs for selected items
      const { data: excData } = await supabase
        .from("deposit_exceptions")
        .select("id")
        .in("deposit_item_id", Array.from(selected))
        .is("resolved_at", null);
      const excIds = (excData ?? []).map((e) => e.id);
      if (excIds.length === 0) throw new Error("No open exceptions for selected items");
      const { error } = await supabase.rpc("bulk_resolve_deposit_exceptions", {
        p_exception_ids: excIds,
        p_actor_id: user!.id,
        p_resolution_notes: bulkNotes,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Exceptions resolved" });
      qc.invalidateQueries({ queryKey: ["deposit-owner-queue"] });
      qc.invalidateQueries({ queryKey: ["all-deposit-exceptions"] });
      setSelected(new Set());
      setBulkDialog(null);
      setBulkNotes("");
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Approval-aware bulk action handler
  const submitApprovalMutation = useMutation({
    mutationFn: async ({ type, description }: { type: string; description: string }) => {
      const totalAmt = Array.from(selected).reduce((sum, id) => {
        const item = items.find((i) => i.id === id);
        return sum + (item?.amount ?? 0);
      }, 0);
      const { error } = await supabase.rpc("submit_manager_approval", {
        p_approval_type: type,
        p_actor_id: user!.id,
        p_payload: { item_ids: Array.from(selected) },
        p_item_count: selected.size,
        p_total_amount: totalAmt,
        p_description: description,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Approval request submitted for manager review" });
      setSelected(new Set());
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const handleApprovalAwareAction = async (actionType: string, directAction: () => void) => {
    try {
      const { data } = await supabase.rpc("is_approval_required", { p_action_type: actionType });
      if (data === true) {
        submitApprovalMutation.mutate({
          type: actionType === "bulk_closeout" ? "bulk_closeout" : "bulk_resolve",
          description: `${actionType.replace(/_/g, " ")} for ${selected.size} items`,
        });
      } else {
        directAction();
      }
    } catch {
      directAction();
    }
  };

  const toggleAll = () => {
    if (selected.size === filteredItems.length) setSelected(new Set());
    else setSelected(new Set(filteredItems.map((i) => i.id)));
  };

  const toggle = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };

  const uniqueOwners = [...new Set(items.filter((i) => i.owner_id).map((i) => i.owner_id!))];
  const ownerScoped =
    ownerFilter === "all" ? items
    : ownerFilter === "unassigned" ? items.filter((i) => !i.owner_id)
    : ownerFilter === "mine" ? items.filter((i) => i.owner_id === user?.id)
    : items.filter((i) => i.owner_id === ownerFilter);

  const q = (searchQuery ?? "").trim().toLowerCase();
  const filteredItems = q
    ? ownerScoped.filter((i) =>
        [i.check_number, i.carrier_name].some((v) => v && v.toString().toLowerCase().includes(q))
      )
    : ownerScoped;

  return (
    <div className="space-y-4">
      {/* Reminder alerts */}
      {reminders.length > 0 && (
        <Card className="border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-400">
              <Zap className="h-4 w-4" />
              Action Required ({reminders.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-40">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check #</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Reminder</TableHead>
                    <TableHead>Exceptions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reminders.map((r) => {
                    const rl = r.reminder_type ? reminderLabels[r.reminder_type] : null;
                    return (
                      <TableRow key={r.deposit_item_id}>
                        <TableCell className="font-mono text-xs">#{r.check_number || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{fmtMoney(r.amount)}</TableCell>
                        <TableCell>
                          {rl && <Badge variant="outline" className={`text-[10px] ${rl.color}`}>{rl.label}</Badge>}
                        </TableCell>
                        <TableCell>
                          {r.open_exception_count > 0 && (
                            <Badge variant="destructive" className="text-[9px]">{r.open_exception_count}</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Bulk actions bar */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                <SelectTrigger className="w-40 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="mine">My Items</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {uniqueOwners.map((o) => (
                    <SelectItem key={o} value={o}>{o.slice(0, 8)}…</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            </div>
            <div className="flex gap-1 flex-wrap">
              <Button size="sm" variant="outline" className="text-xs h-7" disabled={items.length === 0}
                onClick={() => genMutation.mutate(items.map((i) => i.id))}>
                <Zap className="h-3 w-3 mr-1" />Generate Next Actions
              </Button>
              <Button size="sm" variant="outline" className="text-xs h-7" disabled={selected.size === 0}
                onClick={() => setBulkDialog("assign")}>
                <Users className="h-3 w-3 mr-1" />Assign Owner
              </Button>
              <Button size="sm" variant="outline" className="text-xs h-7" disabled={selected.size === 0}
                onClick={() => handleApprovalAwareAction("bulk_resolve", () => setBulkDialog("resolve"))}>
                <CheckCircle2 className="h-3 w-3 mr-1" />Resolve Exceptions
              </Button>
              <Button size="sm" variant="outline" className="text-xs h-7" disabled={selected.size === 0}
                onClick={() => handleApprovalAwareAction("bulk_closeout", () => syncMutation.mutate())}>
                <BookCheck className="h-3 w-3 mr-1" />Sync Accounting
              </Button>
              <Button size="sm" variant="outline" className="text-xs h-7" disabled={selected.size === 0}
                onClick={() => handleApprovalAwareAction("bulk_closeout", () => closeoutMutation.mutate())}>
                <Lock className="h-3 w-3 mr-1" />Bulk Closeout
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main queue table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            Deposit Work Queue ({filteredItems.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-[500px] min-h-[300px]">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading...</div>
            ) : filteredItems.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">No items in queue</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox checked={selected.size === filteredItems.length && filteredItems.length > 0} onCheckedChange={toggleAll} />
                    </TableHead>
                    <TableHead>Check #</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Next Action</TableHead>
                    <TableHead>Checklist</TableHead>
                    <TableHead>Owner</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((item) => {
                    const ac = item.next_action ? actionConfig[item.next_action] : null;
                    const AIcon = ac?.icon ?? Clock;
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Checkbox checked={selected.has(item.id)} onCheckedChange={() => toggle(item.id)} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">#{item.check_number || "—"}</TableCell>
                        <TableCell className="text-xs max-w-[100px] truncate">{item.carrier_name || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{fmtMoney(item.amount)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">{item.status.replace(/_/g, " ")}</Badge>
                        </TableCell>
                        <TableCell>
                          {ac ? (
                            <div className="flex items-center gap-1">
                              <AIcon className={`h-3 w-3 ${ac.color}`} />
                              <span className={`text-xs ${ac.color}`}>{ac.label}</span>
                            </div>
                          ) : item.next_action ? (
                            <span className="text-xs text-muted-foreground">{item.next_action}</span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-0.5">
                            <Badge variant="outline" className={`text-[8px] ${item.cleared_at ? "text-emerald-400 border-emerald-500/50" : "text-muted-foreground"}`}>DEP</Badge>
                            <Badge variant="outline" className={`text-[8px] ${item.bank_confirmed_at ? "text-emerald-400 border-emerald-500/50" : "text-muted-foreground"}`}>BNK</Badge>
                            <Badge variant="outline" className={`text-[8px] ${item.reconciled_at ? "text-emerald-400 border-emerald-500/50" : "text-muted-foreground"}`}>REC</Badge>
                            <Badge variant="outline" className={`text-[8px] ${item.accounting_synced_at ? "text-emerald-400 border-emerald-500/50" : "text-muted-foreground"}`}>ACC</Badge>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-[10px] text-muted-foreground">
                            {item.owner_id ? item.owner_id.slice(0, 8) + "…" : "—"}
                          </span>
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

      {/* Bulk assign dialog */}
      <Dialog open={bulkDialog === "assign"} onOpenChange={() => setBulkDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Assign Owner</DialogTitle></DialogHeader>
          <Select value={bulkOwner} onValueChange={setBulkOwner}>
            <SelectTrigger><SelectValue placeholder="Select team member" /></SelectTrigger>
            <SelectContent>
              {team.map((t) => (
                <SelectItem key={t.user_id} value={t.user_id}>
                  {t.user_id.slice(0, 8)}…
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialog(null)}>Cancel</Button>
            <Button disabled={!bulkOwner || assignMutation.isPending} onClick={() => assignMutation.mutate()}>
              {assignMutation.isPending ? "Assigning..." : `Assign to ${selected.size} items`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk resolve dialog */}
      <Dialog open={bulkDialog === "resolve"} onOpenChange={() => { setBulkDialog(null); setBulkNotes(""); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Bulk Resolve Exceptions</DialogTitle></DialogHeader>
          <Textarea
            placeholder="Resolution notes (required)"
            value={bulkNotes}
            onChange={(e) => setBulkNotes(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setBulkDialog(null); setBulkNotes(""); }}>Cancel</Button>
            <Button
              disabled={!bulkNotes.trim() || bulkResolveMutation.isPending}
              onClick={() => bulkResolveMutation.mutate()}
            >
              {bulkResolveMutation.isPending ? "Resolving..." : "Resolve All"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
