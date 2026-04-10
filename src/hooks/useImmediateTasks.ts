import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  ExecutionTask,
  getImmediateTasks,
  isTaskSnoozed,
  getImmediateTaskDueStatus,
  selectInterruptTask,
  isTerminalStatus,
} from "@/services/taskExecutionService";

export function useImmediateTasks() {
  const [immediateTasks, setImmediateTasks] = useState<ExecutionTask[]>([]);
  const [pendingInterrupt, setPendingInterrupt] = useState<ExecutionTask | null>(null);
  const [loading, setLoading] = useState(true);

  // Dedupe guard: track the last interrupt task ID and timestamp to prevent jitter
  const lastInterruptRef = useRef<{ taskId: string; timestamp: number } | null>(null);
  const isModalOpenRef = useRef(false);

  const fetchImmediateTasks = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const tasks = await getImmediateTasks(user.id);
    setImmediateTasks(tasks);
    setLoading(false);

    // Don't update interrupt if modal is already showing (prevents jitter)
    if (isModalOpenRef.current) return;

    // Use deterministic selection for the most urgent task
    const nextInterrupt = selectInterruptTask(tasks);

    if (nextInterrupt) {
      const now = Date.now();
      const last = lastInterruptRef.current;

      // Dedupe: don't re-show the same task within 30 seconds unless
      // escalation increased or due status worsened
      if (last && last.taskId === nextInterrupt.id) {
        const timeSinceLastShow = now - last.timestamp;
        if (timeSinceLastShow < 30 * 1000) {
          return; // Skip - too soon to re-interrupt with same task
        }
      }

      lastInterruptRef.current = { taskId: nextInterrupt.id, timestamp: now };
      setPendingInterrupt(nextInterrupt);
    } else {
      setPendingInterrupt(null);
    }
  }, []);

  useEffect(() => {
    fetchImmediateTasks();

    // Poll every 30 seconds for snooze expiry / escalation
    const interval = setInterval(fetchImmediateTasks, 30 * 1000);

    // Listen for realtime changes
    const channel = supabase
      .channel('immediate-tasks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: 'immediate_enabled=eq.true' }, () => {
        // Debounce realtime events to avoid duplicate with polling
        setTimeout(fetchImmediateTasks, 500);
      })
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [fetchImmediateTasks]);

  const activeTasks = immediateTasks.filter(t => !isTaskSnoozed(t) && t.status !== 'blocked');
  const snoozedTasks = immediateTasks.filter(t => isTaskSnoozed(t));
  const overdueTasks = immediateTasks.filter(t => getImmediateTaskDueStatus(t) === 'overdue');

  const clearInterrupt = useCallback(() => {
    isModalOpenRef.current = false;
    setPendingInterrupt(null);
  }, []);

  const markModalOpen = useCallback(() => {
    isModalOpenRef.current = true;
  }, []);

  return {
    immediateTasks,
    activeTasks,
    snoozedTasks,
    overdueTasks,
    pendingInterrupt,
    loading,
    refetch: fetchImmediateTasks,
    clearInterrupt,
    markModalOpen,
    hasUrgentWork: immediateTasks.length > 0,
  };
}
