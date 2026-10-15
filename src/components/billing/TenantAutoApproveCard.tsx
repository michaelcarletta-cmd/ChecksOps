import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { useIdentityTenantAccess } from "@/hooks/useCanMoveChecks";
import { isPlatformOwner } from "@/lib/masterMerchant";
import { canSaveCheckAltAutoDeposit } from "@/lib/checkAltOperatorAccess";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  autoDepositSaveMismatch,
  parseAutoDepositCeilingCents,
  resolveAutoDepositUiState,
  type AutoDepositPublicRow,
} from "@/lib/autoDepositUiState";

/**
 * Per-tenant auto-approve controls for CheckAlt deposits.
 * Overrides the global checkalt_config defaults for this tenant only.
 * Reads tenant_id, auto_approve_enabled, auto_approve_max_cents, and derived registered.
 * Writes only auto_approve_enabled and auto_approve_max_cents.
 * Viewers and non-members see the settings read-only, without Save
 * (the server refuses their save; this is UX only).
 */
export function TenantAutoApproveCard({ tenantId: tenantIdProp }: { tenantId?: string | null } = {}) {
  const { tenant } = useTenant();
  const tenantId = tenantIdProp ?? tenant?.id ?? null;
  const qc = useQueryClient();
  const { user } = useAuth();
  const access = useIdentityTenantAccess(tenantId);
  const canEdit = canSaveCheckAltAutoDeposit({
    isTenantMember: access.isTenantMember,
    tenantRole: access.tenantRole,
    isPlatformOwner: isPlatformOwner(user?.email, user?.id),
  });
  const [enabled, setEnabled] = useState(false);
  const [maxDollars, setMaxDollars] = useState<string>("");

  const queryKey = ["checkalt-tenant-auto-deposit", tenantId];
  const readAccount = async (): Promise<AutoDepositPublicRow> => {
    const { data, error } = await supabase
      .from("checkalt_tenant_auto_deposit_public" as any)
      .select("tenant_id, auto_approve_enabled, auto_approve_max_cents, registered")
      .eq("tenant_id", tenantId!)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as AutoDepositPublicRow;
  };

  const { data: account, isLoading, isError } = useQuery({
    queryKey,
    queryFn: readAccount,
    enabled: !!tenantId,
  });

  const showStored = (row: AutoDepositPublicRow | undefined) => {
    if (!row) return;
    setEnabled(!!row.auto_approve_enabled);
    setMaxDollars(
      row.auto_approve_max_cents != null
        ? (row.auto_approve_max_cents / 100).toFixed(2)
        : "",
    );
  };

  useEffect(() => {
    showStored(account);
  }, [account]);

  const save = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No tenant");
      const cents = parseAutoDepositCeilingCents(maxDollars);
      if (cents === undefined) {
        throw new Error("Enter the ceiling as a dollar amount, like 2000.00, or leave it blank.");
      }
      const { data, error } = await supabase
        .from("checkalt_tenant_accounts")
        .update({
          auto_approve_enabled: enabled,
          auto_approve_max_cents: cents,
        })
        .eq("tenant_id", tenantId)
        .select("tenant_id, auto_approve_enabled, auto_approve_max_cents");
      if (error) throw error;
      const saved = Array.isArray(data) ? data[0] : data;
      if (!saved) {
        throw new Error("Auto-Deposit settings were not saved. No settings were changed.");
      }
      const wanted = { enabled, maxCents: cents };
      const savedMismatch = autoDepositSaveMismatch(wanted, saved as AutoDepositPublicRow);
      if (savedMismatch) {
        showStored(saved as AutoDepositPublicRow);
        throw new Error(savedMismatch);
      }
      // Re-read what is on file and show that, not what was typed.
      let stored: AutoDepositPublicRow;
      try {
        stored = await qc.fetchQuery({ queryKey, queryFn: readAccount, staleTime: 0 });
      } catch {
        // The save itself returned the stored row; only the refresh failed.
        showStored(saved as AutoDepositPublicRow);
        qc.invalidateQueries({ queryKey });
        return { refreshed: false };
      }
      showStored(stored);
      const mismatch = autoDepositSaveMismatch(wanted, stored);
      if (mismatch) throw new Error(mismatch);
      return { refreshed: true };
    },
    onSuccess: (result) => {
      if (result.refreshed) toast.success("Auto-approve settings saved");
      else toast.success("Auto-approve settings saved; couldn't refresh the page. Reload to confirm.");
    },
    onError: (e: unknown) => {
      toast.error((e as { message?: string } | null)?.message || "Failed to save");
      qc.invalidateQueries({ queryKey });
    },
  });

  if (!tenantId) return null;

  const uiState = resolveAutoDepositUiState(account, { isLoading, isError });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Auto-Deposit
        </CardTitle>
        <CardDescription className="text-xs">
          Automatically approve clean deposits at or under your ceiling. Deposits with any
          flags (duplicate, risk, image quality, mismatch, etc.) always route to manual review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {uiState === "loading" ? (
          <p className="text-xs text-muted-foreground">
            Loading Auto-Deposit settings…
          </p>
        ) : uiState === "error" ? (
          <p className="text-xs text-muted-foreground">
            Couldn't load Auto-Deposit settings. Try again or contact ChecksOps if this continues.
          </p>
        ) : uiState === "no_account" ? (
          <p className="text-xs text-muted-foreground">
            No CheckAlt deposit account is on file for your organization. Ask ChecksOps to register it in Tenant Management first.
          </p>
        ) : uiState === "unregistered" ? (
          <p className="text-xs text-muted-foreground">
            Your CheckAlt deposit account is on file, but registration isn't complete. Ask ChecksOps to finish registration in Tenant Management.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm">Auto-approve clean deposits</Label>
                <p className="text-[11px] text-muted-foreground">
                  Skips manual approval when the processor returns no warnings.
                </p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={isLoading || !canEdit}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auto-approve-max" className="text-xs">
                Auto-approve ceiling (required for automatic approval)
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  id="auto-approve-max"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 2000.00"
                  value={maxDollars}
                  onChange={(e) => setMaxDollars(e.target.value)}
                  disabled={!enabled || isLoading || !canEdit}
                  className="max-w-[180px]"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Deposits above this amount still go to manual review. A blank ceiling turns
                automatic approval off; every deposit then waits for manual approval.
              </p>
            </div>

            {canEdit ? (
              <Button
                size="sm"
                onClick={() => save.mutate()}
                disabled={save.isPending || isLoading}
              >
                {save.isPending ? "Saving..." : "Save settings"}
              </Button>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Only owners, admins, managers and operators of this organization can change Auto-Deposit settings.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
