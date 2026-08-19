import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Users, Loader2 } from "lucide-react";
import { SectionCard } from "./SectionCard";

interface TeamCapsSettingsProps {
  vendorCap: number;
  salesRepCap: number;
  subcontractorCap: number;
  tenantId: string;
  onUpdate: () => void;
}

export function TeamCapsSettings({ 
  vendorCap: initialVendorCap, 
  salesRepCap: initialSalesRepCap, 
  subcontractorCap: initialSubcontractorCap,
  tenantId,
  onUpdate
}: TeamCapsSettingsProps) {
  const [vendorCap, setVendorCap] = useState(initialVendorCap);
  const [salesRepCap, setSalesRepCap] = useState(initialSalesRepCap);
  const [subcontractorCap, setSubcontractorCap] = useState(initialSubcontractorCap);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("tenants")
        .update({
          vendor_cap: vendorCap,
          sales_rep_cap: salesRepCap,
          subcontractor_cap: subcontractorCap,
        })
        .eq("id", tenantId);

      if (error) throw error;
      
      toast({ title: "Team caps updated successfully" });
      onUpdate();
    } catch (error: any) {
      toast({ 
        title: "Failed to update caps", 
        description: error.message, 
        variant: "destructive" 
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Team Role Limits"
      accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
      icon={<Users className="h-4 w-4 text-amber-500" />}
      description="Set the maximum number of team members allowed for specific roles."
    >
      <div className="space-y-4 pt-2">

      <CardContent className="space-y-4 p-4 pt-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="vendor-cap">Vendor Cap</Label>
            <Input
              id="vendor-cap"
              type="number"
              min={0}
              value={vendorCap}
              onChange={(e) => setVendorCap(parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sales-rep-cap">Sales Rep Cap</Label>
            <Input
              id="sales-rep-cap"
              type="number"
              min={0}
              value={salesRepCap}
              onChange={(e) => setSalesRepCap(parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="subcontractor-cap">Sub Contractor Cap</Label>
            <Input
              id="subcontractor-cap"
              type="number"
              min={0}
              value={subcontractorCap}
              onChange={(e) => setSubcontractorCap(parseInt(e.target.value) || 0)}
            />
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <Button 
            onClick={handleSave} 
            disabled={saving}
            size="sm"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Caps"
            )}
          </Button>
        </div>
      </div>
    </SectionCard>

  );
}
