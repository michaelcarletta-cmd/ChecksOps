import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  ClaimBoardEntry,
  FollowUpStatus,
  FOLLOWUP_STATUS_CONFIG,
} from "@/services/claimOperationsService";
import {
  ExternalLink,
  Swords,
  Clock,
  AlertTriangle,
  ShieldAlert,
  Zap,
  Ban,
  MessageSquarePlus,
  PhoneCall,
  Send,
} from "lucide-react";

interface ClaimBoardCardProps {
  entry: ClaimBoardEntry;
}

export function ClaimBoardCard({ entry }: ClaimBoardCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);

  const ops = entry.ops;
  const followUp = (ops?.follow_up_status || "on_track") as FollowUpStatus;
  const fuConfig = FOLLOWUP_STATUS_CONFIG[followUp] || FOLLOWUP_STATUS_CONFIG.on_track;

  const daysInactive = ops?.days_since_last_activity || 0;
  const pressureScore = ops?.pressure_score || 0;
  const nextAction = ops?.next_best_action;
  const displayStatus = entry.status || "Unknown";

  const hasUrgentMicrotasks = entry.immediate_microtasks > 0 || entry.blocking_microtasks > 0;

  const borderClass =
    followUp === "escalation"
      ? "border-red-500 dark:border-red-400"
      : followUp === "overdue"
      ? "border-amber-500 dark:border-amber-400"
      : "border-border";

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      await (supabase.from("claim_events") as any).insert({
        claim_id: entry.claim_id,
        event_type: "note",
        summary: noteText.trim(),
        actor: user?.email || "staff",
        is_manual: true,
      });
      toast({ title: "Note added" });
      setNoteText("");
      setShowNoteInput(false);
      queryClient.invalidateQueries({ queryKey: ["claim-control-board"] });
    } catch {
      toast({ title: "Failed to add note", variant: "destructive" });
    }
    setSaving(false);
  };

  const handleMarkContacted = async () => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      await (supabase.from("claim_events") as any).insert({
        claim_id: entry.claim_id,
        event_type: "communication",
        summary: "Contacted carrier — status check",
        actor: user?.email || "staff",
        is_manual: true,
      });
      toast({ title: "Marked as contacted" });
      queryClient.invalidateQueries({ queryKey: ["claim-control-board"] });
    } catch {
      toast({ title: "Failed to log contact", variant: "destructive" });
    }
    setSaving(false);
  };

  return (
    <Card className={`p-4 ${borderClass} hover:shadow-md transition-shadow`}>
      <div className="flex flex-col gap-2.5">
        {/* Top row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground truncate">
                {entry.policyholder_name || "Unknown"}
              </span>
              {entry.claim_number && (
                <span className="text-xs text-muted-foreground">#{entry.claim_number}</span>
              )}
            </div>
            {entry.property_address && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">{entry.property_address}</p>
            )}
            {entry.insurance_carrier && (
              <p className="text-xs text-muted-foreground">{entry.insurance_carrier}</p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="text-xs capitalize">
              {lifecycleStage.replace(/_/g, " ")}
            </Badge>
            <span className={`text-xs font-semibold ${fuConfig.color}`}>
              {fuConfig.label}
            </span>
          </div>
        </div>

        {/* Metrics row */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {daysInactive}d inactive
          </span>
          <span className="flex items-center gap-1">
            Pressure: <strong className={pressureScore >= 60 ? "text-red-500" : pressureScore >= 35 ? "text-amber-500" : "text-foreground"}>
              {pressureScore}
            </strong>
          </span>

          {ops?.stale_flag && (
            <span className="flex items-center gap-1 text-amber-500">
              <Clock className="h-3 w-3" /> Stale
            </span>
          )}
          {ops?.contradiction_flag && (
            <span className="flex items-center gap-1 text-red-500">
              <AlertTriangle className="h-3 w-3" /> Contradiction
            </span>
          )}
          {ops?.high_exposure_flag && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="h-3 w-3" /> High Exposure
            </span>
          )}

          {entry.immediate_microtasks > 0 && (
            <span className="flex items-center gap-1 text-red-500 font-medium">
              <Zap className="h-3 w-3" /> {entry.immediate_microtasks} immediate
            </span>
          )}
          {entry.blocking_microtasks > 0 && (
            <span className="flex items-center gap-1 text-orange-500 font-medium">
              <Ban className="h-3 w-3" /> {entry.blocking_microtasks} blocking
            </span>
          )}
          {(entry.overdue_tasks || 0) > 0 && (
            <span className="flex items-center gap-1 text-destructive font-medium">
              <AlertTriangle className="h-3 w-3" /> {entry.overdue_tasks} overdue tasks
            </span>
          )}
          {(entry.open_tasks || 0) > 0 && (
            <span className="flex items-center gap-1 text-foreground font-medium">
              {entry.open_tasks} open tasks
            </span>
          )}
        </div>

        {/* Next best action */}
        {nextAction && (
          <p className="text-sm text-foreground bg-muted/50 rounded px-2 py-1.5">
            → {nextAction}
          </p>
        )}

        {/* Quick note input */}
        {showNoteInput && (
          <div className="flex gap-2">
            <Input
              placeholder="Quick note..."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              className="text-sm h-8"
              onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
              autoFocus
            />
            <Button size="sm" variant="default" onClick={handleAddNote} disabled={saving || !noteText.trim()}>
              <Send className="h-3 w-3" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowNoteInput(false); setNoteText(""); }}>
              ✕
            </Button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="default"
            onClick={() => navigate(`/claims/${entry.claim_id}`)}
          >
            <ExternalLink className="h-3 w-3 mr-1" />
            Open
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(`/claims/${entry.claim_id}?tab=warroom`)}
          >
            <Swords className="h-3 w-3 mr-1" />
            War Room
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowNoteInput(!showNoteInput)}
          >
            <MessageSquarePlus className="h-3 w-3 mr-1" />
            Note
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleMarkContacted}
            disabled={saving}
          >
            <PhoneCall className="h-3 w-3 mr-1" />
            Contacted
          </Button>
        </div>
      </div>
    </Card>
  );
}
