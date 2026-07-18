import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";

/**
 * Per-tenant auto-approve controls for CheckAlt deposits.
 * Overrides the global checkalt_config defaults for this tenant only.
 */
export function TenantAutoApproveCard() {
  const { tenant } = useTenant();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [maxDollars, setMaxDollars] = useState<string>("");

  const { data: account, isLoading } = useQuery({
    queryKey: ["checkalt-tenant-account", tenant?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_tenant_accounts")
        .select("tenant_id, auto_approve_enabled, auto_approve_max_cents, sso_user_id")
        .eq("tenant_id", tenant!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!tenant?.id,
  });

  useEffect(() => {
    if (account) {
      setEnabled(!!account.auto_approve_enabled);
      setMaxDollars(
        account.auto_approve_max_cents != null
          ? (account.auto_approve_max_cents / 100).toFixed(2)
          : "",
      );
    }
  }, [account]);

  const save = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error("No tenant");
      const cents = maxDollars.trim() === "" ? null : Math.round(parseFloat(maxDollars) * 100);
      if (cents != null && (!Number.isFinite(cents) || cents < 0)) {
        throw new Error("Invalid maximum amount");
      }
      const { error } = await supabase
        .from("checkalt_tenant_accounts")
        .update({
          auto_approve_enabled: enabled,
          auto_approve_max_cents: cents,
        })
        .eq("tenant_id", tenant.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Auto-approve settings saved");
      qc.invalidateQueries({ queryKey: ["checkalt-tenant-account", tenant?.id] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });

  if (!tenant?.id) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          CheckAlt Auto-Approve
        </CardTitle>
        <CardDescription className="text-xs">
          Automatically approve clean CheckAlt deposits for your organization. Deposits with any
          flags (duplicate, risk, image quality, mismatch, etc.) always route to manual review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!account?.sso_user_id ? (
          <p className="text-xs text-muted-foreground">
            Your CheckAlt account isn't registered yet. Register in Integration Settings first.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm">Auto-approve clean deposits</Label>
                <p className="text-[11px] text-muted-foreground">
                  Skips manual approval when CheckAlt returns no warnings.
                </p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={isLoading}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auto-approve-max" className="text-xs">
                Auto-approve ceiling (optional)
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  id="auto-approve-max"
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
              {save.isPending ? "Saving..." : "Save settings"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
