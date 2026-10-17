import { useState } from "react";
import { Ban } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/settings/SectionCard";
import { DEPOSITS_SWITCH_HELP, depositsEnabledValue, saveTenantDepositsEnabled } from "@/lib/tenantDeposits";

/**
 * Tenant Management (platform owner only): the per-tenant deposits switch
 * (tenants.deposits_enabled, SQL 98). Saved through tenant-billing-admin and
 * audited. Separate from per-check billing, which only changes the price.
 */
export function TenantDepositsSwitch({
  tenantId,
  tenantName,
  depositsEnabled,
  onSaved,
}: {
  tenantId: string;
  tenantName: string;
  depositsEnabled: boolean | null | undefined;
  onSaved?: (enabled: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(depositsEnabledValue(depositsEnabled));
  const [saving, setSaving] = useState(false);

  const change = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      await saveTenantDepositsEnabled(tenantId, next);
      setEnabled(next);
      onSaved?.(next);
      sonnerToast.success(next ? `Deposits turned on for ${tenantName}.` : `Deposits turned off for ${tenantName}.`);
    } catch (error) {
      sonnerToast.error((error as Error)?.message || "Deposits setting was not saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Deposits"
      icon={<Ban className="h-4 w-4 text-destructive" />}
      accent="bg-gradient-to-r from-rose-500 to-rose-500/30"
      description="Only the ChecksOps platform owner can change this; every change is audited."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="tenant-deposits-enabled">Deposits enabled</Label>
          <p className="text-xs text-muted-foreground">{DEPOSITS_SWITCH_HELP}</p>
        </div>
        <Switch
          id="tenant-deposits-enabled"
          data-testid="tenant-deposits-enabled"
          checked={enabled}
          disabled={saving}
          onCheckedChange={(next) => { void change(next); }}
        />
      </div>
    </SectionCard>
  );
}
