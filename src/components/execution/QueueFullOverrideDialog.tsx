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
import { AlertTriangle, Pause, ArrowDown, CheckCircle2 } from "lucide-react";
import { ExecutionTask, pauseTask, moveToBacklog, completeTask, overrideStartImmediate } from "@/services/taskExecutionService";
import { useToast } from "@/hooks/use-toast";

interface Props {
  immediateTask: ExecutionTask | null;
  activeTasks: ExecutionTask[];
  open: boolean;
  onClose: () => void;
  onRefetch: () => void;
}

export function QueueFullOverrideDialog({ immediateTask, activeTasks, open, onClose, onRefetch }: Props) {
  const [acting, setActing] = useState(false);
  const { toast } = useToast();

  if (!immediateTask) return null;

  const handleOverride = async (activeTaskId: string, action: 'pause' | 'backlog' | 'complete') => {
    setActing(true);
    let result;
    if (action === 'pause') {
      result = await overrideStartImmediate(immediateTask.id, activeTaskId);
    } else if (action === 'backlog') {
      const r = await moveToBacklog(activeTaskId);
      if (r.success) {
        const { activateTask } = await import("@/services/taskExecutionService");
        result = await activateTask(immediateTask.id);
      } else {
        result = r;
      }
    } else {
      const r = await completeTask(activeTaskId);
      if (r.success) {
        const { activateTask } = await import("@/services/taskExecutionService");
        result = await activateTask(immediateTask.id);
      } else {
        result = r;
      }
    }

    setActing(false);
    if (result?.success) {
      toast({ title: "Immediate task started" });
      onRefetch();
      onClose();
    } else {
      toast({ title: "Error", description: result?.error, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <Badge variant="destructive" className="text-xs">QUEUE FULL</Badge>
          </div>
          <DialogTitle>This urgent task needs focus</DialogTitle>
          <DialogDescription>
            Pause, backlog, or complete one active task to continue.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 mb-3">
          <p className="text-sm font-medium">{immediateTask.title}</p>
          {immediateTask.urgent_reason && (
            <p className="text-xs text-muted-foreground mt-0.5">{immediateTask.urgent_reason}</p>
          )}
        </div>

        <div className="space-y-2 max-h-[300px] overflow-y-auto">
          {activeTasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between border rounded-lg p-2.5">
              <div className="min-w-0 flex-1 mr-2">
                <p className="text-sm font-medium truncate">{t.title}</p>
                {t.claim_number && (
                  <Badge variant="outline" className="text-[10px] mt-0.5">{t.claim_number}</Badge>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleOverride(t.id, 'pause')} disabled={acting} title="Pause">
                  <Pause className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleOverride(t.id, 'backlog')} disabled={acting} title="Backlog">
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleOverride(t.id, 'complete')} disabled={acting} title="Complete">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
