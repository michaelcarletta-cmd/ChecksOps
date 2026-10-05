import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  PLATFORM_FINANCE_WRITE_BLOCKED_MESSAGE,
  composePlatformBankDisplay,
} from "@/lib/payments/platformFinance";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Landmark,
  Loader2,
  RefreshCw,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Copy,
} from "lucide-react";

/**
 * Platform (master merchant) banking panel.
 *
 * Read-only ChecksOps facilitator bank display. Writes stay fail-closed.
 */

type Capability = { capability: string; status: string };

type PlatformMethod = {
  id: string;
  bank_account_id: string;
  bank_name: string | null;
  last_four: string | null;
  account_type: string | null;
  holder_name: string | null;
  verification_status: string;
  connection_status: string;
  is_default: boolean;
  connected_at: string | null;
  micro_deposit: { status: string; attempts: number } | null;
};

type StatusPayload = {
  success: boolean;
  environment: string;
  platform_account_id: string;
  profile: { displayName: string | null; accountType: string | null; verificationStatus: string | null };
  capabilities: Capability[];
  provider_bank_accounts: Array<{
    bank_account_id: string;
    bank_name: string | null;
    last_four: string | null;
    status: string | null;
  }>;
  methods: PlatformMethod[];
  warnings: string[];
  error?: string;
};

function statusBadge(status: string | null | undefined) {
  const s = (status ?? "unknown").toLowerCase();
  if (s === "verified" || s === "enabled") {
    return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">{s}</Badge>;
  }
  if (s === "pending" || s === "pending_micro_deposit" || s === "review" || s === "inreview") {
    return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">{s.replace(/_/g, " ")}</Badge>;
  }
  if (s === "new" || s === "unverified") {
    return <Badge variant="outline" className="text-muted-foreground">{s}</Badge>;
  }
  return <Badge className="bg-red-500/15 text-red-400 border-red-500/30">{s.replace(/_/g, " ")}</Badge>;
}

export function PlatformBankPanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<StatusPayload | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("moov-platform-bank", {
        body: { action: "status" },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      setState(data as StatusPayload);
    } catch (err: any) {
      toast({
        title: "Couldn't load platform banking",
        description: err?.message ?? "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !state) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const capabilities = state?.capabilities ?? [];
  const methods = composePlatformBankDisplay({
    providerBanks: state?.provider_bank_accounts ?? [],
    localMethods: state?.methods ?? [],
  });

  return (
    <div className="space-y-6">
      {/* Platform account overview */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Landmark className="h-5 w-5 text-primary" />
              Platform Payment Account
            </CardTitle>
            <CardDescription>
              The ChecksOps master account. Tenant Management pulls from and sends to tenant
              accounts through this account's verified settlement bank.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="uppercase">{state?.environment ?? "…"}</Badge>
            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Account</p>
              <p className="font-medium">{state?.profile?.displayName ?? "ChecksOps Platform"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Account ID</p>
              <p className="font-mono text-xs flex items-center gap-1 break-all">
                {state?.platform_account_id ?? "—"}
                {state?.platform_account_id && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      navigator.clipboard.writeText(state.platform_account_id);
                      toast({ title: "Copied" });
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Verification</p>
              <div className="mt-0.5">{statusBadge(state?.profile?.verificationStatus)}</div>
            </div>
          </div>

          {capabilities.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-2">Capabilities</p>
                <div className="flex flex-wrap gap-2">
                  {capabilities.map((c) => (
                    <span key={c.capability} className="inline-flex items-center gap-1.5 text-xs">
                      {c.status === "enabled" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                      )}
                      {c.capability}
                      {statusBadge(c.status)}
                    </span>
                  ))}
                </div>
                {capabilities.some((c) => c.status !== "enabled") && (
                  <p className="text-xs text-amber-400/90 mt-2">
                    Capabilities that are not enabled are still under provider review — money
                    movement unlocks once they flip to enabled.
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Settlement bank accounts */}
      <Card>
        <CardHeader>
          <CardTitle>Settlement Bank Accounts</CardTitle>
          <CardDescription>
            Bank accounts on the ChecksOps facilitator Moov account. This view is read-only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {methods.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No ChecksOps facilitator bank account is visible yet.
            </p>
          )}

          {methods.map((m) => (
              <div key={m.id || m.bank_account_id} className="border rounded-lg p-4 space-y-3 bg-card/50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <Landmark className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">
                        {m.bank_name ?? "Bank account"} ••••{m.last_four ?? "????"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(m.account_type ?? "checking").replace(/^\w/, (c) => c.toUpperCase())}
                        {m.holder_name ? ` · ${m.holder_name}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(m.verification_status)}
                  </div>
                </div>
              </div>
          ))}

          {!!state?.warnings?.length && (
            <p className="text-xs text-muted-foreground">{state.warnings.join(" · ")}</p>
          )}
          <p className="text-[11px] text-muted-foreground flex items-start gap-2">
            <ShieldCheck className="h-3.5 w-3.5 mt-px shrink-0" />
            {PLATFORM_FINANCE_WRITE_BLOCKED_MESSAGE}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
