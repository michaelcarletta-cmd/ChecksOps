import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Activity, CheckCircle2, XCircle, Clock, Zap,
  AlertTriangle, RefreshCw, Send, Settings, Users,
  Mail, RotateCw,
} from "lucide-react";
import { format } from "date-fns";

/* ------------------------------------------------------------------ */
/*  Automation Health Dashboard Card                                   */
/* ------------------------------------------------------------------ */
export function AutomationHealthCard() {
  const { data: runs = [] } = useQuery({
    queryKey: ["deposit-automation-runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_automation_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(14);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const lastRun = runs[0];
  const lastSuccess = runs.find((r) => r.status === "completed");
  const lastFailure = runs.find((r) => r.status === "failed" || r.status === "partial_failure");

  const statusColor: Record<string, string> = {
    completed: "text-emerald-400",
    partial_failure: "text-amber-400",
    failed: "text-destructive",
    running: "text-blue-400",
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          Automation Health
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!lastRun ? (
          <p className="text-sm text-muted-foreground text-center py-4">No automation runs yet</p>
        ) : (
          <div className="space-y-3">
            {/* Status cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="text-center">
                <p className="text-[10px] text-muted-foreground">Last Run</p>
                <p className={`text-sm font-bold ${statusColor[lastRun.status as string] ?? ""}`}>
                  {(lastRun.status as string).replace(/_/g, " ")}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {format(new Date(lastRun.started_at as string), "MMM d h:mm a")}
                </p>
              </div>
              <div className="text-center">
                <p className="text-[10px] text-muted-foreground">Last Success</p>
                <p className="text-sm font-bold text-emerald-400">
                  {lastSuccess ? format(new Date(lastSuccess.started_at as string), "MMM d") : "—"}
                </p>
              </div>
              <div className="text-center">
                <p className="text-[10px] text-muted-foreground">Last Failure</p>
                <p className="text-sm font-bold text-destructive">
                  {lastFailure ? format(new Date(lastFailure.started_at as string), "MMM d") : "None"}
                </p>
              </div>
              <div className="text-center">
                <p className="text-[10px] text-muted-foreground">Duration</p>
                <p className="text-sm font-bold tabular-nums">
                  {lastRun.duration_ms != null ? `${((lastRun.duration_ms as number) / 1000).toFixed(1)}s` : "—"}
                </p>
              </div>
            </div>

            {/* Last run metrics */}
            <div className="grid grid-cols-5 gap-2 text-center">
              <div>
                <p className="text-lg font-bold tabular-nums text-emerald-400">
                  {((lastRun.steps_completed as unknown[]) ?? []).length}
                </p>
                <p className="text-[9px] text-muted-foreground">Steps ✓</p>
              </div>
              <div>
                <p className={`text-lg font-bold tabular-nums ${((lastRun.steps_failed as unknown[]) ?? []).length > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                  {((lastRun.steps_failed as unknown[]) ?? []).length}
                </p>
                <p className="text-[9px] text-muted-foreground">Steps ✗</p>
              </div>
              <div>
                <p className="text-lg font-bold tabular-nums">{lastRun.refresh_count as number ?? 0}</p>
                <p className="text-[9px] text-muted-foreground">Refreshed</p>
              </div>
              <div>
                <p className="text-lg font-bold tabular-nums">{lastRun.escalations_created as number ?? 0}</p>
                <p className="text-[9px] text-muted-foreground">Escalations</p>
              </div>
              <div>
                <p className="text-lg font-bold tabular-nums">{lastRun.deliveries_sent as number ?? 0}</p>
                <p className="text-[9px] text-muted-foreground">Deliveries</p>
              </div>
            </div>

            {/* Overload flags */}
            {((lastRun.overload_flags as unknown[]) ?? []).length > 0 && (
              <div className="border border-amber-500/30 rounded p-2">
                <p className="text-[10px] text-amber-400 mb-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />Owner Overloads
                </p>
                <div className="flex flex-wrap gap-1">
                  {(lastRun.overload_flags as Record<string, unknown>[]).map((f, i) => (
                    <Badge key={i} variant="outline" className="text-[9px] text-amber-400">
                      {(f.owner_id as string)?.slice(0, 6)}… ({f.open_items as number} items)
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Error summary */}
            {lastRun.error_summary && (
              <div className="border border-destructive/30 rounded p-2">
                <p className="text-[10px] text-destructive mb-1">Error Summary</p>
                <p className="text-xs text-muted-foreground">{lastRun.error_summary as string}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Automation Run History                                             */
/* ------------------------------------------------------------------ */
export function AutomationRunHistory() {
  const { data: runs = [] } = useQuery({
    queryKey: ["deposit-automation-runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_automation_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = {
      completed: "text-emerald-400 border-emerald-500/50",
      partial_failure: "text-amber-400 border-amber-500/50",
      failed: "text-destructive border-destructive/50",
      running: "text-blue-400 border-blue-500/50",
    };
    return <Badge variant="outline" className={`text-[10px] ${colors[s] ?? ""}`}>{s.replace(/_/g, " ")}</Badge>;
  };

  return (
    <ScrollArea className="max-h-[400px]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Steps</TableHead>
            <TableHead className="text-right">Refreshed</TableHead>
            <TableHead className="text-right">Escalations</TableHead>
            <TableHead className="text-right">Deliveries</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((r) => (
            <TableRow key={r.id as string}>
              <TableCell className="text-xs">{format(new Date(r.started_at as string), "MMM d h:mm a")}</TableCell>
              <TableCell>{statusBadge(r.status as string)}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {r.duration_ms != null ? `${((r.duration_ms as number) / 1000).toFixed(1)}s` : "—"}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                <span className="text-emerald-400">{((r.steps_completed as unknown[]) ?? []).length}</span>
                {((r.steps_failed as unknown[]) ?? []).length > 0 && (
                  <span className="text-destructive ml-1">/ {((r.steps_failed as unknown[]) ?? []).length} ✗</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs">{r.refresh_count as number}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">{r.escalations_created as number}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">{r.deliveries_sent as number}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

/* ------------------------------------------------------------------ */
/*  Digest Delivery Center                                             */
/* ------------------------------------------------------------------ */
export function DigestDeliveryCenter() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: deliveries = [] } = useQuery({
    queryKey: ["deposit-digest-deliveries"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_digest_delivery_log")
        .select("*")
        .order("delivered_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const resendMutation = useMutation({
    mutationFn: async (deliveryId: string) => {
      const { error } = await supabase
        .from("deposit_digest_delivery_log")
        .update({
          resent_at: new Date().toISOString(),
          resent_by: user!.id,
          delivery_status: "resent",
        })
        .eq("id", deliveryId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Digest marked for resend" });
      qc.invalidateQueries({ queryKey: ["deposit-digest-deliveries"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const statusColor: Record<string, string> = {
    pending: "text-amber-400",
    delivered: "text-emerald-400",
    failed: "text-destructive",
    resent: "text-blue-400",
  };

  return (
    <div className="space-y-3">
      {deliveries.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">No digest deliveries yet</p>
      ) : (
        <ScrollArea className="max-h-[400px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Delivered</TableHead>
                <TableHead>Resent</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow key={d.id as string}>
                  <TableCell className="font-mono text-xs">{(d.recipient_id as string)?.slice(0, 8)}…</TableCell>
                  <TableCell><Badge variant="outline" className="text-[10px]">{d.delivery_method as string}</Badge></TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[10px] ${statusColor[d.delivery_status as string] ?? ""}`}>
                      {(d.delivery_status as string) ?? "pending"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {d.delivered_at ? format(new Date(d.delivered_at as string), "MMM d h:mm a") : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {d.resent_at ? format(new Date(d.resent_at as string), "MMM d h:mm a") : "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-6"
                      onClick={() => resendMutation.mutate(d.id as string)}
                      disabled={resendMutation.isPending}
                    >
                      <RotateCw className="h-3 w-3 mr-1" />Resend
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}

      {deliveries.length > 0 && (
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>Total: {deliveries.length}</span>
          <span className="text-emerald-400">
            Delivered: {deliveries.filter((d) => d.delivery_status === "delivered").length}
          </span>
          <span className="text-amber-400">
            Pending: {deliveries.filter((d) => !d.delivery_status || d.delivery_status === "pending").length}
          </span>
          <span className="text-destructive">
            Failed: {deliveries.filter((d) => d.delivery_status === "failed").length}
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Automation Settings Panel                                          */
/* ------------------------------------------------------------------ */
export function AutomationSettingsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: settings = [] } = useQuery({
    queryKey: ["deposit-automation-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_automation_settings")
        .select("*")
        .order("setting_key");
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const { error } = await supabase
        .from("deposit_automation_settings")
        .update({ setting_value: value as never, updated_at: new Date().toISOString() })
        .eq("setting_key", key);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Setting updated" });
      qc.invalidateQueries({ queryKey: ["deposit-automation-settings"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const settingLabels: Record<string, string> = {
    owner_overload_threshold: "Owner Overload Threshold",
    approval_required_rebalance: "Require Approval: Rebalance",
    approval_required_bulk_closeout: "Require Approval: Bulk Closeout",
    approval_required_bulk_resolve: "Require Approval: Bulk Resolve",
    daily_automation_enabled: "Daily Automation Enabled",
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Settings className="h-4 w-4" />Automation Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {settings.map((s) => {
          const key = s.setting_key as string;
          const val = s.setting_value;
          const isBool = val === true || val === false || val === "true" || val === "false";
          const boolVal = val === true || val === "true";
          const isNum = !isBool && (typeof val === "number" || !isNaN(Number(val)));

          return (
            <div key={key} className="flex items-center justify-between">
              <div>
                <Label className="text-xs">{settingLabels[key] ?? key}</Label>
                {s.description && <p className="text-[10px] text-muted-foreground">{s.description as string}</p>}
              </div>
              {isBool ? (
                <Switch
                  checked={boolVal}
                  onCheckedChange={(v) => updateMutation.mutate({ key, value: v })}
                />
              ) : isNum ? (
                <Input
                  type="number"
                  className="w-20 h-7 text-xs"
                  defaultValue={Number(val)}
                  onBlur={(e) => {
                    const newVal = Number(e.target.value);
                    if (!isNaN(newVal) && newVal !== Number(val)) {
                      updateMutation.mutate({ key, value: newVal });
                    }
                  }}
                />
              ) : (
                <span className="text-xs text-muted-foreground">{String(val)}</span>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
