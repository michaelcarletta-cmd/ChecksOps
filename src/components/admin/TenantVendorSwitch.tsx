import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Store } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/settings/SectionCard";
import { VENDOR_SWITCH_HELP, fetchTenantVendorStatus, saveTenantVendor } from "@/lib/tenantVendor";

/**
 * Tenant Management > Company (platform owner only): the per-tenant Vendor switch. Read with
 * tenant-billing-admin "vendor-status" and saved with "vendor-set" (platform owner only, audited).
 * The Vendor Portal (/vendor-ops) is a separate thing and is not changed by this switch.
 */
export function TenantVendorSwitch({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const qc = useQueryClient();
  const queryKey = ["tenant-vendor-status", tenantId];

  const { data: isVendor = false, isLoading, isError } = useQuery({
    queryKey,
    enabled: !!tenantId,
    queryFn: () => fetchTenantVendorStatus(tenantId),
  });

  const save = useMutation({
    mutationFn: (next: boolean) => saveTenantVendor(tenantId, next),
    onSuccess: (saved) => {
      qc.setQueryData(queryKey, saved);
      sonnerToast.success(saved ? `${tenantName} is now a vendor.` : `${tenantName} is no longer a vendor.`);
    },
    onError: (error: unknown) => sonnerToast.error((error as Error)?.message || "Vendor setting was not saved"),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });

  return (
    <SectionCard
      title="Vendor"
      icon={<Store className="h-4 w-4 text-primary" />}
      accent="bg-gradient-to-r from-primary to-primary/40"
      description="Saved as soon as you switch it. Only the ChecksOps platform owner can change this; every change is audited."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="tenant-vendor">Vendor</Label>
          <p className="text-xs text-muted-foreground">{VENDOR_SWITCH_HELP}</p>
          {isError && <p className="text-xs text-amber-500">The vendor setting could not be read.</p>}
        </div>
        {isLoading || save.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Switch
            id="tenant-vendor"
            data-testid="tenant-vendor"
            checked={isVendor}
            disabled={isError}
            onCheckedChange={(next) => save.mutate(next)}
          />
        )}
      </div>
    </SectionCard>
  );
}
