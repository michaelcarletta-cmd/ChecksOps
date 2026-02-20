import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

interface ClaimStatus {
  id: string;
  name: string;
  color: string;
}

interface ClaimStatusSelectProps {
  claimId: string;
  currentStatus: string;
  onStatusChange?: (newStatus: string) => void;
}

export function ClaimStatusSelect({ claimId, currentStatus, onStatusChange }: ClaimStatusSelectProps) {
  const [statuses, setStatuses] = useState<ClaimStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    fetchStatuses();
  }, []);

  const fetchStatuses = async () => {
    try {
      const { data, error } = await supabase
        .from("claim_statuses")
        .select("*")
        .eq("is_active", true)
        .order("display_order");

      if (error) throw error;
      setStatuses(data || []);
    } catch (error: any) {
      console.error("Error fetching statuses:", error);
    } finally {
      setInitialLoading(false);
    }
  };

  const handleStatusChange = async (newStatus: string) => {
    setLoading(true);
    const oldStatus = currentStatus;
    try {
      const { error } = await supabase
        .from("claims")
        .update({ status: newStatus })
        .eq("id", claimId);

      if (error) throw error;

      // Trigger client notification for status change
      if (oldStatus !== newStatus) {
        supabase.functions.invoke("notify-client-claim-update", {
          body: {
            claimId,
            changeType: "status_change",
            oldValue: oldStatus,
            newValue: newStatus,
          },
        }).catch((err) => {
          console.log("Client notification failed (may be disabled):", err);
        });
      }

      toast({
        title: "Success",
        description: "Claim status updated successfully",
      });

      onStatusChange?.(newStatus);
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

  if (initialLoading) {
    return <Skeleton className="h-10 w-[180px]" />;
  }

  // Find the current status in the list
  const currentStatusObj = statuses.find(s => s.name === currentStatus);

  return (
    <Select value={currentStatus || ""} onValueChange={handleStatusChange} disabled={loading || statuses.length === 0}>
      <SelectTrigger className="min-w-[180px] max-w-[280px] w-auto rounded-none">
        {currentStatusObj ? (
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: currentStatusObj.color }}
            />
            <span className="text-left">{currentStatusObj.name}</span>
          </div>
        ) : (
          <SelectValue placeholder="Select status" />
        )}
      </SelectTrigger>
      <SelectContent>
        {statuses.map((status) => (
          <SelectItem key={status.id} value={status.name}>
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: status.color }}
              />
              {status.name}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
