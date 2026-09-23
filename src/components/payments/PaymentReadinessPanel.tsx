import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, ShieldCheck, CircleAlert, Clock, CircleDashed, FlaskConical } from "lucide-react";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/aws/client";

type ReadinessState = "ready" | "pending" | "action_required" | "not_started";

interface ReadinessCheck {
  id: string;
  label: string;
  state: ReadinessState;
  detail?: string | null;
  requirements?: string[];
}

interface Readiness {
  environment: string;
  isSandbox: boolean;
  canMoveMoney: boolean;
  overall: ReadinessState;
  checks: ReadinessCheck[];
  requirements: string[];
}

const STATE_LABEL: Record<ReadinessState, string> = {
  ready: "Ready",
  pending: "Pending",
  action_required: "Action required",
  not_started: "Not started",
};

const STATE_CLASS: Record<ReadinessState, string> = {
  ready: "border-emerald-500/40 text-emerald-500",
  pending: "border-amber-500/40 text-amber-500",
  action_required: "border-destructive/40 text-destructive",
  not_started: "border-muted-foreground/30 text-muted-foreground",
};

function StateIcon({ state }: { state: ReadinessState }) {
  if (state === "ready") return <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />;
  if (state === "pending") return <Clock className="h-3.5 w-3.5 text-amber-500" />;
  if (state === "action_required") return <CircleAlert className="h-3.5 w-3.5 text-destructive" />;
  return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />;
}

async function invoke(fn: string, body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message ?? "Request failed";
    try {
      const parsed = await (error as any).context?.json?.();
      if (parsed?.error) message = parsed.error;
    } catch { /* keep original */ }
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as any;
}

/**
 * Money-movement readiness, evaluated server-side against the live provider
 * state: terms of service, business verification, ACH send capability, wallet
 * balance, settlement bank verification and fee plan.
 */
export function PaymentReadinessPanel() {
  const { tenantId, enabled } = usePaymentProviderEligibility();
  const { toast } = useToast();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [tosBusy, setTosBusy] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !enabled) return;
    setLoading(true);
    try {
      const res = await invoke("moov-readiness", { tenant_id: tenantId });
      setReadiness(res?.readiness ?? null);
    } catch (e: any) {
      toast({ title: "Couldn't check payment readiness", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [tenantId, enabled, toast]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Records the account holder's acceptance of the provider's platform terms.
   * The acceptance itself is applied server side, where the provider requires
   * the token to be minted with our credentials.
   */
  async function handleAcceptTerms() {
    if (!tenantId) return;
    setTosBusy(true);
    try {
      await invoke("moov-tos-accept", { tenant_id: tenantId, accepted: true });
      toast({ title: "Terms accepted", description: "Your acceptance was recorded. Syncing account status…" });
      await invoke("moov-sync", { tenant_id: tenantId }).catch(() => null);
      await load();
    } catch (e: any) {
      toast({ title: "Couldn't record terms acceptance", description: e.message, variant: "destructive" });
    } finally {
      setTosBusy(false);
    }
  }





  if (!enabled) return null;

  const tosCheck = readiness?.checks.find((c) => c.id === "terms_of_service");

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Payment Readiness
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Everything that must be complete before your organization can move money.
            </CardDescription>
          </div>
          <div className="flex flex-col items-end gap-1">
            {readiness && (
              <Badge variant="outline" className={`text-[10px] ${STATE_CLASS[readiness.overall]}`}>
                {STATE_LABEL[readiness.overall]}
              </Badge>
            )}
            {readiness?.isSandbox && (
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-500 gap-1">
                <FlaskConical className="h-3 w-3" /> Test mode — no real money
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {readiness?.isSandbox && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
            <p className="text-xs text-amber-500 font-medium">Sandbox environment</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Payments made here are simulated. No funds leave or enter any real bank account.
            </p>
          </div>
        )}

        {loading && !readiness ? (
          <div className="text-xs text-muted-foreground">Checking readiness…</div>
        ) : (
          <div className="space-y-2">
            {(readiness?.checks ?? []).map((check) => (
              <div key={check.id} className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 min-w-0">
                  <span className="mt-0.5"><StateIcon state={check.state} /></span>
                  <div className="min-w-0">
                    <p className="text-xs">{check.label}</p>
                    {check.detail && (
                      <p className="text-[11px] text-muted-foreground">{check.detail}</p>
                    )}
                    {check.requirements?.length ? (
                      <ul className="mt-0.5">
                        {check.requirements.slice(0, 5).map((r) => (
                          <li key={r} className="text-[11px] text-muted-foreground">• {r}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
                <Badge variant="outline" className={`text-[10px] shrink-0 ${STATE_CLASS[check.state]}`}>
                  {STATE_LABEL[check.state]}
                </Badge>
              </div>
            ))}
          </div>
        )}

        {tosCheck && tosCheck.state !== "ready" && (
          <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1">
            <p className="text-xs font-medium">Platform terms of service</p>
            <p className="text-[11px] text-muted-foreground">
              By accepting, the account holder agrees to our payment provider's{" "}
              <a
                href="https://moov.io/legal/platform-agreement/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                platform agreement
              </a>{" "}
              and{" "}
              <a
                href="https://moov.io/legal/privacy-policy/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                privacy policy
              </a>
              . Acceptance is recorded with the provider.
            </p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          {tosCheck && tosCheck.state !== "ready" && (
            <Button size="sm" className="h-8 text-xs flex-1" onClick={handleAcceptTerms} disabled={tosBusy}>
              {tosBusy
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Recording acceptance…</>
                : "Accept terms"}
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={load} disabled={loading}>
            {loading
              ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Checking…</>
              : <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Re-check readiness</>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

