import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Crosshair, Loader2 } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/settings/SectionCard";

export const OPS_BADGE_SWITCH_HELP =
  "When on, this company is ChecksOps verified: its contractor profiles carry the OPS badge and are eligible to appear under Find a Contractor.";

type ContractorProfile = { id: string; display_name: string | null; tier: string | null };

/**
 * Tenant Management > Company (platform owner only): one switch for the OPS
 * badge of every contractor profile in this tenant. On approves the badge
 * (tier "pro"), off revokes it; both go through admin_set_contractor_pro, which
 * the API allows for the platform owner only.
 */
export function TenantOpsBadgeSwitch({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const qc = useQueryClient();
  const queryKey = ["tenant-contractor-profiles", tenantId];

  const { data: profiles = [], isLoading } = useQuery({
    queryKey,
    enabled: !!tenantId,
    queryFn: async (): Promise<ContractorProfile[]> => {
      const { data: members, error: memErr } = await supabase
        .from("tenant_users")
        .select("user_id")
        .eq("tenant_id", tenantId);
      if (memErr) throw memErr;
      const userIds = Array.from(new Set((members ?? []).map((m) => m.user_id).filter(Boolean)));
      if (!userIds.length) return [];
      const { data, error } = await supabase
        .from("contractor_profiles")
        .select("id, display_name, tier")
        .in("user_id", userIds);
      if (error) throw error;
      return (data ?? []) as ContractorProfile[];
    },
  });

  const verified = profiles.length > 0 && profiles.every((p) => p.tier === "pro");

  const setBadge = useMutation({
    mutationFn: async (approve: boolean) => {
      for (const profile of profiles) {
        const { error } = await supabase.rpc("admin_set_contractor_pro", {
          p_contractor_id: profile.id,
          p_approve: approve,
        });
        if (error) throw error;
      }
    },
    onSuccess: (_data, approve) => {
      sonnerToast.success(
        approve ? `${tenantName} is now ChecksOps verified (OPS badge on).` : `OPS badge turned off for ${tenantName}.`,
      );
    },
    onError: (error: unknown) => sonnerToast.error((error as Error)?.message || "OPS badge was not saved"),
    onSettled: () => {
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["contractor-directory"] });
    },
  });

  const noProfiles = !isLoading && profiles.length === 0;

  return (
    <SectionCard
      title="OPS Badge"
      icon={<Crosshair className="h-4 w-4 text-primary" strokeWidth={2.5} />}
      accent="bg-gradient-to-r from-primary to-primary/40"
      description="Saved as soon as you switch it. Only the ChecksOps platform owner can change this."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="tenant-ops-badge">ChecksOps verified</Label>
          <p className="text-xs text-muted-foreground">{OPS_BADGE_SWITCH_HELP}</p>
          {noProfiles && (
            <p className="text-xs text-amber-500">This company has no contractor profile yet, so there is nothing to verify.</p>
          )}
        </div>
        {isLoading || setBadge.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Switch
            id="tenant-ops-badge"
            data-testid="tenant-ops-badge"
            checked={verified}
            disabled={noProfiles}
            onCheckedChange={(next) => setBadge.mutate(next)}
          />
        )}
      </div>
    </SectionCard>
  );
}
