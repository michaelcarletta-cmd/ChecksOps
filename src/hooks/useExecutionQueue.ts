import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ExecutionTask, computeGravityScore, getStaleStatus } from "@/services/taskExecutionService";
import { useToast } from "@/hooks/use-toast";

export function useExecutionQueue() {
  const [activeTasks, setActiveTasks] = useState<ExecutionTask[]>([]);
  const [backlogTasks, setBacklogTasks] = useState<ExecutionTask[]>([]);
  const [blockedTasks, setBlockedTasks] = useState<ExecutionTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchTasks = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setCurrentUserId(user.id);

    const { data, error } = await supabase
      .from('tasks')
      .select(`*, claims(claim_number, policyholder_name)`)
      .or(`assigned_to.eq.${user.id},assigned_to.is.null`)
      .in('status', ['active', 'backlog', 'blocked', 'pending'])
      .order('active_rank', { ascending: true, nullsFirst: false })
      .order('gravity_score', { ascending: false });

    if (error) {
      console.error('Error fetching execution queue:', error);
      return;
    }

    const mapped = (data || []).map((t: any) => ({
      ...t,
      claim_number: t.claims?.claim_number,
      policyholder_name: t.claims?.policyholder_name,
    }));

    setActiveTasks(mapped.filter((t: ExecutionTask) => t.status === 'active').sort((a: ExecutionTask, b: ExecutionTask) => (a.active_rank || 99) - (b.active_rank || 99)));
    setBacklogTasks(mapped.filter((t: ExecutionTask) => t.status === 'backlog' || t.status === 'pending').sort((a: ExecutionTask, b: ExecutionTask) => b.gravity_score - a.gravity_score));
    setBlockedTasks(mapped.filter((t: ExecutionTask) => t.status === 'blocked'));
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchTasks();

    const channel = supabase
      .channel('execution-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => fetchTasks())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchTasks]);

  // Nudge check for stale/paused tasks
  useEffect(() => {
    if (activeTasks.length === 0) return;

    const interval = setInterval(() => {
      for (const task of activeTasks) {
        const stale = getStaleStatus(task.last_touched_at);
        if (stale === 'stale') {
          toast({
            title: `⏰ Stale Task: ${task.title}`,
            description: "This task hasn't been touched in 4+ hours. Resume, reprioritize, or clear it.",
            duration: 10000,
          });
          break; // max 1 nudge at a time
        }
      }
    }, 15 * 60 * 1000); // check every 15 minutes

    return () => clearInterval(interval);
  }, [activeTasks, toast]);

  return {
    activeTasks,
    backlogTasks,
    blockedTasks,
    loading,
    currentUserId,
    refetch: fetchTasks,
  };
}
