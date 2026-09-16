import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useFinancialGuard } from "@/hooks/useFinancialGuard";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchCheckAltAutoDepositSettings,
  saveCheckAltAutoDepositSettings,
} from "@/lib/checkaltAutoDeposit";
import { Loader2, ShieldCheck } from "lucide-react";

const dollarsToCents = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) return Number.NaN;
  return Math.round(dollars * 100);
};

export function CheckAltAutoDepositSettings({
  canConfigure: _canConfigure = true,
}: {
  canConfigure?: boolean;
}) {
  const { tenantId } = useTenantFilter();
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const guardFinancial = useFinancialGuard(tenantId);
  const { data: membershipRole, isLoading: roleLoading } = useQuery({
    queryKey: ["checkalt-auto-deposit-role", tenantId, user?.id],
    queryFn: async () => {
      const { data: row, error } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenantId!)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return row?.role ?? null;
    },
    enabled: Boolean(tenantId) && Boolean(user?.id),
  });
  const isTenantOwnerOrAdmin = ["admin", "owner"].includes(
    String(membershipRole || "").toLowerCase(),
  );
  const canEdit = isTenantOwnerOrAdmin;

  const { data, isLoading } = useQuery({
    queryKey: ["checkalt-auto-deposit-settings", tenantId],
    queryFn: async () => {
      const result = await fetchCheckAltAutoDepositSettings(tenantId!);
      if (!result.ok) throw new Error(result.json?.message || result.json?.error || "load_failed");
      return result.json;
    },
    enabled: Boolean(tenantId) && canEdit,
  });

  const [enabled, setEnabled] = useState(false);
  const [maxDollars, setMaxDollars] = useState("");

  useEffect(() => {
    if (!data) return;
    setEnabled(data.auto_deposit_enabled === true);
    setMaxDollars(
      Number.isInteger(data.auto_deposit_max_cents)
        ? String(Number(data.auto_deposit_max_cents) / 100)
        : "",
    );
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const maxCents = dollarsToCents(maxDollars);
      if (enabled && (maxCents == null || !Number.isInteger(maxCents))) {
        throw new Error("Enter a maximum Auto-Deposit amount.");
      }
      if (Number.isNaN(maxCents as number)) {
        throw new Error("Maximum Auto-Deposit amount must be a dollar amount.");
      }
      await guardFinancial("checkalt.auto_deposit.configure", {
        autoDepositEnabled: enabled,
        autoDepositMaxCents: enabled ? maxCents : maxCents,
      });
      const result = await saveCheckAltAutoDepositSettings({
        tenantId: tenantId!,
        enabled,
        maxCents: enabled ? maxCents : maxCents,
      });
      if (!result.ok) throw new Error(result.json?.message || result.json?.error || "save_failed");
      if (result.json?.swept === true) {
        throw new Error("Auto-Deposit save refused: settings changes must not sweep Ready checks.");
      }
      return result.json;
    },
    onSuccess: () => {
      toast({ title: "Auto-Deposit settings saved" });
      qc.invalidateQueries({ queryKey: ["checkalt-auto-deposit-settings", tenantId] });
    },
    onError: (error: unknown) => {
      toast({
        title: "Auto-Deposit settings not saved",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  if (roleLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            CheckAlt Auto-Deposit
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading Auto-Deposit settings
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!canEdit) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            CheckAlt Auto-Deposit
          </CardTitle>
          <CardDescription>
            Only a tenant owner or admin can view and change Auto-Deposit. Staff and operators
            cannot edit these settings.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          CheckAlt Auto-Deposit
        </CardTitle>
        <CardDescription>
          Tenant owner/admin only. Default is OFF. Changing these settings requires financial TOTP
          and does not submit checks already sitting in Ready for Deposit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading Auto-Deposit settings
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="auto-deposit-enabled">Auto-Deposit Eligible Checks</Label>
              <Switch
                id="auto-deposit-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="auto-deposit-max">Maximum Auto-Deposit Amount</Label>
              <Input
                id="auto-deposit-max"
                inputMode="decimal"
                placeholder="0.00"
                value={maxDollars}
                onChange={(event) => setMaxDollars(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Stored as integer cents. Checks over this amount stay Ready for manual Deposit.
              </p>
            </div>
            <Button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || !tenantId}
            >
              {save.isPending ? "Saving…" : "Save Auto-Deposit settings"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
