import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Users, Loader2 } from "lucide-react";
import { SectionCard } from "./SectionCard";

interface TeamCapsSettingsProps {
  stakeholderCap: number;
  tenantId: string;
  onUpdate: () => void;
}

export function TeamCapsSettings({
  stakeholderCap: initialCap,
  tenantId,
  onUpdate,
}: TeamCapsSettingsProps) {
  const [stakeholderCap, setStakeholderCap] = useState(initialCap);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("tenants")
        .update({ stakeholder_cap: stakeholderCap } as any)
        .eq("id", tenantId);

      if (error) throw error;

      toast({ title: "Stakeholder limit updated" });
      onUpdate();
    } catch (error: any) {
      toast({
        title: "Failed to update limit",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Additional Stakeholders"
      accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
      icon={<Users className="h-4 w-4 text-amber-500" />}
      description="Total number of additional stakeholders allowed — vendors, sales reps, and subcontractors combined."
    >
      <div className="space-y-4">
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="stakeholder-cap">Total stakeholder limit</Label>
          <Input
            id="stakeholder-cap"
            type="number"
            min={0}
            value={stakeholderCap}
            onChange={(e) => setStakeholderCap(parseInt(e.target.value) || 0)}
          />
          <p className="text-xs text-muted-foreground">
            Counts every vendor, sales rep, and subcontractor together against one shared limit.
          </p>
        </div>
        <div className="flex justify-end pt-2">
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Limit"
            )}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
