import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Users, RefreshCw, BarChart3, AlertTriangle, Clock,
  ShieldCheck, Download, Zap, Scale, BookCheck, Landmark, Lock,
  TrendingUp, ArrowUpDown, CheckCircle2, XCircle, Bell,
  Shield, Settings, FileText, Package,
} from "lucide-react";
import { format } from "date-fns";

const fmtMoney = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00";

/* ------------------------------------------------------------------ */
/*  Snapshot Trends                                                    */
/* ------------------------------------------------------------------ */
function SnapshotTrends() {
  const { data: snapshots = [] } = useQuery({
    queryKey: ["deposit-manager-snapshots"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_manager_snapshots")
        .select("*")
        .order("snapshot_date", { ascending: false })
        .limit(14);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  if (snapshots.length === 0) return <div className="p-8 text-center text-muted-foreground">No snapshots yet — run daily automation or click "Save Snapshot"</div>;

  return (
    <ScrollArea className="max-h-[400px]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Open Items</TableHead>
            <TableHead className="text-right">Open Exc</TableHead>
            <TableHead className="text-right">Avg Close (d)</TableHead>
            <TableHead className="text-right">NSF Rate</TableHead>
            <TableHead className="text-right">Owners</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {snapshots.map((s) => {
            const kpi = (s.kpi_data as Record<string, unknown>) ?? {};
            const exc = (s.exception_data as Record<string, unknown>) ?? {};
            const owners = (s.owner_data as unknown[]) ?? [];
            return (
              <TableRow key={s.id as string}>
                <TableCell className="text-sm">{format(new Date(s.snapshot_date as string), "MMM d, yyyy")}</TableCell>
                <TableCell className="text-right tabular-nums">{(kpi.in_pipeline as number) ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{(exc.open_count as number) ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{(kpi.avg_days_to_closeout as number) ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{kpi.nsf_rate_pct != null ? `${kpi.nsf_rate_pct}%` : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{owners.length}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

/* ------------------------------------------------------------------ */
/*  Notification Preferences                                           */
/* ------------------------------------------------------------------ */
function NotificationPreferences() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: prefs } = useQuery({
    queryKey: ["deposit-notification-prefs", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_notification_prefs")
        .select("*")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as Record<string, unknown> | null;
    },
    enabled: !!user,
  });

  const saveMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      if (prefs) {
        const { error } = await supabase
          .from("deposit_notification_prefs")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("user_id", user!.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("deposit_notification_prefs")
          .insert({ user_id: user!.id, ...updates });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast({ title: "Preferences saved" });
      qc.invalidateQueries({ queryKey: ["deposit-notification-prefs"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const togglePref = (key: string, value: boolean) => saveMutation.mutate({ [key]: value });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><Bell className="h-4 w-4" />Notification Preferences</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Digest Frequency</Label>
          <Select value={(prefs?.digest_frequency as string) ?? "daily"} onValueChange={(v) => saveMutation.mutate({ digest_frequency: v })}>
            <SelectTrigger className="w-28 h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {[
          { key: "notify_sla_breach", label: "SLA breach alerts" },
          { key: "notify_exception_assigned", label: "Exception assigned to me" },
          { key: "notify_rebalance", label: "Workload rebalance events" },
          { key: "notify_closeout_ready", label: "Closeout-ready items" },
        ].map((p) => (
          <div key={p.key} className="flex items-center justify-between">
            <Label className="text-xs">{p.label}</Label>
            <Switch checked={(prefs?.[p.key] as boolean) ?? true} onCheckedChange={(v) => togglePref(p.key, v)} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Escalation Rules Config                                            */
/* ------------------------------------------------------------------ */
function EscalationRulesConfig() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: rules = [] } = useQuery({
    queryKey: ["deposit-escalation-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_escalation_rules")
        .select("*")
        .order("priority", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("deposit_escalation_rules")
        .update({ is_active, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Rule updated" });
      qc.invalidateQueries({ queryKey: ["deposit-escalation-rules"] });
    },
  });

  const triggerLabels: Record<string, string> = {
    stale_exception: "Stale Exception",
    unreconciled_cash: "Unreconciled Cash",
    unsynced_accounting: "Unsynced Accounting",
    unassigned_item: "Unassigned Item",
    sla_breach: "SLA Breach",
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><Shield className="h-4 w-4" />Escalation Rules</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead className="text-right">Threshold</TableHead>
              <TableHead>Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((r) => (
              <TableRow key={r.id as string}>
                <TableCell className="text-xs font-medium">{r.rule_name as string}</TableCell>
                <TableCell><Badge variant="outline" className="text-[10px]">{triggerLabels[r.trigger_type as string] ?? (r.trigger_type as string)}</Badge></TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {r.threshold_days as number}d {(r.threshold_amount as number) > 0 && `/ ${fmtMoney(r.threshold_amount as number)}`}
                </TableCell>
                <TableCell>
                  <Switch checked={r.is_active as boolean} onCheckedChange={(v) => toggleMutation.mutate({ id: r.id as string, is_active: v })} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Escalation Events                                                  */
/* ------------------------------------------------------------------ */
function EscalationEventsPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: events = [] } = useQuery({
    queryKey: ["deposit-escalation-events"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_escalation_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (eventId: string) => {
      const { error } = await supabase
        .from("deposit_escalation_events")
        .update({ is_resolved: true, resolved_at: new Date().toISOString(), resolved_by: user!.id })
        .eq("id", eventId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Escalation resolved" });
      qc.invalidateQueries({ queryKey: ["deposit-escalation-events"] });
    },
  });

  const openEvents = events.filter((e) => !(e.is_resolved as boolean));
  const resolvedEvents = events.filter((e) => e.is_resolved as boolean);

  const typeColors: Record<string, string> = {
    stale_exception: "text-destructive",
    unreconciled_cash: "text-amber-400",
    unsynced_accounting: "text-purple-400",
    unassigned_item: "text-orange-400",
    sla_breach: "text-destructive",
    owner_overload: "text-amber-400",
  };

  return (
    <div className="space-y-3">
      {openEvents.length > 0 && (
        <Card className="border-destructive/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />Open Escalations ({openEvents.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[300px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openEvents.map((e) => (
                    <TableRow key={e.id as string}>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${typeColors[e.escalation_type as string] ?? ""}`}>
                          {(e.escalation_type as string).replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs max-w-[250px] truncate">{e.message as string}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{format(new Date(e.created_at as string), "MMM d h:mm a")}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" className="text-xs h-6" onClick={() => resolveMutation.mutate(e.id as string)}>
                          <CheckCircle2 className="h-3 w-3 mr-1" />Resolve
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
      {resolvedEvents.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Resolved ({resolvedEvents.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[200px]">
              <Table>
                <TableBody>
                  {resolvedEvents.slice(0, 10).map((e) => (
                    <TableRow key={e.id as string} className="opacity-60">
                      <TableCell><Badge variant="outline" className="text-[9px]">{(e.escalation_type as string).replace(/_/g, " ")}</Badge></TableCell>
                      <TableCell className="text-xs max-w-[250px] truncate">{e.message as string}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{format(new Date(e.created_at as string), "MMM d")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
      {events.length === 0 && <div className="p-8 text-center text-muted-foreground">No escalation events</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Pending Approvals                                                  */
/* ------------------------------------------------------------------ */
function PendingApprovalsPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reviewDialog, setReviewDialog] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");

  const { data: approvals = [] } = useQuery({
    queryKey: ["deposit-pending-approvals"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_pending_approvals")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, decision }: { id: string; decision: string }) => {
      const { data, error } = await supabase.rpc("review_manager_approval", {
        p_approval_id: id,
        p_reviewer_id: user!.id,
        p_decision: decision,
        p_notes: reviewNotes || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const result = data as Record<string, unknown>;
      toast({ title: `Approval ${result.decision}` });
      qc.invalidateQueries({ queryKey: ["deposit-pending-approvals"] });
      qc.invalidateQueries({ queryKey: ["deposit-owner-queue"] });
      setReviewDialog(null);
      setReviewNotes("");
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");

  const typeLabels: Record<string, string> = {
    rebalance: "Workload Rebalance",
    bulk_closeout: "Bulk Closeout",
    bulk_resolve: "Bulk Exception Resolution",
  };

  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <Card className="border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-400">
              <Clock className="h-4 w-4" />Pending Approvals ({pending.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((a) => (
                  <TableRow key={a.id as string}>
                    <TableCell><Badge variant="outline" className="text-[10px]">{typeLabels[a.approval_type as string] ?? (a.approval_type as string)}</Badge></TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{(a.description as string) || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{a.item_count as number}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{fmtMoney(a.total_amount as number)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{format(new Date(a.created_at as string), "MMM d h:mm a")}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" className="text-xs h-6 text-emerald-400" onClick={() => { setReviewDialog(a.id as string); }}>
                          <CheckCircle2 className="h-3 w-3 mr-1" />Approve
                        </Button>
                        <Button size="sm" variant="outline" className="text-xs h-6 text-destructive" onClick={() => reviewMutation.mutate({ id: a.id as string, decision: "rejected" })}>
                          <XCircle className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {resolved.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">History ({resolved.length})</CardTitle></CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[200px]">
              <Table>
                <TableBody>
                  {resolved.map((a) => (
                    <TableRow key={a.id as string} className="opacity-60">
                      <TableCell><Badge variant="outline" className="text-[9px]">{typeLabels[a.approval_type as string] ?? (a.approval_type as string)}</Badge></TableCell>
                      <TableCell className="text-xs">{(a.description as string) || "—"}</TableCell>
                      <TableCell><Badge variant={a.status === "approved" ? "default" : "destructive"} className="text-[9px]">{a.status as string}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{format(new Date(a.created_at as string), "MMM d")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {approvals.length === 0 && <div className="p-8 text-center text-muted-foreground">No approval requests</div>}

      {/* Approve dialog */}
      <Dialog open={!!reviewDialog} onOpenChange={() => { setReviewDialog(null); setReviewNotes(""); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Approve Action</DialogTitle></DialogHeader>
          <Textarea placeholder="Optional notes…" value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewDialog(null)}>Cancel</Button>
            <Button onClick={() => reviewMutation.mutate({ id: reviewDialog!, decision: "approved" })} disabled={reviewMutation.isPending}>Approve & Execute</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Manager Export Bundle                                               */
/* ------------------------------------------------------------------ */
function ManagerExportBundle() {
  const { user } = useAuth();
  const { toast } = useToast();

  const exportBundle = async () => {
    try {
      // Gather all data
      const [kpiRes, excRes, queueRes, ownersRes, digestRes] = await Promise.all([
        supabase.rpc("get_deposit_ops_kpis"),
        supabase.rpc("get_deposit_exception_kpis"),
        supabase.from("deposit_queue_scored").select("*").order("priority_score", { ascending: false }).limit(50),
        supabase.from("deposit_owner_performance").select("*").not("owner_id", "is", null),
        supabase.from("deposit_daily_digest").select("*").order("digest_date", { ascending: false }).limit(1).single(),
      ]);

      const bundle = {
        exported_at: new Date().toISOString(),
        exported_by: user?.id,
        kpi_summary: kpiRes.data ?? {},
        exception_kpis: excRes.data ?? {},
        priority_queue: queueRes.data ?? [],
        owner_workloads: ownersRes.data ?? [],
        latest_digest: digestRes.data ?? {},
      };

      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deposit-manager-bundle-${format(new Date(), "yyyy-MM-dd")}.json`;
      a.click();
      URL.revokeObjectURL(url);

      // Also export CSV version of queue
      const queueRows = (queueRes.data ?? []) as Record<string, unknown>[];
      if (queueRows.length > 0) {
        const keys = Object.keys(queueRows[0]);
        const csv = [keys.join(","), ...queueRows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(","))].join("\n");
        const csvBlob = new Blob([csv], { type: "text/csv" });
        const csvUrl = URL.createObjectURL(csvBlob);
        const csvA = document.createElement("a");
        csvA.href = csvUrl;
        csvA.download = `deposit-priority-queue-${format(new Date(), "yyyy-MM-dd")}.csv`;
        csvA.click();
        URL.revokeObjectURL(csvUrl);
      }

      toast({ title: "Export bundle downloaded (JSON + CSV)" });
    } catch (e) {
      toast({ title: "Export failed", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><Package className="h-4 w-4" />Manager Export Bundle</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Downloads a combined report: KPI summary, priority queue (CSV), owner workloads, open exceptions, and latest daily digest.
        </p>
        <Button onClick={exportBundle}><Download className="h-4 w-4 mr-2" />Download Bundle</Button>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Submit Approval Request                                            */
/* ------------------------------------------------------------------ */
function SubmitApprovalButton({ type, itemIds, amount, description, onSuccess }: {
  type: string; itemIds: string[]; amount: number; description: string; onSuccess?: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("submit_manager_approval", {
        p_approval_type: type,
        p_actor_id: user!.id,
        p_payload: { item_ids: itemIds },
        p_item_count: itemIds.length,
        p_total_amount: amount,
        p_description: description,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Approval request submitted" });
      onSuccess?.();
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Button size="sm" variant="outline" className="text-xs" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
      <FileText className="h-3 w-3 mr-1" />Request Approval
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Exported Components                                           */
/* ------------------------------------------------------------------ */
export { SnapshotTrends, NotificationPreferences, EscalationRulesConfig, EscalationEventsPanel, PendingApprovalsPanel, ManagerExportBundle, SubmitApprovalButton };
