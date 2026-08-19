import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle2, Mail, TrendingDown, RefreshCw } from "lucide-react";

type LogRow = {
  status: string;
  created_at: string;
  recipient_email: string;
  template_name: string;
  error_message: string | null;
};

type SuppressionRow = {
  email: string;
  reason: string;
  created_at: string;
  metadata: any;
};

const WINDOW_DAYS = 30;

export function TenantEmailHealthPanel() {
  const { tenantId } = useTenantFilter();
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [suppressions, setSuppressions] = useState<SuppressionRow[]>([]);

  const load = async () => {
    if (!tenantId) return;
    setLoading(true);
    const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();

    const [{ data: logRows }, { data: supRows }] = await Promise.all([
      supabase
        .from("email_send_log")
        .select("status, created_at, recipient_email, template_name, error_message")
        .eq("tenant_id", tenantId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000),
      supabase
        .from("suppressed_emails")
        .select("email, reason, created_at, metadata")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    setLogs((logRows as LogRow[]) || []);
    setSuppressions((supRows as SuppressionRow[]) || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenantId]);

  const stats = useMemo(() => {
    const s = { sent: 0, bounced: 0, complained: 0, failed: 0, suppressed: 0 };
    for (const r of logs) {
      if (r.status in s) (s as any)[r.status]++;
    }
    const totalAttempts = s.sent + s.bounced + s.complained + s.failed;
    const bounceRate = totalAttempts > 0 ? (s.bounced / totalAttempts) * 100 : 0;
    const complaintRate = totalAttempts > 0 ? (s.complained / totalAttempts) * 100 : 0;
    return { ...s, bounceRate, complaintRate };
  }, [logs]);

  const health: "healthy" | "warning" | "critical" =
    stats.complaintRate > 0.1 || stats.bounceRate > 5 ? "critical"
    : stats.bounceRate > 2 ? "warning"
    : "healthy";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email Deliverability
          </CardTitle>
          <CardDescription>Last {WINDOW_DAYS} days of send activity for this tenant</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {health === "healthy" && <Badge className="bg-green-500/10 text-green-500 border-green-500/30"><CheckCircle2 className="h-3 w-3 mr-1" />Healthy</Badge>}
              {health === "warning" && <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30"><AlertCircle className="h-3 w-3 mr-1" />Bounce rate elevated</Badge>}
              {health === "critical" && <Badge variant="destructive"><TrendingDown className="h-3 w-3 mr-1" />Deliverability at risk</Badge>}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Stat label="Sent" value={stats.sent} tone="default" />
              <Stat label="Bounced" value={stats.bounced} tone={stats.bounceRate > 2 ? "warn" : "default"} suffix={stats.bounceRate ? `${stats.bounceRate.toFixed(1)}%` : undefined} />
              <Stat label="Complaints" value={stats.complained} tone={stats.complained > 0 ? "warn" : "default"} suffix={stats.complaintRate ? `${stats.complaintRate.toFixed(2)}%` : undefined} />
              <Stat label="Failed" value={stats.failed} tone="default" />
              <Stat label="Suppressed" value={stats.suppressed} tone="default" />
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">Recent suppressions ({suppressions.length})</h4>
              {suppressions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No suppressed addresses for this tenant.</p>
              ) : (
                <div className="rounded-md border divide-y max-h-96 overflow-y-auto">
                  {suppressions.map((s, i) => (
                    <div key={i} className="p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-mono truncate">{s.email}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(s.created_at).toLocaleString()}
                          {s.metadata?.event_type && ` · ${s.metadata.event_type}`}
                        </div>
                      </div>
                      <Badge variant={s.reason === "complaint" ? "destructive" : "secondary"} className="capitalize shrink-0">
                        {s.reason}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone, suffix }: { label: string; value: number; tone: "default" | "warn"; suffix?: string }) {
  return (
    <div className={`rounded-md border p-3 ${tone === "warn" ? "border-yellow-500/40 bg-yellow-500/5" : ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value.toLocaleString()}</div>
      {suffix && <div className="text-xs text-muted-foreground">{suffix}</div>}
    </div>
  );
}
