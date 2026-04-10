import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { ListTodo, Plus, CheckCircle2, Play, ExternalLink, Zap, AlertTriangle } from "lucide-react";
import {
  activateTask,
  completeTask,
  ExecutionTask,
  getClaimImmediateTasks,
  getImmediateTaskDueStatus,
  isTaskSnoozed,
} from "@/services/taskExecutionService";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

interface Props {
  claimId: string;
  claimNumber?: string;
}

export function ClaimExecutionTaskPanel({ claimId, claimNumber }: Props) {
  const [tasks, setTasks] = useState<ExecutionTask[]>([]);
  const [urgentTasks, setUrgentTasks] = useState<ExecutionTask[]>([]);
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

    // Fetch urgent tasks separately for the banner
    const urgent = await getClaimImmediateTasks(claimId);
    setUrgentTasks(urgent);

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
          {urgentTasks.length > 0 && (
            <Badge variant="destructive" className="text-[10px] gap-0.5">
              <Zap className="h-3 w-3" /> {urgentTasks.length} urgent
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Urgent task banner */}
        {urgentTasks.length > 0 && (
          <div className="mb-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2">
            <div className="flex items-center gap-1.5 mb-1">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              <span className="text-xs font-semibold text-destructive">Immediate action required</span>
            </div>
            {urgentTasks.map(t => {
              const dueStatus = getImmediateTaskDueStatus(t);
              return (
                <div key={t.id} className="flex items-center gap-2 text-xs py-1">
                  <span className="truncate flex-1 font-medium">{t.title}</span>
                  {dueStatus === 'overdue' && (
                    <Badge variant="destructive" className="text-[9px] px-1 py-0">OVERDUE</Badge>
                  )}
                  {dueStatus === 'urgent' && (
                    <Badge className="text-[9px] px-1 py-0 bg-orange-500/15 text-orange-700 border-orange-500/30">DUE SOON</Badge>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No open tasks on this claim</p>
        ) : (
          <div className="space-y-1.5">
            {[...activeTasks, ...otherTasks].slice(0, 8).map((task) => {
              const isImmediate = task.immediate_enabled || task.priority_level === 'immediate';
              return (
                <div key={task.id} className={`flex items-center gap-2 text-xs p-1.5 rounded border hover:bg-accent/50 ${
                  isImmediate ? 'border-destructive/30 bg-destructive/[0.02]' : ''
                }`}>
                  <div className="flex-1 min-w-0">
                    <span className="truncate block font-medium">{task.title}</span>
                    <div className="flex gap-1 mt-0.5">
                      {isImmediate ? (
                        <Badge variant="destructive" className="text-[9px] px-1 py-0 gap-0.5">
                          <Zap className="h-2.5 w-2.5" /> IMMEDIATE
                        </Badge>
                      ) : (
                        <>
                          <Badge variant={task.status === 'active' ? 'default' : 'outline'} className="text-[9px] px-1 py-0">
                            {task.status}
                          </Badge>
                          <Badge variant="outline" className="text-[9px] px-1 py-0">{task.priority_level}</Badge>
                        </>
                      )}
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
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
