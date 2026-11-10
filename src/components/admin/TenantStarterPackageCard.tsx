import { useEffect, useState } from "react";
import { Package } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/settings/SectionCard";
import {
  STARTER_PACKAGE_DEFAULT_CHECKS,
  defaultMaintenanceEndsOn,
  saveStarterPackage,
  starterPackageSummary,
  useStarterPackage,
} from "@/lib/starterPackage";

/**
 * Tenant Management (platform owner only): the optional Starter Package (SQL 151). A toggle with the
 * start date, the last day of included maintenance and the included checks. Saved through
 * tenant-billing-admin and audited.
 */
export function TenantStarterPackageCard({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const qc = useQueryClient();
  const { data: pkg, isLoading } = useStarterPackage(tenantId);
  const [enabled, setEnabled] = useState(false);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [included, setIncluded] = useState(String(STARTER_PACKAGE_DEFAULT_CHECKS));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!pkg) return;
    setEnabled(pkg.enabled);
    setStartsOn(pkg.starts_on ?? "");
    setEndsOn(pkg.maintenance_ends_on ?? "");
    setIncluded(String(pkg.included_checks));
  }, [pkg]);

  const save = async () => {
    if (saving) return;
    if (enabled && !startsOn) {
      sonnerToast.error("Choose the date the Starter Package starts.");
      return;
    }
    setSaving(true);
    try {
      await saveStarterPackage(tenantId, {
        enabled,
        starts_on: startsOn || null,
        maintenance_ends_on: endsOn || defaultMaintenanceEndsOn(startsOn),
        included_checks: included === "" ? null : Number(included),
      });
      await qc.invalidateQueries({ queryKey: ["tenant-starter-package", tenantId] });
      sonnerToast.success(enabled ? `Starter Package saved for ${tenantName}.` : `Starter Package turned off for ${tenantName}.`);
    } catch (error) {
      sonnerToast.error((error as Error)?.message || "Starter Package was not saved");
    } finally {
      setSaving(false);
    }
  };

  const summary = starterPackageSummary(pkg);
  return (
    <SectionCard
      title="Starter Package"
      icon={<Package className="h-4 w-4 text-primary" />}
      accent="bg-gradient-to-r from-primary to-primary/30"
      description="Optional: $3,500 covers setup, 12 months of maintenance and 250 checks. Unused checks roll over; a failed deposit uses one; other fees still apply. Only the ChecksOps platform owner can change this; every change is audited."
    >
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : pkg === null ? (
        <p className="text-xs text-muted-foreground">Available once the Starter Package database update (SQL 151) is applied.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="tenant-starter-package">On the Starter Package</Label>
              {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
            </div>
            <Switch id="tenant-starter-package" checked={enabled} disabled={saving} onCheckedChange={setEnabled} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="starter-starts-on" className="text-xs">Starts</Label>
              <Input
                id="starter-starts-on"
                type="date"
                value={startsOn}
                disabled={saving}
                onChange={(e) => {
                  setStartsOn(e.target.value);
                  if (!endsOn) setEndsOn(defaultMaintenanceEndsOn(e.target.value) ?? "");
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="starter-ends-on" className="text-xs">Maintenance included through</Label>
              <Input id="starter-ends-on" type="date" value={endsOn} disabled={saving} onChange={(e) => setEndsOn(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="starter-included" className="text-xs">Included checks</Label>
              <Input
                id="starter-included"
                type="number"
                min={0}
                step={1}
                value={included}
                disabled={saving}
                onChange={(e) => setIncluded(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={() => { void save(); }} disabled={saving}>
              {saving ? "Saving…" : "Save Starter Package"}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
