import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Play, Pause, CheckCircle2, AlertTriangle, ArrowDown, GripVertical, Clock, Flame, ExternalLink, Zap, Timer } from "lucide-react";
import { ExecutionTask, getStaleStatus, getImmediateTaskDueStatus, isTaskSnoozed } from "@/services/taskExecutionService";
import { formatDistanceToNow, format } from "date-fns";
import { Link } from "react-router-dom";

interface ExecutionTaskCardProps {
  task: ExecutionTask;
  showDragHandle?: boolean;
  onActivate?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onComplete?: () => void;
  onBlock?: () => void;
  onBacklog?: () => void;
  onOpenDetail?: () => void;
  compact?: boolean;
}

const priorityColors: Record<string, string> = {
  immediate: "bg-destructive/15 text-destructive border-destructive/30 font-bold",
  critical: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  high: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30",
  medium: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  low: "bg-muted text-muted-foreground border-border",
};

const gravityColor = (score: number) => {
  if (score >= 70) return "text-red-500";
  if (score >= 45) return "text-orange-500";
  if (score >= 20) return "text-blue-500";
  return "text-muted-foreground";
};

export function ExecutionTaskCard({
  task,
  showDragHandle,
  onActivate,
  onPause,
  onResume,
  onComplete,
  onBlock,
  onBacklog,
  onOpenDetail,
  compact,
}: ExecutionTaskCardProps) {
  const staleStatus = getStaleStatus(task.last_touched_at);
  const isPaused = !!task.paused_at;
  const isActive = task.status === 'active';
  const isImmediate = task.immediate_enabled || task.priority_level === 'immediate';
  const dueStatus = task.due_at ? getImmediateTaskDueStatus(task as any) : 'normal';
  const isSnoozed = isTaskSnoozed(task as any);

  return (
    <Card
      className={`p-3 transition-all hover:shadow-md cursor-pointer group ${
        isImmediate ? 'border-destructive/50 ring-1 ring-destructive/20 bg-destructive/[0.02]' :
        staleStatus === 'requires_decision' ? 'border-red-500 ring-1 ring-red-500/20' :
        staleStatus === 'stale' ? 'border-amber-500/50' :
        isActive && !isPaused ? 'border-primary/30' : ''
      }`}
      onClick={onOpenDetail}
    >
      <div className="flex items-start gap-2">
        {showDragHandle && (
          <div className="mt-1 cursor-grab opacity-0 group-hover:opacity-60 transition-opacity" onClick={(e) => e.stopPropagation()}>
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {isImmediate && (
              <Badge variant="destructive" className="text-[9px] px-1.5 py-0 font-bold tracking-wider gap-0.5">
                <Zap className="h-2.5 w-2.5" />
                IMMEDIATE
              </Badge>
            )}
            {!isImmediate && task.active_rank === 1 && isActive && (
              <Badge variant="default" className="text-[10px] px-1.5 py-0 bg-primary">DO NEXT</Badge>
            )}
            <h4 className="text-sm font-medium truncate text-foreground">{task.title}</h4>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {task.claim_number && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {task.claim_number}
              </Badge>
            )}
            {!isImmediate && (
              <Badge className={`text-[10px] px-1.5 py-0 border ${priorityColors[task.priority_level] || priorityColors.medium}`}>
                {task.priority_level}
              </Badge>
            )}
            {task.gravity_score > 0 && (
              <span className={`flex items-center gap-0.5 ${gravityColor(task.gravity_score)}`}>
                <Flame className="h-3 w-3" />
                {task.gravity_score}
              </span>
            )}
            {isImmediate && task.escalation_level >= 2 && (
              <Badge className="text-[10px] px-1 py-0 bg-orange-500/15 text-orange-700 border-orange-500/30">
                L{task.escalation_level}
              </Badge>
            )}
            {isImmediate && isSnoozed && task.snoozed_until && (
              <span className="flex items-center gap-0.5 text-amber-600">
                <Timer className="h-3 w-3" />
                {format(new Date(task.snoozed_until), "h:mm a")}
              </span>
            )}
            {task.due_at && (
              <span className={`flex items-center gap-0.5 ${
                dueStatus === 'overdue' ? 'text-destructive font-medium' :
                dueStatus === 'urgent' ? 'text-orange-600' : 'text-muted-foreground'
              }`}>
                <Clock className="h-3 w-3" />
                {dueStatus === 'overdue' ? 'OVERDUE' : format(new Date(task.due_at), "h:mm a")}
              </span>
            )}
            {staleStatus !== 'fresh' && !isImmediate && (
              <span className={`flex items-center gap-0.5 ${staleStatus === 'requires_decision' ? 'text-red-500' : 'text-amber-500'}`}>
                <AlertTriangle className="h-3 w-3" />
                {staleStatus === 'requires_decision' ? 'Action needed' : 'Stale'}
              </span>
            )}
            {!isImmediate && task.last_touched_at && (
              <span className="text-muted-foreground flex items-center gap-0.5">
                <Clock className="h-3 w-3" />
                {formatDistanceToNow(new Date(task.last_touched_at), { addSuffix: true })}
              </span>
            )}
            {task.done_definition && !compact && (
              <span className="text-muted-foreground truncate max-w-[150px]">
                ✓ {task.done_definition}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {task.status === 'active' && isPaused && onResume && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onResume} title="Resume">
              <Play className="h-3.5 w-3.5 text-primary" />
            </Button>
          )}
          {task.status === 'active' && !isPaused && onPause && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onPause} title="Pause">
              <Pause className="h-3.5 w-3.5" />
            </Button>
          )}
          {(task.status === 'backlog' || task.status === 'pending' || task.status === 'blocked') && onActivate && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onActivate} title="Activate">
              <Play className="h-3.5 w-3.5 text-primary" />
            </Button>
          )}
          {onComplete && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onComplete} title="Complete">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            </Button>
          )}
          {isActive && onBacklog && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBacklog} title="Move to Backlog">
              <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
          {task.claim_id && (
            <Link to={`/claims/${task.claim_id}`} onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}
