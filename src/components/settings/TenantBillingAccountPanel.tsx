import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Landmark, ShieldCheck, AlertTriangle, Info } from "lucide-react";
import { useTenantFilter } from "@/hooks/useTenantFilter";

/**
 * Maintenance-fee billing: pick which of your already-verified bank accounts
 * (added via Moov in the Bank Account panel) should be
 * debited monthly. No manual routing/account entry — ever.
 * Save records ACH consent only and never starts a collection.
 */
export function TenantBillingAccountPanel() {
  const { tenantId } = useTenantFilter();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>("");
  const [authorized, setAuthorized] = useState(false);

  const { data: billing, isLoading: loadingBilling } = useQuery({
    queryKey: ["tenant-billing-account", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("save-tenant-billing-account", {
        body: { tenant_id: tenantId, action: "get" },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      if ((data as any)?.authorization) return (data as any).authorization;
      const fallback = await supabase
        .from("tenant_billing_accounts")
        .select("id, stakeholder_account_id, ach_authorized_at, auto_debit_enabled, verification_status")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (fallback.error) throw fallback.error;
      return fallback.data;
    },
  });

  const { data: accounts = [], isLoading: loadingAccounts } = useQuery({
    queryKey: ["tenant-verified-bank-accounts", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, chk_acct, acct_type, custname, verification_status, verified_at")
        .eq("tenant_id", tenantId!)
        .eq("is_active", true)
        .eq("verification_status", "verified")
        .order("verified_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (billing?.stakeholder_account_id) setSelectedId(billing.stakeholder_account_id);
  }, [billing?.stakeholder_account_id]);

  const linkedAccount = accounts.find((a: any) => a.id === billing?.stakeholder_account_id);

  const linkAccount = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("Select a verified bank account");
      if (!authorized) throw new Error("You must authorize ACH debits");
      const { data, error } = await supabase.functions.invoke("save-tenant-billing-account", {
        body: {
          tenant_id: tenantId,
          action: "save",
          stakeholder_account_id: selectedId,
          authorized: true,
          auto_debit_enabled: true,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).message || (data as any).error);
      if ((data as any)?.charged === true || (data as any)?.collection_initiated === true) {
        throw new Error("Billing save unexpectedly started a collection");
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Billing account linked — auto-debit is on");
      setAuthorized(false);
      qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to link account"),
  });

  const toggleAutoDebit = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data, error } = await supabase.functions.invoke("save-tenant-billing-account", {
        body: {
          tenant_id: tenantId,
          action: "toggle_auto_debit",
          auto_debit_enabled: enabled,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).message || (data as any).error);
      return data;
    },
    onSuccess: () => {
      toast.success("Auto-debit preference updated");
      qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to update auto-debit"),
  });

  const isLoading = loadingBilling || loadingAccounts;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" />
          Monthly fee auto-billing
        </CardTitle>
        <CardDescription>
          Choose which of your verified bank accounts ChecksOps should debit each month for <strong>maintenance fees, check processing fees, and payment processing fees</strong>. All bank accounts are added through the secure bank login in the Bank Account section — no manual entry. Saving authorization does not charge your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : accounts.length === 0 ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              You don't have any verified bank accounts yet. Add one in the <strong>Bank Account</strong> section using bank sign-in (Moov), then return here to enable auto-billing.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {linkedAccount && (
              <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
                <div>
                  <div className="text-sm font-medium">{linkedAccount.nickname}</div>
                  <div className="text-xs text-muted-foreground">
                    {linkedAccount.custname} · {linkedAccount.acct_type === "C" ? "Checking" : "Savings"} · {linkedAccount.chk_acct ? `••••${linkedAccount.chk_acct.slice(-4)}` : "Account pending"}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="default" className="text-[10px]">
                    <ShieldCheck className="h-3 w-3 mr-1" />
                    Verified via Moov
                  </Badge>
                  {billing?.ach_authorized_at && (
                    <span className="text-[10px] text-muted-foreground">
                      ACH authorized {new Date(billing.ach_authorized_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            )}

            {linkedAccount && (
              <div className="flex items-center gap-2 pt-2 border-t">
                <Checkbox
                  id="auto-debit"
                  checked={!!billing?.auto_debit_enabled}
                  onCheckedChange={(c) => toggleAutoDebit.mutate(!!c)}
                />
                <Label htmlFor="auto-debit" className="text-xs cursor-pointer">
                  Enable monthly auto-debit (maintenance + check processing + payment processing)
                </Label>
              </div>
            )}

            <div className="space-y-3 p-3 border rounded-md">
              <div className="text-xs font-medium">
                {linkedAccount ? "Change billing account" : "Link a billing account"}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Choose a verified bank account</Label>
                <Select value={selectedId} onValueChange={setSelectedId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a: any) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.nickname} · {a.chk_acct ? `••••${a.chk_acct.slice(-4)}` : "Account pending"} · {a.custname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-start gap-2 p-2 bg-muted/40 rounded">
                <Checkbox
                  id="ach-auth"
                  checked={authorized}
                  onCheckedChange={(c) => setAuthorized(!!c)}
                  className="mt-0.5"
                />
                <Label htmlFor="ach-auth" className="text-xs leading-snug cursor-pointer">
                  I authorize ChecksOps to initiate monthly ACH debits from the selected account for <strong>maintenance fees, check processing fees, and payment processing fees</strong>, until I revoke this authorization in writing. Amounts may vary based on monthly usage and any referral discounts applied.
                </Label>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Info className="h-3 w-3" />
                  Add more accounts in the Bank Account panel above.
                </div>
                <Button
                  size="sm"
                  onClick={() => linkAccount.mutate()}
                  disabled={linkAccount.isPending || !selectedId || !authorized}
                >
                  {linkedAccount ? "Replace" : "Link account"}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
