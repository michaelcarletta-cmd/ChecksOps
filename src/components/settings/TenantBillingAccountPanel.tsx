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
import { invokeTenantBillingAuthorize } from "@/lib/billing/tenantBilling";

/**
 * Monthly ChecksOps subscription funding source.
 * A connected bank alone is not enough — ACH authorization is required.
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
      const { data, error } = await supabase
        .from("tenant_billing_accounts")
        .select("id, provider_payment_method_id, ach_authorized_at, auto_debit_enabled, verification_status, account_number_last4, nickname")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: accounts = [], isLoading: loadingAccounts } = useQuery({
    queryKey: ["tenant-connected-billing-methods", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_methods")
        .select("id, provider_payment_method_id, holder_name, last_four, nickname, connection_status, can_send, verification_status")
        .eq("tenant_id", tenantId!)
        .eq("connection_status", "connected")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).filter((row: any) => row.provider_payment_method_id);
    },
  });

  useEffect(() => {
    if (billing?.provider_payment_method_id) setSelectedId(billing.provider_payment_method_id);
  }, [billing?.provider_payment_method_id]);

  const linkedAccount = accounts.find((a: any) => a.provider_payment_method_id === billing?.provider_payment_method_id);

  const linkAccount = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("Select a connected bank account");
      if (!authorized) throw new Error("You must authorize ACH debits");
      const result = await invokeTenantBillingAuthorize({
        tenant_id: tenantId,
        provider_payment_method_id: selectedId,
        authorized: true,
        auto_debit_enabled: true,
      });
      if (!result.ok) throw new Error(result.error);
    },
    onSuccess: () => {
      toast.success("Monthly subscription billing account authorized");
      setAuthorized(false);
      qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to authorize billing account"),
  });

  const toggleAutoDebit = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!enabled) {
        const result = await invokeTenantBillingAuthorize({
          tenant_id: tenantId,
          action: "pause",
          auto_debit_enabled: false,
        });
        if (!result.ok) throw new Error(result.error);
        return;
      }
      if (!selectedId) throw new Error("Select a connected bank account first");
      const result = await invokeTenantBillingAuthorize({
        tenant_id: tenantId,
        provider_payment_method_id: selectedId,
        authorized: true,
        auto_debit_enabled: true,
      });
      if (!result.ok) throw new Error(result.error);
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
          Monthly subscription auto-billing
        </CardTitle>
        <CardDescription>
          Choose which connected Moov bank account ChecksOps may debit for the monthly platform subscription only. This is not used for insurance check processing or disbursement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : accounts.length === 0 ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              You don't have a connected Moov bank account yet. Add one in the <strong>Bank Account</strong> section, then return here to authorize monthly subscription billing.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {linkedAccount && (
              <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
                <div>
                  <div className="text-sm font-medium">{linkedAccount.nickname || linkedAccount.holder_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {linkedAccount.holder_name} · ••••{linkedAccount.last_four || "????"}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="default" className="text-[10px]">
                    <ShieldCheck className="h-3 w-3 mr-1" />
                    Connected via Moov
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
                  Enable monthly subscription auto-debit
                </Label>
              </div>
            )}

            <div className="space-y-3 p-3 border rounded-md">
              <div className="text-xs font-medium">
                {linkedAccount ? "Change billing account" : "Authorize a billing account"}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Choose a connected bank account</Label>
                <Select value={selectedId} onValueChange={setSelectedId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a: any) => (
                      <SelectItem key={a.provider_payment_method_id} value={a.provider_payment_method_id}>
                        {a.nickname || a.holder_name} · ••••{a.last_four || "????"}
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
                  I authorize ChecksOps to initiate monthly ACH debits from the selected account for the ChecksOps platform subscription, until I revoke this authorization. A connected bank alone is not sufficient.
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
                  {linkedAccount ? "Replace" : "Authorize account"}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
