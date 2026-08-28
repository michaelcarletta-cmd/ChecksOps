import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link2, Loader2, RefreshCw, Search } from "lucide-react";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { usePermissions } from "@/hooks/usePermissions";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { usePaymentAccount } from "@/hooks/usePaymentAccount";

interface DiscoveredAccount {
  account_id: string;
  display_name: string | null;
  email: string | null;
  account_type: string | null;
  verification_status: string | null;
  terms_accepted_on: string | null;
  disabled: boolean;
  linked_tenant_id: string | null;
  capabilities: { capability: string; status: string }[];
  banks: { bank_name: string | null; last_four: string | null; status: string | null }[];
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
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
  return data as T;
}

/**
 * Admin recovery tool: when onboarding was completed on a payment account that
 * this organization is not pointed at, ChecksOps keeps showing steps that are
 * already done. This lists the live accounts at the provider and re-points the
 * organization at the correct one, then re-syncs everything.
 */
export function MoovAccountLinkPanel() {
  const { tenantId, enabled } = usePaymentProviderEligibility();
  const { account } = usePaymentAccount();
  const { isAdmin } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [accounts, setAccounts] = useState<DiscoveredAccount[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!enabled || !isAdmin) return null;

  async function discover() {
    if (!tenantId) return;
    setBusy("discover");
    try {
      const res = await invoke<{ accounts: DiscoveredAccount[] }>("moov-account-discover", {
        tenant_id: tenantId,
      });
      setAccounts(res.accounts ?? []);
    } catch (e: any) {
      toast({ title: "Couldn't load provider accounts", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function linkAndSync(accountId: string) {
    if (!tenantId) return;
    setBusy(accountId);
    try {
      await invoke("moov-account-discover", { tenant_id: tenantId, link_account_id: accountId });
      await invoke("moov-sync", { tenant_id: tenantId });
      await invoke("moov-readiness", { tenant_id: tenantId });
      await qc.invalidateQueries({ queryKey: ["payment-account"] });
      await qc.invalidateQueries({ queryKey: ["payment-readiness"] });
      toast({
        title: "Account linked",
        description: "ChecksOps now mirrors this payment account's live status.",
      });
      await discover();
    } catch (e: any) {
      toast({ title: "Couldn't link account", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" />
          Match ChecksOps to your provider account
        </CardTitle>
        <CardDescription className="text-xs">
          If you finished onboarding directly with the payment provider and ChecksOps still shows
          open steps, it may be pointed at a different account. Load the live accounts and link the
          right one — ChecksOps will then mirror the provider exactly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground break-all">
            Currently linked: <code>{account?.externalAccountId ?? "none"}</code>
          </span>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={discover} disabled={!!busy}>
            {busy === "discover"
              ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Loading…</>
              : <><Search className="h-3.5 w-3.5 mr-1.5" /> Load provider accounts</>}
          </Button>
        </div>

        {accounts?.length === 0 && (
          <p className="text-xs text-muted-foreground">No accounts returned by the provider.</p>
        )}

        {(accounts ?? []).map((a) => {
          const isCurrent = a.account_id === account?.externalAccountId;
          const verifiedBank = a.banks.some((b) => String(b.status).toLowerCase() === "verified");
          return (
            <div key={a.account_id} className="rounded-md border border-border p-2.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-medium">{a.display_name ?? "Unnamed account"}</span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {isCurrent && <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">Linked here</Badge>}
                  {a.verification_status && (
                    <Badge variant="outline" className="text-[10px]">{a.verification_status}</Badge>
                  )}
                  {a.terms_accepted_on && (
                    <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-500">Terms accepted</Badge>
                  )}
                  {verifiedBank && (
                    <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-500">Bank verified</Badge>
                  )}
                </div>
              </div>
              <code className="text-[10px] font-mono text-muted-foreground break-all">{a.account_id}</code>
              <p className="text-[11px] text-muted-foreground">
                {a.capabilities.length
                  ? a.capabilities.map((c) => `${c.capability}: ${c.status}`).join(" · ")
                  : "No capabilities reported"}
              </p>
              {a.banks.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {a.banks.map((b) => `${b.bank_name ?? "Bank"} ••${b.last_four ?? "????"} (${b.status})`).join(" · ")}
                </p>
              )}
              {!isCurrent && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={!!busy || (!!a.linked_tenant_id && a.linked_tenant_id !== tenantId)}
                  onClick={() => linkAndSync(a.account_id)}
                >
                  {busy === a.account_id
                    ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Linking…</>
                    : a.linked_tenant_id && a.linked_tenant_id !== tenantId
                    ? "Linked to another organization"
                    : <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Link & sync this account</>}
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
