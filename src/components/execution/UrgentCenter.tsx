import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock, Play, Timer, Bell, BellOff } from "lucide-react";
import { ExecutionTask, getImmediateTaskDueStatus, isTaskSnoozed } from "@/services/taskExecutionService";
import { formatDistanceToNow, format } from "date-fns";
import { Link } from "react-router-dom";

interface Props {
  immediateTasks: ExecutionTask[];
  onOpenInterrupt?: (task: ExecutionTask) => void;
}

const channelIcons: Record<string, string> = {
  in_app: '🔔',
  push: '📱',
  sms: '💬',
  email: '📧',
};

export function UrgentCenter({ immediateTasks, onOpenInterrupt }: Props) {
  if (immediateTasks.length === 0) return null;

  const active = immediateTasks.filter(t => !isTaskSnoozed(t) && t.status !== 'blocked');
  const snoozed = immediateTasks.filter(t => isTaskSnoozed(t));
  const overdue = immediateTasks.filter(t => getImmediateTaskDueStatus(t) === 'overdue');

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <span className="text-destructive font-semibold">Urgent Now</span>
          </div>
          <div className="flex gap-1.5">
            {active.length > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                {active.length} active
              </Badge>
            )}
            {snoozed.length > 0 && (
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600">
                {snoozed.length} snoozed
              </Badge>
            )}
            {overdue.length > 0 && (
              <Badge variant="destructive" className="text-[10px] bg-red-700">
                {overdue.length} overdue
              </Badge>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 space-y-2">
        {immediateTasks.map((task) => {
          const dueStatus = getImmediateTaskDueStatus(task);
          const isSnoozed = isTaskSnoozed(task);

          return (
            <div
              key={task.id}
              className={`rounded-lg border p-2.5 cursor-pointer transition-all hover:shadow-sm ${
                dueStatus === 'overdue'
                  ? 'border-red-500 bg-red-500/5'
                  : isSnoozed
                  ? 'border-amber-500/40 bg-amber-500/5 opacity-80'
                  : 'border-destructive/30 bg-background'
              }`}
              onClick={() => onOpenInterrupt?.(task)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Badge variant="destructive" className="text-[9px] px-1 py-0 font-bold tracking-wide">
                      IMMEDIATE
                    </Badge>
                    {task.escalation_level >= 2 && (
                      <Badge className="text-[9px] px-1 py-0 bg-orange-500/15 text-orange-700 border-orange-500/30">
                        L{task.escalation_level}
                      </Badge>
                    )}
                    {isSnoozed && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 border-amber-500/40 text-amber-600">
                        <BellOff className="h-2.5 w-2.5 mr-0.5" />
                        Snoozed
                      </Badge>
                    )}
                  </div>
                  <h4 className="text-sm font-medium truncate text-foreground">{task.title}</h4>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    {task.claim_number && (
                      <Badge variant="outline" className="text-[10px] px-1 py-0">{task.claim_number}</Badge>
                    )}
                    {task.due_at && (
                      <span className={`flex items-center gap-0.5 ${dueStatus === 'overdue' ? 'text-destructive font-medium' : dueStatus === 'urgent' ? 'text-orange-600' : ''}`}>
                        <Clock className="h-3 w-3" />
                        {dueStatus === 'overdue' ? 'OVERDUE' : format(new Date(task.due_at), "h:mm a")}
                      </span>
                    )}
                    {isSnoozed && task.snoozed_until && (
                      <span className="flex items-center gap-0.5 text-amber-600">
                        <Timer className="h-3 w-3" />
                        Until {format(new Date(task.snoozed_until), "h:mm a")}
                      </span>
                    )}
                    <span className="flex items-center gap-0.5">
                      {(task.notification_channels || []).map((ch: string) => (
                        <span key={ch} title={ch}>{channelIcons[ch] || '🔔'}</span>
                      ))}
                    </span>
                  </div>
                </div>
                {!isSnoozed && (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0 text-xs h-7"
                    onClick={(e) => { e.stopPropagation(); onOpenInterrupt?.(task); }}
                  >
                    <Play className="h-3 w-3 mr-1" /> Act
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
