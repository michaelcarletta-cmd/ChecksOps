import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Landmark, ShieldCheck, AlertTriangle } from "lucide-react";

type TenantAccountRow = {
  tenant_id: string;
  sso_user_id: string | null;
  deposit_account_number: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  business_unit: string | null;
  enabled: boolean | null;
  registered_at: string | null;
  has_sso_key: boolean | null;
  auto_approve_enabled: boolean | null;
  auto_approve_max_cents: number | null;
};

/**
 * ChecksOps Tenant Management editor for one tenant's CheckAlt identity.
 * Saves to checkalt_tenant_accounts only. Does not call CheckAlt register/poll.
 */
export function CheckAltTenantAdminCard({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["checkalt-tenant-accounts-admin", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_tenant_accounts_admin" as never)
        .select(
          "tenant_id, sso_user_id, deposit_account_number, first_name, last_name, email, business_unit, enabled, registered_at, has_sso_key, auto_approve_enabled, auto_approve_max_cents",
        )
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as TenantAccountRow | null;
    },
  });

  const [form, setForm] = useState({
    sso_user_id: "",
    first_name: "",
    last_name: "",
    email: "",
    deposit_account_number: "",
    business_unit: "",
    enabled: true,
    auto_approve_enabled: false,
    auto_approve_max_dollars: "",
  });

  useEffect(() => {
    if (!data) return;
    setForm({
      sso_user_id: data.sso_user_id ?? "",
      first_name: data.first_name ?? "",
      last_name: data.last_name ?? "",
      email: data.email ?? "",
      deposit_account_number: data.deposit_account_number ?? "",
      business_unit: data.business_unit ?? "",
      enabled: data.enabled !== false,
      auto_approve_enabled: !!data.auto_approve_enabled,
      auto_approve_max_dollars:
        data.auto_approve_max_cents != null ? String(data.auto_approve_max_cents / 100) : "",
    });
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const maxDollars = form.auto_approve_max_dollars.trim();
      const maxCents = maxDollars ? Math.round(parseFloat(maxDollars) * 100) : null;
      const { error } = await supabase
        .from("checkalt_tenant_accounts_admin" as never)
        .upsert({
          tenant_id: tenantId,
          sso_user_id: form.sso_user_id.trim(),
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          email: form.email.trim(),
          deposit_account_number: form.deposit_account_number.trim(),
          business_unit: form.business_unit.trim() || null,
          enabled: form.enabled,
          auto_approve_enabled: form.auto_approve_enabled,
          auto_approve_max_cents: Number.isFinite(maxCents as number) ? maxCents : null,
        } as never, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Tenant CheckAlt settings saved" });
      qc.invalidateQueries({ queryKey: ["checkalt-tenant-accounts-admin", tenantId] });
    },
    onError: (e: unknown) => {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Landmark className="h-4 w-4 text-primary" />
              Tenant CheckAlt configuration
            </CardTitle>
            <CardDescription>
              Values stored for this tenant only. Saving does not register an account
              with CheckAlt or change the platform singleton.
            </CardDescription>
          </div>
          {data?.registered_at ? (
            <Badge variant="default" className="shrink-0">
              <ShieldCheck className="h-3 w-3 mr-1" /> Registered
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0">
              <AlertTriangle className="h-3 w-3 mr-1" /> Not registered
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tenant_bu">Business Unit</Label>
            <Input
              id="tenant_bu"
              value={form.business_unit}
              onChange={(e) => setForm({ ...form, business_unit: e.target.value })}
              placeholder="Unique to this tenant"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tenant_sso">User ID (sso_user_id)</Label>
            <Input
              id="tenant_sso"
              value={form.sso_user_id}
              onChange={(e) => setForm({ ...form, sso_user_id: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              FinCapture userId. {data?.has_sso_key ? "A registration ssoKey is already stored." : "No ssoKey stored yet."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tenant_first">First name</Label>
            <Input
              id="tenant_first"
              value={form.first_name}
              onChange={(e) => setForm({ ...form, first_name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tenant_last">Last name</Label>
            <Input
              id="tenant_last"
              value={form.last_name}
              onChange={(e) => setForm({ ...form, last_name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tenant_email">Email</Label>
            <Input
              id="tenant_email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tenant_deposit">Deposit account number</Label>
            <Input
              id="tenant_deposit"
              value={form.deposit_account_number}
              onChange={(e) => setForm({ ...form, deposit_account_number: e.target.value })}
            />
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-3">
          <Switch
            id="tenant_enabled"
            checked={form.enabled}
            onCheckedChange={(v) => setForm({ ...form, enabled: v })}
          />
          <div className="space-y-1">
            <Label htmlFor="tenant_enabled" className="cursor-pointer">Enable this tenant</Label>
            <p className="text-xs text-muted-foreground">
              Deposits also require the platform kill switch and a stored registration timestamp.
            </p>
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
          <div className="flex items-start gap-3">
            <Switch
              id="tenant_auto"
              checked={form.auto_approve_enabled}
              onCheckedChange={(v) => setForm({ ...form, auto_approve_enabled: v })}
            />
            <div className="space-y-1">
              <Label htmlFor="tenant_auto" className="cursor-pointer">Auto-Deposit override</Label>
              <p className="text-xs text-muted-foreground">
                Optional ChecksOps override of the tenant Manager Auto-Deposit setting.
              </p>
            </div>
          </div>
          {form.auto_approve_enabled && (
            <div className="space-y-1.5 pl-11">
              <Label htmlFor="tenant_auto_max">Auto-Deposit ceiling (USD, optional)</Label>
              <Input
                id="tenant_auto_max"
                type="number"
                min="0"
                step="0.01"
                value={form.auto_approve_max_dollars}
                onChange={(e) => setForm({ ...form, auto_approve_max_dollars: e.target.value })}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending
              || !form.sso_user_id
              || !form.first_name
              || !form.last_name
              || !form.email
              || !form.deposit_account_number
            }
          >
            {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save tenant CheckAlt
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
