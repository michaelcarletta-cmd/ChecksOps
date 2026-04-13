import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ListTodo, Archive, AlertTriangle } from "lucide-react";
import { ExecutionTaskCard } from "./ExecutionTaskCard";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { BlockTaskDialog } from "./BlockTaskDialog";
import {
  activateTask,
  pauseTask,
  resumeTask,
  completeTask,
  blockTask,
  moveToBacklog,
  snoozeImmediateTask,
  MAX_ACTIVE_TASKS,
  ExecutionTask,
} from "@/services/taskExecutionService";
import { toast } from "sonner";

interface ExecutionQueuePanelProps {
  activeTasks: ExecutionTask[];
  backlogTasks: ExecutionTask[];
  blockedTasks: ExecutionTask[];
  loading: boolean;
  onRefetch: () => void | Promise<void>;
}

export function ExecutionQueuePanel({ activeTasks, backlogTasks, blockedTasks, loading, onRefetch }: ExecutionQueuePanelProps) {
  const [selectedTask, setSelectedTask] = useState<ExecutionTask | null>(null);
  const [blockingTaskId, setBlockingTaskId] = useState<string | null>(null);

  const handleAction = async (action: () => Promise<{ success: boolean; error?: string }>, successMsg: string) => {
    const result = await action();
    if (result.success) {
      toast.success(successMsg);
      // Force immediate refetch to clear stale state
      await onRefetch();
    } else {
      toast.error(result.error || "Action failed");
    }
  };

  const handleSnooze = (taskId: string, minutes: number) => {
    handleAction(() => snoozeImmediateTask(taskId, minutes), `Snoozed for ${minutes} min`);
  };

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ListTodo className="h-5 w-5" />Execution Queue</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Loading...</p></CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ListTodo className="h-5 w-5" />
              Execution Queue
            </div>
            <Badge variant={activeTasks.length >= MAX_ACTIVE_TASKS ? "destructive" : "secondary"} className="text-xs">
              {activeTasks.length} / {MAX_ACTIVE_TASKS} Active
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Tabs defaultValue="active">
            <TabsList className="w-full mb-3">
              <TabsTrigger value="active" className="flex-1 text-xs">
                Active ({activeTasks.length})
              </TabsTrigger>
              <TabsTrigger value="backlog" className="flex-1 text-xs">
                <Archive className="h-3 w-3 mr-1" />
                Backlog ({backlogTasks.length})
              </TabsTrigger>
              {blockedTasks.length > 0 && (
                <TabsTrigger value="blocked" className="flex-1 text-xs">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Blocked ({blockedTasks.length})
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="active" className="space-y-2 mt-0">
              {activeTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No active tasks. Activate tasks from the backlog.</p>
              ) : (
                activeTasks.map((task) => (
                  <ExecutionTaskCard
                    key={task.id}
                    task={task}
                    showDragHandle
                    onPause={() => handleAction(() => pauseTask(task.id), "Task paused")}
                    onResume={() => handleAction(() => resumeTask(task.id), "Task resumed")}
                    onComplete={() => handleAction(() => completeTask(task.id), "Task completed ✓")}
                    onBacklog={() => handleAction(() => moveToBacklog(task.id), "Moved to backlog")}
                    onBlock={() => setBlockingTaskId(task.id)}
                    onOpenDetail={() => setSelectedTask(task)}
                    onSnooze={(mins) => handleSnooze(task.id, mins)}
                  />
                ))
              )}
            </TabsContent>

            <TabsContent value="backlog" className="space-y-2 mt-0">
              {backlogTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">Backlog is empty</p>
              ) : (
                backlogTasks.map((task) => (
                  <ExecutionTaskCard
                    key={task.id}
                    task={task}
                    compact
                    onActivate={() => handleAction(() => activateTask(task.id), "Task activated")}
                    onComplete={() => handleAction(() => completeTask(task.id), "Task completed ✓")}
                    onOpenDetail={() => setSelectedTask(task)}
                    onSnooze={(mins) => handleSnooze(task.id, mins)}
                  />
                ))
              )}
            </TabsContent>

            <TabsContent value="blocked" className="space-y-2 mt-0">
              {blockedTasks.map((task) => (
                <ExecutionTaskCard
                  key={task.id}
                  task={task}
                  compact
                  onActivate={() => handleAction(() => activateTask(task.id), "Task reactivated")}
                  onComplete={() => handleAction(() => completeTask(task.id), "Task completed ✓")}
                  onOpenDetail={() => setSelectedTask(task)}
                  onSnooze={(mins) => handleSnooze(task.id, mins)}
                />
              ))}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <TaskDetailDrawer
        task={selectedTask}
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
        onRefetch={onRefetch}
      />

      <BlockTaskDialog
        open={!!blockingTaskId}
        onClose={() => setBlockingTaskId(null)}
        onConfirm={async (reason) => {
          if (blockingTaskId) {
            await handleAction(() => blockTask(blockingTaskId, reason), "Task blocked");
            setBlockingTaskId(null);
          }
        }}
      />
    </>
  );
}
