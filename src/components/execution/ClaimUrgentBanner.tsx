import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Zap } from "lucide-react";
import { ExecutionTask, getImmediateTaskDueStatus } from "@/services/taskExecutionService";

interface Props {
  urgentTasks: ExecutionTask[];
  compact?: boolean;
}

/**
 * Compact urgent task banner for embedding in claim detail, War Room, or Copilot panels.
 * Shows a red banner when claim-linked immediate tasks exist.
 */
export function ClaimUrgentBanner({ urgentTasks, compact }: Props) {
  if (urgentTasks.length === 0) return null;

  const overdueCount = urgentTasks.filter(t => getImmediateTaskDueStatus(t) === 'overdue').length;

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-destructive/30 bg-destructive/5 text-xs">
        <Zap className="h-3 w-3 text-destructive shrink-0" />
        <span className="font-medium text-destructive">
          {urgentTasks.length === 1
            ? 'Immediate action required on this file'
            : `Urgent tasks on this claim: ${urgentTasks.length}`}
        </span>
        {overdueCount > 0 && (
          <Badge variant="destructive" className="text-[9px] px-1 py-0 ml-auto">{overdueCount} overdue</Badge>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <span className="text-sm font-semibold text-destructive">Immediate action required</span>
        <Badge variant="destructive" className="text-[10px] ml-auto">{urgentTasks.length} task{urgentTasks.length !== 1 ? 's' : ''}</Badge>
      </div>
      <div className="space-y-1">
        {urgentTasks.map(t => {
          const dueStatus = getImmediateTaskDueStatus(t);
          return (
            <div key={t.id} className="flex items-center justify-between text-xs">
              <span className="truncate font-medium">{t.title}</span>
              {dueStatus === 'overdue' && (
                <Badge variant="destructive" className="text-[9px] px-1 py-0 shrink-0 ml-2">OVERDUE</Badge>
              )}
              {dueStatus === 'urgent' && (
                <Badge className="text-[9px] px-1 py-0 shrink-0 ml-2 bg-orange-500/15 text-orange-700 border-orange-500/30">DUE SOON</Badge>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
