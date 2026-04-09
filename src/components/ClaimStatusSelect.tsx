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
import { Badge } from "@/components/ui/badge";
import { ChevronRight } from "lucide-react";

interface ClaimStatus {
  id: string;
  name: string;
  color: string;
  gradient: string | null;
}

interface SubStatus {
  id: string;
  parent_status_id: string;
  name: string;
  display_order: number;
}

interface ClaimStatusSelectProps {
  claimId: string;
  currentStatus: string;
  currentSubStatusId?: string | null;
  onStatusChange?: (newStatus: string) => void;
  onSubStatusChange?: (subStatusId: string | null) => void;
  compact?: boolean;
}

function getStatusStyle(status: ClaimStatus): React.CSSProperties {
  if (status.gradient) {
    return { background: status.gradient, color: "#fff" };
  }
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

export function ClaimStatusSelect({ claimId, currentStatus, currentSubStatusId, onStatusChange, onSubStatusChange }: ClaimStatusSelectProps) {
  const [statuses, setStatuses] = useState<ClaimStatus[]>([]);
  const [subStatuses, setSubStatuses] = useState<SubStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    fetchStatuses();
  }, []);

  const fetchStatuses = async () => {
    try {
      const [statusRes, subRes] = await Promise.all([
        supabase
          .from("claim_statuses")
          .select("id, name, color, gradient")
          .eq("is_active", true)
          .order("display_order"),
        supabase
          .from("claim_sub_statuses")
          .select("id, parent_status_id, name, display_order")
          .eq("is_active", true)
          .order("display_order"),
      ]);

      if (statusRes.error) throw statusRes.error;
      setStatuses(statusRes.data || []);
      setSubStatuses(subRes.data || []);
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
        .update({ status: newStatus, sub_status_id: null })
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
      onSubStatusChange?.(null);
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

  const handleSubStatusChange = async (subStatusId: string) => {
    setLoading(true);
    try {
      const value = subStatusId === "none" ? null : subStatusId;
      const { error } = await supabase
        .from("claims")
        .update({ sub_status_id: value })
        .eq("id", claimId);

      if (error) throw error;

      // Fire sub-status task automations
      if (value) {
        fireSubStatusAutomations(claimId, value);
      }

      toast({ title: "Sub-status updated" });
      onSubStatusChange?.(value);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const fireSubStatusAutomations = async (claimId: string, subStatusId: string) => {
    try {
      const { data: automations } = await supabase
        .from("task_automations")
        .select("*")
        .eq("trigger_type", "on_sub_status_change")
        .eq("trigger_sub_status_id", subStatusId)
        .eq("is_active", true);

      if (!automations || automations.length === 0) return;

      const { data: { user } } = await supabase.auth.getUser();

      for (const auto of automations) {
        const dueDate = auto.due_date_offset
          ? new Date(Date.now() + auto.due_date_offset * 86400000).toISOString().split("T")[0]
          : null;

        await supabase.from("tasks").insert({
          title: auto.title,
          description: auto.description,
          claim_id: claimId,
          priority: auto.priority || "medium",
          priority_level: auto.priority || "medium",
          status: "backlog",
          due_date: dueDate,
          created_by: user?.id || null,
        });
      }
    } catch (err) {
      console.error("Sub-status automation error:", err);
    }
  };

  if (initialLoading) {
    return <Skeleton className="h-8 w-[160px] rounded-full" />;
  }

  const currentStatusObj = statuses.find(s => s.name === currentStatus);
  const currentSubSubs = currentStatusObj
    ? subStatuses.filter(s => s.parent_status_id === currentStatusObj.id)
    : [];
  const currentSubObj = currentSubStatusId
    ? subStatuses.find(s => s.id === currentSubStatusId)
    : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
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
                {subStatuses.filter(s => s.parent_status_id === status.id).length > 0 && (
                  <span className="text-[10px] opacity-60 ml-1">
                    ({subStatuses.filter(s => s.parent_status_id === status.id).length} steps)
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {currentSubSubs.length > 0 && (
        <>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <Select
            value={currentSubStatusId || "none"}
            onValueChange={handleSubStatusChange}
            disabled={loading}
          >
            <SelectTrigger className="min-w-[120px] max-w-[220px] w-auto rounded-full border shadow-sm h-8 text-xs font-medium px-3">
              {currentSubObj ? (
                <span className="text-left whitespace-nowrap">{currentSubObj.name}</span>
              ) : (
                <span className="text-muted-foreground">Select step...</span>
              )}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none" className="text-xs text-muted-foreground">
                No sub-step
              </SelectItem>
              {currentSubSubs.map((sub, idx) => (
                <SelectItem key={sub.id} value={sub.id} className="text-xs">
                  <span className="text-muted-foreground mr-1">{idx + 1}.</span>
                  {sub.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  );
}
