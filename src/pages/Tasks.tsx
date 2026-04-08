import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExecutionQueuePanel } from "@/components/execution/ExecutionQueuePanel";
import { useExecutionQueue } from "@/hooks/useExecutionQueue";
import { ExecutionTaskCard } from "@/components/execution/ExecutionTaskCard";
import { TaskDetailDrawer } from "@/components/execution/TaskDetailDrawer";
import { completeTask, activateTask, ExecutionTask } from "@/services/taskExecutionService";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";

const Tasks = () => {
  const { activeTasks, backlogTasks, blockedTasks, loading, refetch } = useExecutionQueue();
  const [selectedTask, setSelectedTask] = useState<ExecutionTask | null>(null);
  const { toast } = useToast();

  const { data: completedTasks = [] } = useQuery({
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
        .limit(20);
      if (error) return [];
      return (data || []).map((t: any) => ({
        ...t,
        claim_number: t.claims?.claim_number,
        policyholder_name: t.claims?.policyholder_name,
      }));
    },
  });

  const handleAction = async (action: () => Promise<{ success: boolean; error?: string }>, msg: string) => {
    const r = await action();
    if (r.success) { toast({ title: msg }); refetch(); }
    else toast({ title: "Error", description: r.error, variant: "destructive" });
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

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ExecutionQueuePanel />
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
        onRefetch={refetch}
      />
    </div>
  );
};

export default Tasks;
