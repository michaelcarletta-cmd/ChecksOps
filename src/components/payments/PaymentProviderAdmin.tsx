import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShieldAlert, PlugZap, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { ONBOARDING_STATUS_LABEL, type AccountOnboardingStatus } from "@/lib/payments/types";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { toast } from "@/hooks/use-toast";

type SelfTestStep = { step: string; ok: boolean; status?: number; detail?: unknown };

/**
 * Internal-only rollout view: which organizations are enabled for the platform
 * payment rail, where each one is in onboarding, and their capability state.
 * Read-only — no money movement happens from here.
 */
export function PaymentProviderAdmin() {
  const { tenantId } = useTenantFilter();
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<SelfTestStep[] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["payment-provider-admin"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_accounts")
        .select(
          "id, tenant_id, provider, environment, onboarding_status, can_send_payments, can_receive_payments, restricted, disabled, last_synced_at, tenants(name)",
        )
        .order("last_synced_at", { ascending: false, nullsFirst: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  const runSelfTest = async () => {
    if (!tenantId) return;
    setRunning(true);
    setSteps(null);
    try {
      const { data, error } = await supabase.functions.invoke("moov-selftest", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      const result = data as { steps?: SelfTestStep[]; failure_count?: number; error?: string };
      if (result?.error) throw new Error(result.error);
      setSteps(result?.steps ?? []);
      toast({
        title: result?.failure_count ? "Some endpoints failed" : "All endpoints reachable",
        description: result?.failure_count
          ? `${result.failure_count} check(s) failed — see details below.`
          : "Every provider endpoint responded successfully.",
        variant: result?.failure_count ? "destructive" : "default",
      });
    } catch (e) {
      toast({
        title: "Connection test failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <PlugZap className="h-4 w-4 text-primary" />
            Endpoint Connection Test (internal)
          </CardTitle>
          <CardDescription className="text-xs">
            Calls every provider endpoint we depend on — auth, account, capabilities, bank accounts,
            payment methods, transfers and the browser bank-link session. Read-only; no money moves.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={runSelfTest} disabled={running || !tenantId}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            {running ? "Testing…" : "Run connection test"}
          </Button>

          {steps && (
            <div className="space-y-1.5">
              {steps.map((s) => (
                <div
                  key={s.step}
                  className="flex items-start gap-2 rounded-md border border-border/60 px-2.5 py-2"
                >
                  {s.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs font-medium">
                      {s.step}
                      {s.status ? ` · ${s.status}` : ""}
                    </p>
                    <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-all">
                      {typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)?.slice(0, 400)}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Rollout Status (internal)
          </CardTitle>
          <CardDescription className="text-xs">
            Organizations enabled for the platform payment rail and their current onboarding state.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-xs text-muted-foreground py-4">Loading…</p>
          ) : !data?.length ? (
            <p className="text-xs text-muted-foreground py-4">No organizations enabled yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Organization</TableHead>
                    <TableHead className="text-xs">Env</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Send</TableHead>
                    <TableHead className="text-xs">Receive</TableHead>
                    <TableHead className="text-xs">Last sync</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((row: any) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs">{row.tenants?.name ?? row.tenant_id}</TableCell>
                      <TableCell className="text-xs capitalize">{row.environment}</TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="text-[10px]">
                          {ONBOARDING_STATUS_LABEL[
                            (row.onboarding_status ?? "not_started") as AccountOnboardingStatus
                          ] ?? row.onboarding_status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{row.can_send_payments ? "Yes" : "No"}</TableCell>
                      <TableCell className="text-xs">{row.can_receive_payments ? "Yes" : "No"}</TableCell>
                      <TableCell className="text-xs">
                        {row.last_synced_at ? new Date(row.last_synced_at).toLocaleString() : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
