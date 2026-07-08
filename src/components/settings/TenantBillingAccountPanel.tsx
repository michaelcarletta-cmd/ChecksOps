import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Landmark, ShieldCheck, AlertTriangle } from "lucide-react";
import { useTenantFilter } from "@/hooks/useTenantFilter";

export function TenantBillingAccountPanel() {
  const { tenantId } = useTenantFilter();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    nickname: "Operating account",
    account_holder_name: "",
    routing_number: "",
    account_number: "",
    account_type: "checking",
    entity_type: "business",
    authorize_ach: false,
  });

  const { data: account, isLoading } = useQuery({
    queryKey: ["tenant-billing-account", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_billing_accounts")
        .select("id, nickname, account_holder_name, account_number_last4, routing_number, account_type, entity_type, verification_status, ach_authorized_at, auto_debit_enabled")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form.account_holder_name || !form.routing_number || !form.account_number) {
        throw new Error("Fill account holder, routing number, and account number");
      }
      if (!form.authorize_ach) throw new Error("You must authorize ACH debits to enable auto-billing");
      const { data, error } = await supabase.functions.invoke("save-tenant-billing-account", {
        body: { tenant_id: tenantId, ...form },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast.success("Billing account saved. Awaiting verification.");
      setForm({ ...form, account_number: "", authorize_ach: false });
      qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to save account"),
  });

  const toggleAutoDebit = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase
        .from("tenant_billing_accounts")
        .update({ auto_debit_enabled: enabled })
        .eq("tenant_id", tenantId!);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Auto-debit preference updated");
      qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" />
          Maintenance fee auto-billing
        </CardTitle>
        <CardDescription>
          Authorize ChecksOps to pull your monthly maintenance fee directly from your bank account via ACH (Actum). No card fees.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : account ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
              <div>
                <div className="text-sm font-medium">{account.nickname}</div>
                <div className="text-xs text-muted-foreground">
                  {account.account_holder_name} · {account.account_type} · ****{account.account_number_last4}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge variant={account.verification_status === "verified" || account.verification_status === "admin_override" ? "default" : "outline"} className="text-[10px]">
                  {account.verification_status === "verified" && <ShieldCheck className="h-3 w-3 mr-1" />}
                  {account.verification_status}
                </Badge>
                {account.ach_authorized_at && (
                  <span className="text-[10px] text-muted-foreground">ACH authorized</span>
                )}
              </div>
            </div>

            {account.verification_status === "pending" && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  Account is pending verification by the ChecksOps team. You'll be notified once verified — no charges will run until then.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex items-center gap-2 pt-2 border-t">
              <Checkbox
                id="auto-debit"
                checked={account.auto_debit_enabled}
                onCheckedChange={(c) => toggleAutoDebit.mutate(!!c)}
              />
              <Label htmlFor="auto-debit" className="text-xs cursor-pointer">
                Enable monthly auto-debit
              </Label>
            </div>

            <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] })}>
              Replace account
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-md border">
          <div className="col-span-2 text-xs text-muted-foreground">
            {account ? "Replace your billing account:" : "Add your bank account:"}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Nickname</Label>
            <Input value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Account holder (as printed on check)</Label>
            <Input value={form.account_holder_name} onChange={(e) => setForm({ ...form, account_holder_name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Routing number (9 digits)</Label>
            <Input inputMode="numeric" maxLength={9} value={form.routing_number} onChange={(e) => setForm({ ...form, routing_number: e.target.value.replace(/\D/g, "") })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Account number</Label>
            <Input inputMode="numeric" value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value.replace(/\D/g, "") })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Account type</Label>
            <Select value={form.account_type} onValueChange={(v) => setForm({ ...form, account_type: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="checking">Checking</SelectItem>
                <SelectItem value="savings">Savings</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Entity type</Label>
            <Select value={form.entity_type} onValueChange={(v) => setForm({ ...form, entity_type: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="business">Business</SelectItem>
                <SelectItem value="consumer">Consumer</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 flex items-start gap-2 p-2 bg-muted/40 rounded">
            <Checkbox id="ach-auth" checked={form.authorize_ach} onCheckedChange={(c) => setForm({ ...form, authorize_ach: !!c })} className="mt-0.5" />
            <Label htmlFor="ach-auth" className="text-xs leading-snug cursor-pointer">
              I authorize ChecksOps to initiate monthly ACH debits from the account above for maintenance fees, until I revoke this authorization in writing. Amounts may vary by referral discounts applied.
            </Label>
          </div>
          <div className="col-span-2 flex justify-end">
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              Save billing account
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
