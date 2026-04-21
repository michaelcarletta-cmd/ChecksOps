import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";

interface ClaimBoardCardProps {
  entry: ClaimBoardEntry;
}

export function ClaimBoardCard({ entry }: ClaimBoardCardProps) {
  const navigate = useNavigate();
  const ops = entry.ops;
  const followUp = (ops?.follow_up_status || "on_track") as FollowUpStatus;
  const fuConfig = FOLLOWUP_STATUS_CONFIG[followUp] || FOLLOWUP_STATUS_CONFIG.on_track;

  const daysInactive = ops?.days_since_last_activity || 0;
  const pressureScore = ops?.pressure_score || 0;
  const nextAction = ops?.next_best_action;
  const lifecycleStage = ops?.lifecycle_stage || entry.status || "new";

  const hasFlags = ops?.stale_flag || ops?.contradiction_flag || ops?.high_exposure_flag;
  const hasUrgentMicrotasks = entry.immediate_microtasks > 0 || entry.blocking_microtasks > 0;

  // Border color based on urgency
  const borderClass =
    followUp === "escalation"
      ? "border-red-500 dark:border-red-400"
      : followUp === "overdue"
      ? "border-amber-500 dark:border-amber-400"
      : "border-border";

  return (
    <Card className={`p-4 ${borderClass} hover:shadow-md transition-shadow`}>
      <div className="flex flex-col gap-3">
        {/* Top row: claim info + follow-up badge */}
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

          {/* Flags */}
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

          {/* Microtask indicators */}
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
        </div>

        {/* Next best action */}
        {nextAction && (
          <p className="text-sm text-foreground bg-muted/50 rounded px-2 py-1.5">
            → {nextAction}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="default"
            onClick={() => navigate(`/claims/${entry.claim_id}`)}
          >
            <ExternalLink className="h-3 w-3 mr-1" />
            Open Claim
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              navigate(`/claims/${entry.claim_id}?tab=warroom`);
            }}
          >
            <Swords className="h-3 w-3 mr-1" />
            War Room
          </Button>
        </div>
      </div>
    </Card>
  );
}
