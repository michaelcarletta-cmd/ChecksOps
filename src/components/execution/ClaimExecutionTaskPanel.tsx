import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { ListTodo, Plus, CheckCircle2, Play, ExternalLink } from "lucide-react";
import { activateTask, completeTask, ExecutionTask } from "@/services/taskExecutionService";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

interface Props {
  claimId: string;
  claimNumber?: string;
}

export function ClaimExecutionTaskPanel({ claimId, claimNumber }: Props) {
  const [tasks, setTasks] = useState<ExecutionTask[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchTasks = async () => {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('claim_id', claimId)
      .in('status', ['active', 'backlog', 'pending', 'blocked'])
      .order('gravity_score', { ascending: false });

    if (!error) setTasks((data as unknown as ExecutionTask[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchTasks();
    const ch = supabase.channel(`claim-tasks-${claimId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `claim_id=eq.${claimId}` }, () => fetchTasks())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [claimId]);

  const handleActivate = async (id: string) => {
    const r = await activateTask(id);
    if (r.success) { toast({ title: "Task activated" }); fetchTasks(); }
    else toast({ title: "Error", description: r.error, variant: "destructive" });
  };

  const handleComplete = async (id: string) => {
    const r = await completeTask(id);
    if (r.success) { toast({ title: "Task completed ✓" }); fetchTasks(); }
    else toast({ title: "Error", description: r.error, variant: "destructive" });
  };

  const activeTasks = tasks.filter(t => t.status === 'active');
  const otherTasks = tasks.filter(t => t.status !== 'active');

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4" />
            Open Tasks: {tasks.length}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No open tasks on this claim</p>
        ) : (
          <div className="space-y-1.5">
            {[...activeTasks, ...otherTasks].slice(0, 8).map((task) => (
              <div key={task.id} className="flex items-center gap-2 text-xs p-1.5 rounded border hover:bg-accent/50">
                <div className="flex-1 min-w-0">
                  <span className="truncate block font-medium">{task.title}</span>
                  <div className="flex gap-1 mt-0.5">
                    <Badge variant={task.status === 'active' ? 'default' : 'outline'} className="text-[9px] px-1 py-0">
                      {task.status}
                    </Badge>
                    <Badge variant="outline" className="text-[9px] px-1 py-0">{task.priority_level}</Badge>
                  </div>
                </div>
                <div className="flex gap-0.5 shrink-0">
                  {task.status !== 'active' && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleActivate(task.id)}>
                      <Play className="h-3 w-3" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleComplete(task.id)}>
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
