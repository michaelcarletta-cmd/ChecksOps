import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RefreshCw, Link2, Copy, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

interface Props {
  tenantId: string;
  tenantName: string;
  isOpen: boolean;
  onClose: () => void;
}

const STATUS_TONE: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  verified: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  onboarding_incomplete: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  verification_pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  not_started: "bg-muted text-muted-foreground border-border",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right min-w-0 truncate">{children}</span>
    </div>
  );
}

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      {label}
    </span>
  );
}

export function TenantPaymentAccountPanel({ tenantId, tenantName, isOpen, onClose }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [link, setLink] = useState<string | null>(null);
  const [setupWindow, setSetupWindow] = useState<Window | null>(null);

  useEffect(() => {
    if (!setupWindow) return;
    const interval = setInterval(() => {
      if (setupWindow.closed) {
        setSetupWindow(null);
        refresh();
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [setupWindow]);

  const { data, isLoading } = useQuery({
    queryKey: ["tenant-payment-account", tenantId],
    enabled: isOpen && !!tenantId,
    queryFn: async () => {
      const [tenantRes, acctRes] = await Promise.all([
        supabase
          .from("tenants")
          .select(
            "id, name, payment_provider, moov_account_id, moov_allowlisted, payment_status, bank_connection_status, bank_name, bank_last_four, last_sync",
          )
          .eq("id", tenantId)
          .maybeSingle(),
        supabase
          .from("payment_provider_accounts")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("provider", "moov")
          .maybeSingle(),
      ]);
      if (tenantRes.error) throw tenantRes.error;
      return { tenant: (tenantRes.data ?? {}) as any, account: (acctRes.data ?? null) as any };
    },
  });

  const invoke = async (fn: string, body: Record<string, unknown>) => {
    const { data: res, error } = await supabase.functions.invoke(fn, { body });
    if (error) {
      let msg = error.message ?? `${fn} failed`;
      try {
        const parsed = await (error as any).context?.json?.();
        if (parsed?.error) msg = parsed.error;
      } catch {
        /* keep original */
      }
      throw new Error(msg);
    }
    if ((res as any)?.error) throw new Error((res as any).error);
    return res as any;
  };

  const refresh = () => qc.invalidateQueries({ queryKey: ["tenant-payment-account", tenantId] });

  const toggleAllowlist = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase.from("tenants").update({ moov_allowlisted: next } as any).eq("id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Updated" });
      refresh();
    },
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });

  const createAccount = useMutation({
    mutationFn: () => invoke("moov-account-create", { tenant_id: tenantId }),
    onSuccess: (r: any) => {
      toast({
        title: r?.already_existed ? "Account already exists" : "Payment account created",
        description: "The organization still has to finish onboarding themselves.",
      });
      refresh();
    },
    onError: (e: any) => toast({ title: "Couldn't create account", description: e.message, variant: "destructive" }),
  });

  const genLink = useMutation({
    mutationFn: () => invoke("moov-onboarding-link", { 
      tenant_id: tenantId,
      return_url: window.location.origin + "/payments?tab=settings"
    }),
    onSuccess: (r: any) => {
      const url = r?.url ?? r?.link ?? null;
      setLink(url);
      if (url) {
        // Open in new tab automatically for a smoother "hosted" experience
        const win = window.open(url, '_blank', 'noopener,noreferrer');
        setSetupWindow(win);
        toast({ 
          title: "Onboarding started", 
          description: "This view will refresh automatically once you close the onboarding tab." 
        });
      }
      refresh();
    },
    onError: (e: any) => toast({ title: "Couldn't generate link", description: e.message, variant: "destructive" }),
  });

  const sync = useMutation({
    mutationFn: () => invoke("moov-sync", { tenant_id: tenantId }),
    onSuccess: () => {
      toast({ title: "Synced with provider" });
      refresh();
    },
    onError: (e: any) => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  const tenant = data?.tenant ?? {};
  const acct = data?.account ?? null;
  const onboarding = acct?.onboarding_status ?? "not_started";
  const requirements: string[] = Array.isArray(acct?.requirements) ? acct.requirements : [];

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Payment Account — {tenantName}</DialogTitle>
          <DialogDescription>
            Oversight only. The organization completes onboarding and connects its own bank from their Payment settings.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label className="text-sm">Payments enabled for this organization</Label>
                <p className="text-xs text-muted-foreground">Allowlists them for the new payment rail.</p>
              </div>
              <Switch
                checked={!!tenant.moov_allowlisted}
                onCheckedChange={(v) => toggleAllowlist.mutate(v)}
                disabled={toggleAllowlist.isPending}
              />
            </div>

            <div className="rounded-md border p-3 divide-y divide-border/60">
              <Row label="Provider account">
                {acct?.provider_account_id ? (
                  <span className="font-mono text-xs">{acct.provider_account_id.slice(0, 8)}…</span>
                ) : (
                  <span className="text-muted-foreground text-xs">Not created</span>
                )}
              </Row>
              <Row label="Onboarding">
                <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[onboarding] ?? ""}`}>
                  {String(onboarding).replace(/_/g, " ")}
                </Badge>
              </Row>
              <Row label="Verification">
                <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[acct?.verification_status] ?? ""}`}>
                  {String(acct?.verification_status ?? "not started").replace(/_/g, " ")}
                </Badge>
              </Row>
              <Row label="Bank connected">
                {tenant.bank_last_four ? (
                  <span className="text-xs">
                    {tenant.bank_name ?? "Bank"} ••••{tenant.bank_last_four}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">Not connected</span>
                )}
              </Row>
              <Row label="Last sync">
                <span className="text-xs text-muted-foreground">
                  {acct?.last_synced_at || tenant.last_sync
                    ? new Date(acct?.last_synced_at ?? tenant.last_sync).toLocaleString()
                    : "Never"}
                </span>
              </Row>
            </div>

            <div className="rounded-md border p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Capabilities</p>
              <div className="grid grid-cols-2 gap-1.5">
                <Flag ok={!!acct?.can_receive_payments} label="Receive payments" />
                <Flag ok={!!acct?.can_send_payments} label="Send payments" />
                <Flag ok={!!acct?.can_ach_debit} label="ACH debit" />
                <Flag ok={!!acct?.can_ach_credit} label="ACH credit" />
              </div>
              {(acct?.restricted || acct?.disabled) && (
                <p className="flex items-center gap-1.5 text-xs text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Account is {acct?.disabled ? "disabled" : "restricted"} by the provider.
                </p>
              )}
              {requirements.length > 0 && (
                <div className="text-xs text-amber-400">
                  <p className="font-medium">Information still required:</p>
                  <ul className="list-disc pl-4">
                    {requirements.map((r) => (
                      <li key={String(r)}>{String(r).replace(/[._]/g, " ")}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {!acct?.provider_account_id && (
                <Button size="sm" onClick={() => createAccount.mutate()} disabled={createAccount.isPending}>
                  {createAccount.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                  Create payment account
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => genLink.mutate()}
                disabled={genLink.isPending || !acct?.provider_account_id}
              >
                {genLink.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Link2 className="h-3.5 w-3.5 mr-1" />
                )}
                Onboarding link
              </Button>
              <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
                {sync.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                )}
                Sync
              </Button>
            </div>

            {link && (
              <div className="flex items-center gap-2 rounded-md border p-2">
                <span className="text-xs font-mono truncate flex-1">{link}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => {
                    navigator.clipboard?.writeText(link);
                    toast({ title: "Copied" });
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
