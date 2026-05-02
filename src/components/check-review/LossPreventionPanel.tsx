import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertTriangle,
  ShieldCheck,
  Loader2,
  RefreshCw,
  Clock,
  FileSearch,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

type StuckCheck = {
  id: string;
  claim_id: string;
  status: string;
  amount: number;
  carrier_name: string | null;
  payee_line: string | null;
  created_at: string;
  updated_at: string;
  hours_in_status: number;
  sla_hours: number;
  is_overdue: boolean;
};

type AllCheck = {
  id: string;
  claim_id: string;
  status: string;
  amount: number;
  check_number: string | null;
  carrier_name: string | null;
  payee_line: string | null;
  created_at: string;
  has_loss_draft: boolean;
};

type ReconAlert = {
  id: string;
  alert_type: string;
  severity: string;
  check_intake_item_id: string | null;
  details: Record<string, any>;
  resolved: boolean;
  created_at: string;
};

export function LossPreventionPanel() {
  const [stuck, setStuck] = useState<StuckCheck[]>([]);
  const [all, setAll] = useState<AllCheck[]>([]);
  const [alerts, setAlerts] = useState<ReconAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  async function load() {
    setLoading(true);
    const [{ data: s }, { data: a }, { data: r }] = await Promise.all([
      supabase.rpc("get_stuck_checks" as any),
      supabase.rpc("get_all_checks_safety_net" as any),
      supabase
        .from("check_reconciliation_alerts" as any)
        .select("*")
        .eq("resolved", false)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    setStuck((s as any[]) ?? []);
    setAll((a as any[]) ?? []);
    setAlerts((r as any[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function runReconciliation() {
    setRunning(true);
    const { data, error } = await supabase.functions.invoke(
      "check-reconciliation",
    );
    setRunning(false);
    if (error) {
      toast.error("Reconciliation failed: " + error.message);
      return;
    }
    toast.success(
      `Reconciliation complete — ${data?.alerts_inserted ?? 0} new alerts`,
    );
    load();
  }

  async function resolveAlert(id: string) {
    const { error } = await supabase
      .from("check_reconciliation_alerts" as any)
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq("id", id);
    if (error) toast.error(error.message);
    else load();
  }

  const overdue = stuck.filter((s) => s.is_overdue);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading loss prevention...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold">Loss Prevention Center</h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={runReconciliation}
          disabled={running}
        >
          {running ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3 mr-1" />
          )}
          Run Reconciliation
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatCard
          label="Total Checks"
          value={all.length}
          icon={<FileSearch className="h-4 w-4" />}
        />
        <StatCard
          label="Stuck (Overdue)"
          value={overdue.length}
          icon={<Clock className="h-4 w-4" />}
          tone={overdue.length > 0 ? "warn" : "ok"}
        />
        <StatCard
          label="Open Alerts"
          value={alerts.length}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={alerts.length > 0 ? "warn" : "ok"}
        />
      </div>

      <Tabs defaultValue="stuck">
        <TabsList className="w-full">
          <TabsTrigger value="stuck" className="flex-1 text-xs">
            Stuck Checks ({overdue.length})
          </TabsTrigger>
          <TabsTrigger value="alerts" className="flex-1 text-xs">
            Reconciliation Alerts ({alerts.length})
          </TabsTrigger>
          <TabsTrigger value="all" className="flex-1 text-xs">
            All Checks ({all.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stuck" className="mt-3">
          {overdue.length === 0 ? (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>Nothing stuck</AlertTitle>
              <AlertDescription>Every check is within its SLA.</AlertDescription>
            </Alert>
          ) : (
            <Card>
              <CardContent className="p-0 divide-y">
                {overdue.map((c) => (
                  <CheckRow
                    key={c.id}
                    label={c.payee_line || c.carrier_name || c.id.slice(0, 8)}
                    status={c.status}
                    amount={c.amount}
                    extra={`${Math.round(c.hours_in_status)}h in status (SLA ${c.sla_hours}h)`}
                    tone="warn"
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="alerts" className="mt-3">
          {alerts.length === 0 ? (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>No open alerts</AlertTitle>
              <AlertDescription>
                Run reconciliation to scan for new anomalies.
              </AlertDescription>
            </Alert>
          ) : (
            <Card>
              <CardContent className="p-0 divide-y">
                {alerts.map((a) => (
                  <div
                    key={a.id}
                    className="p-3 flex items-start justify-between gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            a.severity === "critical"
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-xs"
                        >
                          {a.severity}
                        </Badge>
                        <span className="text-sm font-medium">
                          {a.alert_type.replace(/_/g, " ")}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {JSON.stringify(a.details)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(a.created_at), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => resolveAlert(a.id)}
                    >
                      Resolve
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="all" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Safety net — every check, no filters
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 divide-y max-h-[600px] overflow-auto">
              {all.map((c) => (
                <CheckRow
                  key={c.id}
                  label={
                    c.payee_line ||
                    c.carrier_name ||
                    c.check_number ||
                    c.id.slice(0, 8)
                  }
                  status={c.status}
                  amount={c.amount}
                  extra={c.has_loss_draft ? "Loss draft" : ""}
                />
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: "ok" | "warn";
}) {
  return (
    <Card className={tone === "warn" ? "border-destructive/40" : ""}>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div
          className={`text-2xl font-semibold ${tone === "warn" ? "text-destructive" : ""}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function CheckRow({
  label,
  status,
  amount,
  extra,
  tone,
}: {
  label: string;
  status: string;
  amount: number;
  extra?: string;
  tone?: "warn";
}) {
  return (
    <div className="p-3 flex items-center justify-between gap-3 text-sm">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{label}</div>
        {extra && (
          <div
            className={`text-xs ${tone === "warn" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {extra}
          </div>
        )}
      </div>
      <Badge variant="outline" className="text-xs capitalize">
        {status.replace(/_/g, " ")}
      </Badge>
      <div className="font-mono text-xs w-24 text-right">
        ${Number(amount ?? 0).toLocaleString()}
      </div>
    </div>
  );
}
