import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ExecutionTask, getStaleStatus, isActiveStatus, isBacklogLikeStatus, isBlockedStatus } from "@/services/taskExecutionService";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export function useExecutionQueue() {
  const [activeTasks, setActiveTasks] = useState<ExecutionTask[]>([]);
  const [backlogTasks, setBacklogTasks] = useState<ExecutionTask[]>([]);
  const [blockedTasks, setBlockedTasks] = useState<ExecutionTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fetchIdRef = useRef(0);

  const fetchTasks = useCallback(async (isRefetch = false) => {
    const fetchId = ++fetchIdRef.current;

    // Invalidate all stale task caches
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
    queryClient.invalidateQueries({ queryKey: ["completed-tasks"] });

    if (isRefetch) setRefetching(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setCurrentUserId(null);
      setActiveTasks([]);
      setBacklogTasks([]);
      setBlockedTasks([]);
      setLoading(false);
      setRefetching(false);
      return;
    }
    setCurrentUserId(user.id);

    const { data, error } = await supabase
      .from('tasks')
      .select(`*, claims(claim_number, policyholder_name)`)
      .or(`assigned_to.eq.${user.id},assigned_to.is.null`)
      .in('status', ['active', 'backlog', 'blocked', 'pending'])
      .order('active_rank', { ascending: true, nullsFirst: false })
      .order('gravity_score', { ascending: false });

    // Stale response guard
    if (fetchId !== fetchIdRef.current) return;

    if (error) {
      console.error('Error fetching execution queue:', error);
      setLoading(false);
      setRefetching(false);
      return;
    }

    const now = Date.now();
    const mapped = (data || []).map((t: any) => ({
      ...t,
      claim_number: t.claims?.claim_number,
      policyholder_name: t.claims?.policyholder_name,
      // Recalculate past-due based on current time vs due_date
      _isPastDue: t.due_date ? new Date(t.due_date).getTime() < now : false,
    }));

    const nextActiveTasks = mapped
      .filter((t: ExecutionTask) => isActiveStatus(t.status))
      .sort((a: ExecutionTask, b: ExecutionTask) => (a.active_rank || 99) - (b.active_rank || 99));
    const nextBacklogTasks = mapped
      .filter((t: ExecutionTask) => isBacklogLikeStatus(t.status))
      .sort((a: ExecutionTask, b: ExecutionTask) => b.gravity_score - a.gravity_score);
    const nextBlockedTasks = mapped.filter((t: ExecutionTask) => isBlockedStatus(t.status));

    if (import.meta.env.DEV) {
      const byStatus = mapped.reduce<Record<string, number>>((acc, task) => {
        acc[task.status] = (acc[task.status] || 0) + 1;
        return acc;
      }, {});
      const pastDueCount = mapped.filter((t: any) => t._isPastDue).length;
      console.debug("[useExecutionQueue] task counts", {
        fetched: mapped.length,
        byStatus,
        active: nextActiveTasks.length,
        backlog: nextBacklogTasks.length,
        blocked: nextBlockedTasks.length,
        pastDue: pastDueCount,
        snoozedImmediate: mapped.filter((task: ExecutionTask) => !!task.snoozed_until && new Date(task.snoozed_until).getTime() > Date.now()).length,
      });
    }

    setActiveTasks(nextActiveTasks);
    setBacklogTasks(nextBacklogTasks);
    setBlockedTasks(nextBlockedTasks);
    setLoading(false);
    setRefetching(false);
  }, [queryClient]);

  useEffect(() => {
    fetchTasks();

    const channel = supabase
      .channel('execution-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => fetchTasks(true))
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
    refetching,
    currentUserId,
    refetch: () => fetchTasks(true),
  };
}
