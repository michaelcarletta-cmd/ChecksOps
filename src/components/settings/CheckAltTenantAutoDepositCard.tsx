import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";

type AutoDepositRow = {
  tenant_id: string;
  auto_approve_enabled: boolean | null;
  auto_approve_max_cents: number | null;
  enabled: boolean | null;
  registered: boolean | null;
  has_registration: boolean | null;
};

/**
 * Tenant-facing Auto-Deposit only. Does not read or write account numbers,
 * ssoKey, Business Unit, or platform CheckAlt settings.
 */
export function CheckAltTenantAutoDepositCard() {
  const { tenant } = useTenant();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [maxDollars, setMaxDollars] = useState("");

  const { data: account, isLoading } = useQuery({
    queryKey: ["checkalt-tenant-auto-deposit", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_tenant_auto_deposit_public" as never)
        .select("tenant_id, auto_approve_enabled, auto_approve_max_cents, enabled, registered, has_registration")
        .eq("tenant_id", tenant!.id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as AutoDepositRow | null;
    },
  });

  useEffect(() => {
    if (!account) return;
    setEnabled(!!account.auto_approve_enabled);
    setMaxDollars(
      account.auto_approve_max_cents != null
        ? (account.auto_approve_max_cents / 100).toFixed(2)
        : "",
    );
  }, [account]);

  const save = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error("No tenant");
      const cents = maxDollars.trim() === "" ? null : Math.round(parseFloat(maxDollars) * 100);
      if (cents != null && (!Number.isFinite(cents) || cents < 0)) {
        throw new Error("Invalid maximum amount");
      }
      const { error } = await supabase
        .from("checkalt_tenant_auto_deposit_public" as never)
        .update({
          auto_approve_enabled: enabled,
          auto_approve_max_cents: cents,
        } as never)
        .eq("tenant_id", tenant.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Auto-Deposit settings saved");
      qc.invalidateQueries({ queryKey: ["checkalt-tenant-auto-deposit", tenant?.id] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to save"),
  });

  if (!tenant?.id) return null;

  const registered = Boolean(account?.registered && account?.has_registration && account?.enabled);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Auto-Deposit
        </CardTitle>
        <CardDescription className="text-xs">
          Automatically approve clean deposits for this organization. Deposits with
          processor flags always stay in manual review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!registered ? (
          <p className="text-xs text-muted-foreground">
            CheckAlt is not fully registered for this organization yet. Auto-Deposit
            can be saved once ChecksOps finishes tenant setup.
          </p>
        ) : null}

        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="space-y-0.5">
            <Label className="text-sm">Enable Auto-Deposit</Label>
            <p className="text-[11px] text-muted-foreground">
              Skips manual approval when the processor returns no warnings.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="auto-deposit-max" className="text-xs">
            Auto-Deposit maximum (optional)
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              id="auto-deposit-max"
              type="number"
              min="0"
              step="0.01"
              placeholder="No limit"
              value={maxDollars}
              onChange={(e) => setMaxDollars(e.target.value)}
              disabled={!enabled || isLoading}
              className="max-w-[180px]"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Deposits above this amount still go to manual review. Leave blank for no ceiling.
          </p>
        </div>

        <Button
          size="sm"
          onClick={() => save.mutate()}
          disabled={save.isPending || isLoading}
        >
          {save.isPending ? "Saving..." : "Save Auto-Deposit"}
        </Button>
      </CardContent>
    </Card>
  );
}
