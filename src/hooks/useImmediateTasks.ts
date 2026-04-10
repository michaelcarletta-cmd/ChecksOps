import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  ExecutionTask,
  getImmediateTasks,
  isTaskSnoozed,
  getImmediateTaskDueStatus,
} from "@/services/taskExecutionService";

export function useImmediateTasks() {
  const [immediateTasks, setImmediateTasks] = useState<ExecutionTask[]>([]);
  const [pendingInterrupt, setPendingInterrupt] = useState<ExecutionTask | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchImmediateTasks = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const tasks = await getImmediateTasks(user.id);
    setImmediateTasks(tasks);
    setLoading(false);

    // Determine which task needs an interrupt modal
    const needsInterrupt = tasks.find((t) => {
      if (t.status === 'completed' || t.status === 'dropped') return false;
      if (isTaskSnoozed(t)) return false;
      if (t.last_acknowledged_at) {
        const ackAge = Date.now() - new Date(t.last_acknowledged_at).getTime();
        // Don't re-interrupt within 2 minutes of last acknowledgement
        if (ackAge < 2 * 60 * 1000) return false;
      }
      return t.requires_acknowledgement;
    });

    setPendingInterrupt(needsInterrupt || null);
  }, []);

  useEffect(() => {
    fetchImmediateTasks();

    // Poll every 30 seconds for snooze expiry / escalation
    const interval = setInterval(fetchImmediateTasks, 30 * 1000);

    // Listen for realtime changes
    const channel = supabase
      .channel('immediate-tasks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: 'immediate_enabled=eq.true' }, () => fetchImmediateTasks())
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [fetchImmediateTasks]);

  const activeTasks = immediateTasks.filter(t => !isTaskSnoozed(t) && t.status !== 'blocked');
  const snoozedTasks = immediateTasks.filter(t => isTaskSnoozed(t));
  const overdueTasks = immediateTasks.filter(t => getImmediateTaskDueStatus(t) === 'overdue');

  return {
    immediateTasks,
    activeTasks: activeTasks,
    snoozedTasks,
    overdueTasks,
    pendingInterrupt,
    loading,
    refetch: fetchImmediateTasks,
    clearInterrupt: () => setPendingInterrupt(null),
    hasUrgentWork: immediateTasks.length > 0,
  };
}
