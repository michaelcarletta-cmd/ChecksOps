import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Clock, Play, Pause, CheckCircle2, ArrowDown, ChevronDown, Shield } from "lucide-react";
import { ExecutionTask, acknowledgeImmediateTask, getImmediateTaskDueStatus, AcknowledgeAction } from "@/services/taskExecutionService";
import { formatDistanceToNow, format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

interface Props {
  task: ExecutionTask | null;
  open: boolean;
  onClose: () => void;
  onRefetch: () => void;
  onQueueFull?: (task: ExecutionTask) => void;
}

export function ImmediateTaskModal({ task, open, onClose, onRefetch, onQueueFull }: Props) {
  const [acting, setActing] = useState(false);
  const { toast } = useToast();

  if (!task) return null;

  const dueStatus = getImmediateTaskDueStatus(task);
  const canSnooze = task.snooze_allowed && task.snooze_count < task.max_snooze_count;

  const handleAction = async (action: AcknowledgeAction, extra?: any) => {
    setActing(true);
    const result = await acknowledgeImmediateTask(task.id, action, extra);
    setActing(false);

    if (result.error === 'QUEUE_FULL' && onQueueFull) {
      onQueueFull(task);
      onClose();
      return;
    }

    if (result.success) {
      const msgs: Record<string, string> = {
        start_now: 'Task started',
        snooze: `Snoozed for ${extra?.snooze_minutes || 5} min`,
        backlog: 'Moved to backlog',
        blocked: 'Marked blocked',
        complete: 'Task completed ✓',
        downgrade: 'Downgraded from immediate',
      };
      toast({ title: msgs[action] || 'Done' });
      onRefetch();
      onClose();
    } else if (result.error) {
      toast({ title: "Error", description: result.error, variant: "destructive" });
    }
  };

  const escalationLabel = task.escalation_level >= 3 ? 'CRITICAL ESCALATION' :
    task.escalation_level >= 2 ? 'ESCALATED' : 'IMMEDIATE';

  return (
    <Dialog open={open} onOpenChange={(v) => { /* prevent close without action */ }}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-2 rounded-full bg-destructive/15">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <Badge variant="destructive" className="text-xs font-bold tracking-wider">
              {escalationLabel}
            </Badge>
            {dueStatus === 'overdue' && (
              <Badge variant="destructive" className="text-xs">OVERDUE</Badge>
            )}
            {dueStatus === 'urgent' && (
              <Badge className="text-xs bg-orange-500/15 text-orange-700 border-orange-500/30">DUE SOON</Badge>
            )}
          </div>
          <DialogTitle className="text-lg">Immediate action required</DialogTitle>
          <DialogDescription className="text-sm">
            This task needs a decision now.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <h4 className="font-semibold text-sm text-foreground">{task.title}</h4>
            {task.urgent_reason && (
              <p className="text-xs text-muted-foreground mt-1">{task.urgent_reason}</p>
            )}
            {task.claim_number && (
              <Badge variant="outline" className="text-[10px] mt-2">{task.claim_number}</Badge>
            )}
          </div>

          {task.due_at && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>
                Due: {format(new Date(task.due_at), "MMM d, h:mm a")}
                {dueStatus !== 'normal' && (
                  <span className={dueStatus === 'overdue' ? ' text-destructive font-medium' : ' text-orange-600 font-medium'}>
                    {' '}({dueStatus === 'overdue' ? 'OVERDUE' : formatDistanceToNow(new Date(task.due_at), { addSuffix: true })})
                  </span>
                )}
              </span>
            </div>
          )}

          {task.snooze_count > 0 && (
            <p className="text-xs text-muted-foreground">
              Snoozed {task.snooze_count}/{task.max_snooze_count} times
              {!canSnooze && ' — no more snoozes available'}
            </p>
          )}

          <Separator />

          <div className="space-y-2">
            <Button
              className="w-full justify-start gap-2"
              onClick={() => handleAction('start_now')}
              disabled={acting}
            >
              <Play className="h-4 w-4" /> Start now
            </Button>

            {canSnooze && (
              <div className="grid grid-cols-3 gap-2">
                {[5, 10, 15].map((min) => (
                  <Button
                    key={min}
                    variant="outline"
                    size="sm"
                    onClick={() => handleAction('snooze', { snooze_minutes: min })}
                    disabled={acting}
                    className="text-xs"
                  >
                    Snooze {min}m
                  </Button>
                ))}
              </div>
            )}

            <Separator className="my-1" />

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleAction('backlog')}
                disabled={acting}
                className="text-xs gap-1"
              >
                <ArrowDown className="h-3 w-3" /> Backlog
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleAction('blocked')}
                disabled={acting}
                className="text-xs gap-1"
              >
                <Shield className="h-3 w-3" /> Blocked
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleAction('complete')}
                disabled={acting}
                className="text-xs gap-1"
              >
                <CheckCircle2 className="h-3 w-3" /> Complete
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleAction('downgrade')}
                disabled={acting}
                className="text-xs gap-1"
              >
                <ChevronDown className="h-3 w-3" /> Downgrade
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
