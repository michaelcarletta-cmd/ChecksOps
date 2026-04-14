import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExecutionQueuePanel } from "@/components/execution/ExecutionQueuePanel";
import { useExecutionQueue } from "@/hooks/useExecutionQueue";
import { useImmediateTasks } from "@/hooks/useImmediateTasks";
import { TaskSearchPanel } from "@/components/execution/TaskSearchPanel";
import { ExecutionTaskCard } from "@/components/execution/ExecutionTaskCard";
import { TaskDetailDrawer } from "@/components/execution/TaskDetailDrawer";
import { UrgentCenter } from "@/components/execution/UrgentCenter";
import { ImmediateTaskModal } from "@/components/execution/ImmediateTaskModal";
import { QueueFullOverrideDialog } from "@/components/execution/QueueFullOverrideDialog";
import { ExecutionTask } from "@/services/taskExecutionService";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";

const Tasks = () => {
  const { activeTasks, backlogTasks, blockedTasks, loading, refetching, synced, refetch } = useExecutionQueue();
  const { immediateTasks, pendingInterrupt, hasUrgentWork, refetch: refetchImmediate, clearInterrupt, markModalOpen } = useImmediateTasks();
  const [selectedTask, setSelectedTask] = useState<ExecutionTask | null>(null);
  const [interruptTask, setInterruptTask] = useState<ExecutionTask | null>(null);
  const [queueFullTask, setQueueFullTask] = useState<ExecutionTask | null>(null);
  const { toast } = useToast();

  const activeInterrupt = interruptTask || pendingInterrupt;

  const { data: completedTasks = [], refetch: refetchCompleted } = useQuery({
    queryKey: ["completed-tasks"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];
      const { data, error } = await supabase
        .from("tasks")
        .select("*, claims(claim_number, policyholder_name)")
        .or(`assigned_to.eq.${user.id},assigned_to.is.null`)
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .order("updated_at", { ascending: false });
      if (error) return [];
      const mapped = (data || []).map((t: any) => ({
        ...t,
        claim_number: t.claims?.claim_number,
        policyholder_name: t.claims?.policyholder_name,
      }));
      if (import.meta.env.DEV) {
        console.debug("[Tasks] completed task counts", { completed: mapped.length });
      }
      return mapped;
    },
  });

  const handleRefetchAll = async () => {
    await Promise.all([refetch(), refetchImmediate(), refetchCompleted()]);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Tasks</h1>
          <p className="text-muted-foreground mt-1">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Tasks</h1>
        <p className="text-muted-foreground mt-1">Manage your execution queue</p>
      </div>

      <TaskSearchPanel onQueueUpdated={handleRefetchAll} />

      {hasUrgentWork && (
        <UrgentCenter
          immediateTasks={immediateTasks}
          onOpenInterrupt={(t) => setInterruptTask(t)}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ExecutionQueuePanel
            activeTasks={activeTasks}
            backlogTasks={backlogTasks}
            blockedTasks={blockedTasks}
            loading={loading}
            refetching={refetching}
            synced={synced}
            onRefetch={handleRefetchAll}
          />
        </div>

        <div>
          <Tabs defaultValue="completed">
            <TabsList className="w-full">
              <TabsTrigger value="completed" className="flex-1 text-xs">
                Completed ({completedTasks.length})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="completed" className="space-y-2 mt-2">
              {completedTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No completed tasks yet</p>
              ) : (
                completedTasks.map((task: ExecutionTask) => (
                  <ExecutionTaskCard
                    key={task.id}
                    task={task}
                    compact
                    onOpenDetail={() => setSelectedTask(task)}
                  />
                ))
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <TaskDetailDrawer
        task={selectedTask}
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
        onRefetch={handleRefetchAll}
      />

      <ImmediateTaskModal
        task={activeInterrupt}
        open={!!activeInterrupt}
        onClose={() => { clearInterrupt(); setInterruptTask(null); }}
        onRefetch={handleRefetchAll}
        onQueueFull={(t) => setQueueFullTask(t)}
        onModalOpen={markModalOpen}
      />

      <QueueFullOverrideDialog
        immediateTask={queueFullTask}
        activeTasks={activeTasks}
        open={!!queueFullTask}
        onClose={() => setQueueFullTask(null)}
        onRefetch={handleRefetchAll}
      />
    </div>
  );
};

export default Tasks;
