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
  gradient: string | null;
}

interface ClaimStatusSelectProps {
  claimId: string;
  currentStatus: string;
  onStatusChange?: (newStatus: string) => void;
}

function getStatusStyle(status: ClaimStatus): React.CSSProperties {
  if (status.gradient) {
    return { background: status.gradient, color: "#fff" };
  }
  // Build a subtle tinted style from the solid color
  return {
    backgroundColor: `${status.color}18`,
    color: status.color,
    borderColor: `${status.color}30`,
  };
}

function getStatusTriggerStyle(status: ClaimStatus): React.CSSProperties {
  if (status.gradient) {
    return { background: status.gradient, color: "#fff", borderColor: "transparent" };
  }
  return {
    backgroundColor: `${status.color}15`,
    color: status.color,
    borderColor: `${status.color}30`,
  };
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
        .select("id, name, color, gradient")
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
    return <Skeleton className="h-8 w-[160px] rounded-full" />;
  }

  const currentStatusObj = statuses.find(s => s.name === currentStatus);

  return (
    <Select value={currentStatus || ""} onValueChange={handleStatusChange} disabled={loading || statuses.length === 0}>
      <SelectTrigger
        className="min-w-[140px] max-w-[280px] w-auto rounded-full border shadow-sm h-8 text-xs font-semibold px-3 transition-colors [&>svg]:text-current"
        style={currentStatusObj ? getStatusTriggerStyle(currentStatusObj) : undefined}
      >
        {currentStatusObj ? (
          <span className="text-left whitespace-nowrap">{currentStatusObj.name}</span>
        ) : (
          <SelectValue placeholder="Select status" />
        )}
      </SelectTrigger>
      <SelectContent>
        {statuses.map((status) => (
          <SelectItem key={status.id} value={status.name} className="p-0 my-0.5">
            <div
              className="flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap"
              style={getStatusStyle(status)}
            >
              {!status.gradient && (
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: status.color }}
                />
              )}
              {status.name}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
