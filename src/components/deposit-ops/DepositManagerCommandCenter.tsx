import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Users, RefreshCw, BarChart3, Clock,
  Download, Zap, ArrowUpDown, Camera, Shield, FileText, Mail,
  Activity, TrendingUp,
} from "lucide-react";
import { format } from "date-fns";
import {
  SnapshotTrends, NotificationPreferences, EscalationRulesConfig,
  EscalationEventsPanel, PendingApprovalsPanel, ManagerExportBundle,
} from "./DepositManagerWorkflows";
import {
  AutomationHealthCard, AutomationRunHistory, DigestDeliveryCenter, AutomationSettingsPanel,
} from "./DepositAutomationHealth";
import { PendingApprovalDeposits } from "@/components/settings/CheckAltSettings";

const fmtMoney = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00";

interface ManagerScopedItem {
  id: string;
  owner_id: string | null;
  amount: number | null;
  check_number: string | null;
  carrier_name: string | null;
  next_action: string | null;
  created_at: string;
  status: string;
}

function OwnerPerformanceTable() {
  const { tenantId } = useTenantFilter();
  const { data: items = [] } = useQuery({
    queryKey: ["deposit-owner-performance", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("id, owner_id, amount, status, closeout_complete, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!);
      if (error) throw error;
      return (data ?? []) as Array<Record<string, unknown>>;
    },
    enabled: !!tenantId,
  });

  const perf = useMemo(() => {
    const grouped = new Map<string, Record<string, number | string>>();
    items.forEach((item) => {
      const ownerId = (item.owner_id as string | null) ?? "unassigned";
      const current = grouped.get(ownerId) ?? {
        owner_id: ownerId,
        open_items: 0,
        total_closed: 0,
        open_amount: 0,
        avg_days_to_closeout: 0,
        avg_days_to_confirm: 0,
        nsf_count: 0,
        sla_breaches: 0,
      };
      const isClosed = Boolean(item.closeout_complete);
      current.open_items = Number(current.open_items) + (isClosed ? 0 : 1);
      current.total_closed = Number(current.total_closed) + (isClosed ? 1 : 0);
      current.open_amount = Number(current.open_amount) + (isClosed ? 0 : Number(item.amount ?? 0));
      grouped.set(ownerId, current);
    });
    return Array.from(grouped.values());
  }, [items]);

  if (perf.length === 0) return <div className="p-8 text-center text-muted-foreground">No owner data</div>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Owner</TableHead>
          <TableHead className="text-right">Open</TableHead>
          <TableHead className="text-right">Closed</TableHead>
          <TableHead className="text-right">Open $</TableHead>
          <TableHead className="text-right">Avg Close (d)</TableHead>
          <TableHead className="text-right">Avg Confirm (d)</TableHead>
          <TableHead className="text-right">NSF</TableHead>
          <TableHead className="text-right">SLA ⚠</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {perf.map((p) => (
          <TableRow key={p.owner_id as string}>
            <TableCell className="font-mono text-xs">{(p.owner_id as string)?.slice(0, 8)}…</TableCell>
            <TableCell className="text-right tabular-nums">{p.open_items as number}</TableCell>
            <TableCell className="text-right tabular-nums text-emerald-400">{p.total_closed as number}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtMoney(p.open_amount as number)}</TableCell>
            <TableCell className="text-right tabular-nums">—</TableCell>
            <TableCell className="text-right tabular-nums">—</TableCell>
            <TableCell className="text-right">0</TableCell>
            <TableCell className="text-right">0</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ScoredQueue() {
  const { tenantId } = useTenantFilter();
  const { data: items = [] } = useQuery({
    queryKey: ["deposit-manager-scored-queue", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("id, owner_id, amount, check_number, carrier_name, next_action, created_at, status, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return ((data ?? []) as Array<ManagerScopedItem & { check_intake_items?: { tenant_id: string | null } | null }>).map(({ check_intake_items, ...item }) => item);
    },
    enabled: !!tenantId,
  });

  return (
    <ScrollArea className="max-h-[500px]">
      {items.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground">Queue empty</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Score</TableHead>
              <TableHead>Check #</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Next Action</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Exc</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item, index) => (
              <TableRow key={item.id}>
                <TableCell>
                  <Badge variant={index < 5 ? "destructive" : "outline"} className="text-xs tabular-nums">
                    {Math.max(1, 50 - index)}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">#{item.check_number || "—"}</TableCell>
                <TableCell className="text-xs max-w-[100px] truncate">{item.carrier_name || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{fmtMoney(item.amount as number)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">{item.next_action || "—"}</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{item.owner_id?.slice(0, 8) ?? "unassigned"}</TableCell>
                <TableCell />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ScrollArea>
  );
}

function RollupReport() {
  const [period, setPeriod] = useState("day");
  const { tenantId } = useTenantFilter();
  const { data: items = [] } = useQuery({
    queryKey: ["deposit-manager-rollup", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("id, amount, created_at, owner_id, nsf_flag, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Array<Record<string, unknown>>;
    },
    enabled: !!tenantId,
  });

  const rollup = useMemo(() => items.map((row) => ({
    period_date: String(row.created_at ?? "").slice(0, 10),
    items_created: 1,
    items_closed: 0,
    total_amount: Number(row.amount ?? 0),
    nsf_count: row.nsf_flag ? 1 : 0,
    active_owners: row.owner_id ? 1 : 0,
  })), [items]);

  const grouped = period === "day" ? rollup : rollup.reduce((acc, row) => {
    const d = new Date(row.period_date as string);
    const key = period === "week" ? format(d, "yyyy-'W'ww") : format(d, "yyyy-MM");
    const existing = acc.find((a: Record<string, unknown>) => a._key === key);
    if (existing) {
      (existing.items_created as number) += (row.items_created as number) || 0;
      (existing.items_closed as number) += (row.items_closed as number) || 0;
      (existing.total_amount as number) += (row.total_amount as number) || 0;
      (existing.nsf_count as number) += (row.nsf_count as number) || 0;
      (existing.active_owners as number) += (row.active_owners as number) || 0;
    } else {
      acc.push({ ...row, _key: key, period_date: key });
    }
    return acc;
  }, [] as Record<string, unknown>[]);

  function exportCSV(rows: Record<string, unknown>[], filename: string) {
    if (rows.length === 0) return;
    const keys = Object.keys(rows[0]).filter(k => k !== '_key');
    const csv = [keys.join(","), ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Daily</SelectItem>
              <SelectItem value="week">Weekly</SelectItem>
              <SelectItem value="month">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => exportCSV(grouped, `rollup-${period}-${format(new Date(), "yyyy-MM-dd")}.csv`)}>
          <Download className="h-3 w-3 mr-1" />CSV
        </Button>
      </div>
      <ScrollArea className="max-h-[400px]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Created</TableHead>
              <TableHead className="text-right">Closed</TableHead>
              <TableHead className="text-right">Total $</TableHead>
              <TableHead className="text-right">NSF</TableHead>
              <TableHead className="text-right">Owners</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grouped.map((row, i) => (
              <TableRow key={i}>
                <TableCell className="text-sm">{row.period_date as string}</TableCell>
                <TableCell className="text-right tabular-nums">{row.items_created as number}</TableCell>
                <TableCell className="text-right tabular-nums text-emerald-400">{row.items_closed as number}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(row.total_amount as number)}</TableCell>
                <TableCell className="text-right">{(row.nsf_count as number) > 0 ? <Badge variant="destructive" className="text-[9px]">{row.nsf_count as number}</Badge> : "0"}</TableCell>
                <TableCell className="text-right tabular-nums">{(row.active_owners as number) ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Daily Digest Panel                                                 */
/* ------------------------------------------------------------------ */
function DailyDigestPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: digests = [] } = useQuery({
    queryKey: ["deposit-daily-digests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_daily_digest")
        .select("*")
        .order("digest_date", { ascending: false })
        .limit(14);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const genMutation = useMutation({
    mutationFn: async (type: string) => {
      const { data, error } = await supabase.rpc("generate_deposit_daily_digest", {
        p_actor_id: user!.id,
        p_digest_type: type,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Digest generated" });
      qc.invalidateQueries({ queryKey: ["deposit-daily-digests"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => genMutation.mutate("daily")} disabled={genMutation.isPending}>
          <Zap className="h-3 w-3 mr-1" />Generate Daily Digest
        </Button>
        <Button size="sm" variant="outline" onClick={() => genMutation.mutate("weekly")} disabled={genMutation.isPending}>
          Weekly
        </Button>
        <Button size="sm" variant="outline" onClick={() => genMutation.mutate("monthly")} disabled={genMutation.isPending}>
          Monthly
        </Button>
      </div>
      <ScrollArea className="max-h-[500px]">
        {digests.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">No digests yet — generate one above</div>
        ) : (
          <div className="space-y-3">
            {digests.map((d) => (
              <Card key={d.id as string}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">
                      {format(new Date(d.digest_date as string), "MMM d, yyyy")} — <Badge variant="outline" className="text-[10px]">{d.digest_type as string}</Badge>
                    </CardTitle>
                    <span className="text-[10px] text-muted-foreground">{format(new Date(d.generated_at as string), "h:mm a")}</span>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center">
                    <div>
                      <p className="text-lg font-bold tabular-nums">{d.total_open_items as number}</p>
                      <p className="text-[9px] text-muted-foreground">Open Items</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold tabular-nums">{fmtMoney(d.total_open_amount as number)}</p>
                      <p className="text-[9px] text-muted-foreground">Open $</p>
                    </div>
                    <div>
                      <p className={`text-lg font-bold tabular-nums ${(d.open_exceptions_count as number) > 0 ? "text-destructive" : "text-emerald-400"}`}>{d.open_exceptions_count as number}</p>
                      <p className="text-[9px] text-muted-foreground">Open Exc</p>
                    </div>
                    <div>
                      <p className={`text-lg font-bold tabular-nums ${(d.sla_breaches_count as number) > 0 ? "text-destructive" : "text-emerald-400"}`}>{d.sla_breaches_count as number}</p>
                      <p className="text-[9px] text-muted-foreground">SLA ⚠</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold tabular-nums text-amber-400">{fmtMoney(d.unreconciled_cash as number)}</p>
                      <p className="text-[9px] text-muted-foreground">Unrecon $</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold tabular-nums text-emerald-400">{d.closeout_ready_count as number}</p>
                      <p className="text-[9px] text-muted-foreground">Ready ✓</p>
                    </div>
                  </div>
                  {/* Owner workloads */}
                  {(d.owner_workloads as unknown[])?.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[10px] text-muted-foreground mb-1">Owner Workloads</p>
                      <div className="flex flex-wrap gap-1">
                        {(d.owner_workloads as Record<string, unknown>[]).map((ow, i) => (
                          <Badge key={i} variant="outline" className="text-[9px]">
                            {(ow.owner_id as string)?.slice(0, 6)}… {ow.open_items as number} items
                            {(ow.sla_breaches as number) > 0 && <span className="text-destructive ml-1">⚠{ow.sla_breaches as number}</span>}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Manager Command Center                                        */
/* ------------------------------------------------------------------ */
interface DepositManagerCommandCenterProps {
  searchQuery?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function DepositManagerCommandCenter({ searchQuery: _searchQuery = "" }: DepositManagerCommandCenterProps = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("refresh_all_deposit_next_actions", { p_actor_id: user!.id });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const result = data as Record<string, number>;
      toast({ title: `Refreshed ${result?.refreshed ?? 0} items` });
      qc.invalidateQueries({ queryKey: ["deposit-queue-scored"] });
      qc.invalidateQueries({ queryKey: ["deposit-owner-queue"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const rebalanceMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("rebalance_deposit_workload", { p_actor_id: user!.id });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const result = data as Record<string, number>;
      toast({ title: `Rebalanced ${result?.reassigned ?? 0} items across ${result?.staff_count ?? 0} staff` });
      qc.invalidateQueries({ queryKey: ["deposit-owner-performance"] });
      qc.invalidateQueries({ queryKey: ["deposit-owner-queue"] });
      qc.invalidateQueries({ queryKey: ["deposit-queue-scored"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const snapshotMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("save_deposit_manager_snapshot", { p_actor_id: user!.id });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Snapshot saved" });
      qc.invalidateQueries({ queryKey: ["deposit-manager-snapshots"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const escalationMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("run_deposit_escalation_check", { p_actor_id: user!.id });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const result = data as Record<string, number>;
      toast({ title: `Escalation check: ${result?.escalations_created ?? 0} new` });
      qc.invalidateQueries({ queryKey: ["deposit-escalation-events"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Approval-aware rebalance
  const handleRebalance = async () => {
    try {
      const { data } = await supabase.rpc("is_approval_required", { p_action_type: "rebalance" });
      if (data === true) {
        const { error } = await supabase.rpc("submit_manager_approval", {
          p_approval_type: "rebalance",
          p_actor_id: user!.id,
          p_payload: {},
          p_item_count: 0,
          p_total_amount: 0,
          p_description: "Workload rebalance request",
        });
        if (error) throw error;
        toast({ title: "Rebalance submitted for approval" });
        qc.invalidateQueries({ queryKey: ["deposit-pending-approvals"] });
      } else {
        rebalanceMutation.mutate();
      }
    } catch {
      rebalanceMutation.mutate();
    }
  };

  return (
    <div className="space-y-4">
      {/* Automation Health Card */}
      <AutomationHealthCard />

      {/* Action bar */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => refreshMutation.mutate()} disabled={refreshMutation.isPending}>
                <RefreshCw className={`h-3 w-3 mr-1 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
                Refresh Actions
              </Button>
              <Button size="sm" variant="outline" onClick={handleRebalance} disabled={rebalanceMutation.isPending}>
                <ArrowUpDown className="h-3 w-3 mr-1" />
                Rebalance
              </Button>
              <Button size="sm" variant="outline" onClick={() => snapshotMutation.mutate()} disabled={snapshotMutation.isPending}>
                <Camera className="h-3 w-3 mr-1" />
                Save Snapshot
              </Button>
              <Button size="sm" variant="outline" onClick={() => escalationMutation.mutate()} disabled={escalationMutation.isPending}>
                <Shield className="h-3 w-3 mr-1" />
                Run Escalations
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="queue" className="space-y-3">
        <TabsList className="flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="queue" className="text-xs">Priority Queue</TabsTrigger>
          <TabsTrigger value="owners" className="text-xs">Owners</TabsTrigger>
          <TabsTrigger value="approvals" className="text-xs">Approvals</TabsTrigger>
          <TabsTrigger value="escalations" className="text-xs">Escalations</TabsTrigger>
          <TabsTrigger value="digest" className="text-xs">Digest</TabsTrigger>
          <TabsTrigger value="delivery" className="text-xs">Delivery</TabsTrigger>
          <TabsTrigger value="automation" className="text-xs">Automation</TabsTrigger>
          <TabsTrigger value="trends" className="text-xs">Trends</TabsTrigger>
          <TabsTrigger value="rollup" className="text-xs">Rollup</TabsTrigger>
          <TabsTrigger value="settings" className="text-xs">Settings</TabsTrigger>
          <TabsTrigger value="export" className="text-xs">Export</TabsTrigger>
        </TabsList>

        <TabsContent value="queue">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" />Priority-Scored Queue
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScoredQueue />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="owners">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />Owner Performance Metrics
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[500px]">
                <OwnerPerformanceTable />
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="approvals" className="space-y-3">
          <PendingApprovalsPanel />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Shield className="h-4 w-4 text-amber-400" />
                Deposit Manual Review
              </CardTitle>
            </CardHeader>
            <CardContent>
              <PendingApprovalDeposits />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="escalations">
          <EscalationEventsPanel />
        </TabsContent>

        <TabsContent value="digest">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-400" />Daily Digest
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DailyDigestPanel />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="delivery">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Mail className="h-4 w-4 text-primary" />Digest Delivery Center
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DigestDeliveryCenter />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="automation">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />Automation Run History
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <AutomationRunHistory />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="trends">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />KPI Trends (Day-over-Day)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <SnapshotTrends />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rollup">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />Manager Rollup Reports
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RollupReport />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings">
          <div className="grid md:grid-cols-2 gap-4">
            <AutomationSettingsPanel />
            <NotificationPreferences />
            <EscalationRulesConfig />
          </div>
        </TabsContent>

        <TabsContent value="export">
          <ManagerExportBundle />
        </TabsContent>
      </Tabs>
    </div>
  );
}
