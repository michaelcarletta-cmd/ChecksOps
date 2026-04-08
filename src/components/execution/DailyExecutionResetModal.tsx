import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sun, CheckCircle2, AlertTriangle, Archive, ArrowUp } from "lucide-react";
import { useExecutionQueue } from "@/hooks/useExecutionQueue";
import { checkDailyResetNeeded, markDailyResetDone, activateTask, ExecutionTask } from "@/services/taskExecutionService";
import { useToast } from "@/hooks/use-toast";

export function DailyExecutionResetModal() {
  const [open, setOpen] = useState(false);
  const { activeTasks, backlogTasks, blockedTasks, refetch } = useExecutionQueue();
  const { toast } = useToast();

  useEffect(() => {
    checkDailyResetNeeded().then((needed) => {
      if (needed && (activeTasks.length > 0 || backlogTasks.length > 0 || blockedTasks.length > 0)) {
        setOpen(true);
      }
    });
  }, [activeTasks.length, backlogTasks.length, blockedTasks.length]);

  const handleDismiss = () => {
    markDailyResetDone();
    setOpen(false);
  };

  const handlePromote = async (task: ExecutionTask) => {
    const result = await activateTask(task.id);
    if (result.success) {
      toast({ title: `"${task.title}" activated` });
      refetch();
    } else {
      toast({ title: "Error", description: result.error, variant: "destructive" });
    }
  };

  // Top 3 suggested from backlog by gravity
  const suggested = backlogTasks.slice(0, 3);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleDismiss(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sun className="h-5 w-5 text-amber-500" />
            Start Today
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-4">
            {activeTasks.length > 0 && (
              <div>
                <h4 className="text-sm font-medium flex items-center gap-1 mb-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" /> Active Tasks ({activeTasks.length})
                </h4>
                <div className="space-y-1">
                  {activeTasks.map((t) => (
                    <div key={t.id} className="flex items-center justify-between text-sm p-2 rounded border">
                      <span className="truncate">{t.title}</span>
                      <Badge variant="outline" className="text-[10px]">{t.priority_level}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {blockedTasks.length > 0 && (
              <div>
                <h4 className="text-sm font-medium flex items-center gap-1 mb-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" /> Blocked ({blockedTasks.length})
                </h4>
                <div className="space-y-1">
                  {blockedTasks.map((t) => (
                    <div key={t.id} className="text-sm p-2 rounded border">
                      <span className="truncate">{t.title}</span>
                      {t.blocked_reason && <p className="text-xs text-muted-foreground mt-0.5">{t.blocked_reason}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {suggested.length > 0 && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium flex items-center gap-1 mb-2">
                    <Archive className="h-4 w-4" /> Suggested for Today
                  </h4>
                  <div className="space-y-1">
                    {suggested.map((t) => (
                      <div key={t.id} className="flex items-center justify-between text-sm p-2 rounded border">
                        <div className="truncate flex-1">
                          <span>{t.title}</span>
                          {t.claim_number && <span className="text-xs text-muted-foreground ml-1">({t.claim_number})</span>}
                        </div>
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handlePromote(t)}>
                          <ArrowUp className="h-3 w-3 mr-1" /> Activate
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button onClick={handleDismiss}>Let's Go</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
