import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Banknote, CreditCard, ShieldCheck, RefreshCw, Loader2 } from "lucide-react";
import { usePaymentAccount } from "@/hooks/usePaymentAccount";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { displayCase } from "@/lib/displayCase";
import { safeErrorMessage } from "@/lib/payments/moovOnboarding";

import {
  BANK_STATUS_LABEL,
  ONBOARDING_STATUS_LABEL,
  type AccountOnboardingStatus,
} from "@/lib/payments/types";

const STATUS_CLASS: Record<AccountOnboardingStatus, string> = {
  not_started: "border-muted-foreground/30 text-muted-foreground",
  onboarding_incomplete: "border-amber-500/40 text-amber-500",
  verification_pending: "border-amber-500/40 text-amber-500",
  additional_information_required: "border-amber-500/40 text-amber-500",
  active: "border-emerald-500/40 text-emerald-500",
  restricted: "border-destructive/40 text-destructive",
  suspended: "border-destructive/40 text-destructive",
};

/**
 * Read-only payment account summary (status, capabilities, connected bank).
 *
 * Onboarding, bank linking and micro-deposit verification live in exactly one
 * place now: Settings -> Compliance & Docs (ComplianceSettings). This panel
 * only reports state and can ask the server to re-sync it.
 */
export function PaymentAccountPanel() {
  const { account, isLoading, refetch } = usePaymentAccount();
  const { tenantId } = usePaymentProviderEligibility();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading payment account…</div>;
  }

  const status = (account?.onboardingStatus ?? "not_started") as AccountOnboardingStatus;
  const caps = account?.capabilities ?? null;

  async function refresh() {
    if (!tenantId) return;
    setSyncing(true);
    try {
      const { error } = await supabase.functions.invoke("moov-sync", { body: { tenant_id: tenantId } });
      if (error) throw new Error(error.message);
      await qc.invalidateQueries({ queryKey: ["payment-account"] });
      await refetch();
    } catch (e) {
      toast({ title: "Couldn't refresh status", description: safeErrorMessage(e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              Connected Payment Account
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Your organization's payment account and connected bank. Complete onboarding and bank
              setup in Settings → Compliance &amp; Docs.
            </CardDescription>
          </div>
          <Badge variant="outline" className={`text-[10px] shrink-0 ${STATUS_CLASS[status]}`}>
            {ONBOARDING_STATUS_LABEL[status]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> Can send payments
          </span>
          <span className="text-xs">{caps?.canSendPayments ? "Yes" : "Not yet"}</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> Can receive payments
          </span>
          <span className="text-xs">{caps?.canReceivePayments ? "Yes" : "Not yet"}</span>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Banknote className="h-3.5 w-3.5" /> Connected Bank
          </span>
          <span className="text-xs">
            {account?.bankName
              ? `${displayCase(account.bankName)}${account.bankLastFour ? ` ••${account.bankLastFour}` : ""}`
              : BANK_STATUS_LABEL[account?.bankConnectionStatus ?? "not_connected"]}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Last Sync
          </span>
          <span className="text-xs">
            {account?.lastSync ? new Date(account.lastSync).toLocaleString() : "—"}
          </span>
        </div>

        {caps?.informationRequired?.length ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
            <p className="text-xs font-medium text-amber-500">Additional information required</p>
            <ul className="mt-1 space-y-0.5">
              {caps.informationRequired.slice(0, 6).map((r) => (
                <li key={r} className="text-[11px] text-muted-foreground">• {r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={refresh} disabled={syncing || !tenantId}>
          {syncing
            ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Refreshing…</>
            : <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh status</>}
        </Button>
      </CardContent>
    </Card>
  );
}
