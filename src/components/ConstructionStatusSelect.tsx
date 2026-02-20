import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CONSTRUCTION_STATUSES = [
  { value: "pending", label: "Pending", color: "#94a3b8" },
  { value: "scheduled", label: "Scheduled", color: "#3b82f6" },
  { value: "in_progress", label: "In Progress", color: "#f59e0b" },
  { value: "on_hold", label: "On Hold", color: "#ef4444" },
  { value: "completed", label: "Completed", color: "#22c55e" },
  { value: "invoiced", label: "Invoiced", color: "#8b5cf6" },
];

interface ConstructionStatusSelectProps {
  claimId: string;
  currentStatus: string | null;
  onStatusChange?: (newStatus: string) => void;
  disabled?: boolean;
}

export function ConstructionStatusSelect({ 
  claimId, 
  currentStatus, 
  onStatusChange,
  disabled = false 
}: ConstructionStatusSelectProps) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleStatusChange = async (newStatus: string) => {
    setLoading(true);
    try {
      const { error } = await supabase
        .from("claims")
        .update({ construction_status: newStatus })
        .eq("id", claimId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Construction status updated",
      });

      onStatusChange?.(newStatus);

      // Automatically sync to any linked partner workspaces
      // First check if this claim has any linked_claims (meaning it came FROM a partner)
      const { data: linkedClaim } = await supabase
        .from("linked_claims")
        .select("external_instance_url, external_claim_id")
        .eq("claim_id", claimId)
        .maybeSingle();

      if (linkedClaim) {
        // This claim was synced FROM a partner - need to sync status back
        // Find the linked_workspace that matches the source
        const { data: linkedWorkspace } = await supabase
          .from("linked_workspaces")
          .select("id")
          .eq("external_instance_url", linkedClaim.external_instance_url)
          .maybeSingle();

        if (linkedWorkspace) {
          console.log("Syncing construction status back to partner...");
          const { error: syncError } = await supabase.functions.invoke("sync-claim-to-partner", {
            body: {
              claim_id: claimId,
              linked_workspace_id: linkedWorkspace.id,
            },
          });
          if (syncError) {
            console.error("Failed to sync status to partner:", syncError);
          } else {
            console.log("Status synced to partner successfully");
          }
        }
      }

      // Also check if this claim has partner assignments (meaning we pushed TO a partner)
      const { data: partnerAssignments } = await supabase
        .from("claim_partner_assignments")
        .select("linked_workspace_id")
        .eq("claim_id", claimId);

      if (partnerAssignments && partnerAssignments.length > 0) {
        for (const assignment of partnerAssignments) {
          console.log("Syncing construction status to partner workspace...");
          const { error: syncError } = await supabase.functions.invoke("sync-claim-to-partner", {
            body: {
              claim_id: claimId,
              linked_workspace_id: assignment.linked_workspace_id,
            },
          });
          if (syncError) {
            console.error("Failed to sync status to partner:", syncError);
          }
        }
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const currentStatusObj = CONSTRUCTION_STATUSES.find(s => s.value === (currentStatus || "pending"));

  return (
    <Select 
      value={currentStatus || "pending"} 
      onValueChange={handleStatusChange} 
      disabled={loading || disabled}
    >
      <SelectTrigger className="min-w-[160px] max-w-[220px] w-auto rounded-none">
        {currentStatusObj ? (
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: currentStatusObj.color }}
            />
            <span className="text-left">{currentStatusObj.label}</span>
          </div>
        ) : (
          <SelectValue placeholder="Select status" />
        )}
      </SelectTrigger>
      <SelectContent>
        {CONSTRUCTION_STATUSES.map((status) => (
          <SelectItem key={status.value} value={status.value}>
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: status.color }}
              />
              {status.label}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}