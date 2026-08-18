import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { 
  Banknote, CreditCard, ShieldCheck, RefreshCw, ExternalLink, 
  Loader2, Link2, Landmark, X 
} from "lucide-react";
import { usePaymentAccount } from "@/hooks/usePaymentAccount";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { MoovBankLink } from "./MoovBankLink";
import { MicroDepositVerification } from "./MicroDepositVerification";
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
 * Provider-neutral payment account summary and setup.
 *
 * Deliberately never names the underlying rail — the same panel serves every
 * provider, and the action is always "Set Up Payment Account".
 */
export function PaymentAccountPanel() {
  const { account, isLoading, refetch } = usePaymentAccount();
  const { tenantId, enabled } = usePaymentProviderEligibility();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "setup" | "sync" | "bridge" | "bank_link">(null);
  const [showBankLink, setShowBankLink] = useState(false);

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading payment account…</div>;
  }

  const status = (account?.onboardingStatus ?? "not_started") as AccountOnboardingStatus;
  const caps = account?.capabilities ?? null;

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

  async function handleSetup() {
    if (!tenantId) return;
    setBusy("setup");
    try {
      if (!account?.externalAccountId) {
        await invoke("moov-account-create", { tenant_id: tenantId });
      }
      const res = await invoke("moov-onboarding-link", {
        tenant_id: tenantId,
        return_url: `${window.location.origin}/payments?tab=settings`,
      });
      if (res?.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
        toast({
          title: "Payment setup opened",
          description: "Finish setup in the new tab, then return here and refresh your status.",
        });
      }
      await refresh();
    } catch (e: any) {
      toast({ title: "Couldn't start payment setup", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function handleBankLink() {
    // native Moov bank link
    setShowBankLink(true);
  }



  async function refresh() {
    if (!tenantId) return;
    setBusy("sync");
    try {
      await invoke("moov-sync", { tenant_id: tenantId });
      await qc.invalidateQueries({ queryKey: ["payment-account"] });
      await refetch();
    } catch (e: any) {
      toast({ title: "Couldn't refresh status", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
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
              Your organization's payment account and connected bank. Funds stay in your own bank
              account until you send a payment.
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
          <div className="flex flex-col items-end">
            <span className="text-xs">
              {account?.bankName
                ? `${account.bankName}${account.bankLastFour ? ` ••${account.bankLastFour}` : ""}`
                : BANK_STATUS_LABEL[account?.bankConnectionStatus ?? "not_connected"]}
            </span>
            {tenantId && account?.bankConnectionStatus !== "connected" && (
              <MicroDepositVerification 
                tenantId={tenantId}
                verificationStatus={account?.bankConnectionStatus === "pending" ? "pending_micro_deposit" : "not_started"}
                onVerified={() => refresh()}
              />
            )}
          </div>
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

        {showBankLink && tenantId ? (
          <div className="pt-2">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-medium">Connect Bank Account</h4>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setShowBankLink(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <MoovBankLink 
              tenantId={tenantId}
              onConnected={() => {
                setShowBankLink(false);
                refresh();
              }}
              onExit={() => setShowBankLink(false)}
            />
          </div>
        ) : enabled && (
          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <Button
              size="sm"
              className="h-8 text-xs flex-1"
              onClick={handleSetup}
              disabled={busy !== null || status === "active"}
            >
              {busy === "setup"
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Opening…</>
                : <><ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Set Up Payment Account</>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={handleBankLink}
              disabled={busy !== null || !account?.externalAccountId}
            >
              <Landmark className="h-3.5 w-3.5 mr-1.5" />
              Connect Bank
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={refresh}
              disabled={busy !== null}
            >
              {busy === "sync"
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Refreshing…</>
                : <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh status</>}
            </Button>
          </div>
        )}

      </CardContent>
    </Card>
  );
}
