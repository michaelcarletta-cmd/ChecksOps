import { supabase } from "@/integrations/supabase/client";

export const MAX_ACTIVE_TASKS = 5;

export type TaskStatus = 'active' | 'backlog' | 'blocked' | 'completed' | 'dropped' | 'pending';
export type PriorityLevel = 'low' | 'medium' | 'high' | 'critical';
export type TaskEventType = 'created' | 'activated' | 'started' | 'paused' | 'resumed' | 'reprioritized' | 'moved_to_backlog' | 'blocked' | 'completed' | 'dropped' | 'nudged' | 'reviewed' | 'stale_flagged' | 'daily_reset';

export interface ExecutionTask {
  id: string;
  title: string;
  description: string | null;
  claim_id: string | null;
  status: string;
  active_rank: number | null;
  priority_level: string;
  urgency_score: number;
  impact_score: number;
  age_score: number;
  gravity_score: number;
  started_at: string | null;
  last_touched_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  blocked_reason: string | null;
  done_definition: string | null;
  due_date: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  priority: string;
  // joined
  claim_number?: string;
  policyholder_name?: string;
}

const PRIORITY_SCORES: Record<string, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 4,
};

export function computeGravityScore(task: {
  priority_level: string;
  urgency_score: number;
  impact_score: number;
  age_score: number;
  last_touched_at: string | null;
  created_at: string;
  due_date?: string | null;
}): number {
  let score = PRIORITY_SCORES[task.priority_level] || 12;
  score += Math.min(task.urgency_score || 0, 25);
  score += Math.min(task.impact_score || 0, 20);
  score += Math.min(task.age_score || 0, 15);

  // Stale bonus: untouched 3+ days
  if (task.last_touched_at) {
    const hoursSinceTouched = (Date.now() - new Date(task.last_touched_at).getTime()) / (1000 * 60 * 60);
    if (hoursSinceTouched >= 72) score += 10;
  }

  // Time-sensitive claim bonus
  if (task.due_date) {
    const daysUntilDue = (new Date(task.due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilDue <= 2 && daysUntilDue > 0) score += 15;
  }

  return Math.min(score, 100);
}

export function getStaleStatus(lastTouchedAt: string | null): 'fresh' | 'stale' | 'requires_decision' {
  if (!lastTouchedAt) return 'fresh';
  const hours = (Date.now() - new Date(lastTouchedAt).getTime()) / (1000 * 60 * 60);
  if (hours >= 48) return 'requires_decision';
  if (hours >= 4) return 'stale';
  return 'fresh';
}

export function getPausedMinutes(pausedAt: string | null): number {
  if (!pausedAt) return 0;
  return (Date.now() - new Date(pausedAt).getTime()) / (1000 * 60);
}

async function logTaskEvent(taskId: string, eventType: TaskEventType, metadata?: Record<string, any>) {
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from('task_activity_events').insert({
    task_id: taskId,
    user_id: user?.id || null,
    event_type: eventType,
    metadata_json: metadata || {},
  });
}

export async function getActiveTaskCount(userId: string): Promise<number> {
  const { count } = await supabase
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('assigned_to', userId)
    .eq('status', 'active');
  return count || 0;
}

export async function activateTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Not authenticated' };

  const activeCount = await getActiveTaskCount(user.id);
  if (activeCount >= MAX_ACTIVE_TASKS) {
    return { success: false, error: `Maximum ${MAX_ACTIVE_TASKS} active tasks allowed. Complete or move a task to backlog first.` };
  }

  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'active',
      active_rank: activeCount + 1,
      started_at: new Date().toISOString(),
      last_touched_at: new Date().toISOString(),
      paused_at: null,
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'activated');
  return { success: true };
}

export async function pauseTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('tasks')
    .update({
      paused_at: new Date().toISOString(),
      last_touched_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'paused');
  return { success: true };
}

export async function resumeTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('tasks')
    .update({
      paused_at: null,
      last_touched_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'resumed');
  return { success: true };
}

export async function completeTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      active_rank: null,
      last_touched_at: new Date().toISOString(),
      paused_at: null,
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'completed');
  return { success: true };
}

export async function blockTask(taskId: string, reason: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'blocked',
      blocked_reason: reason,
      active_rank: null,
      last_touched_at: new Date().toISOString(),
      paused_at: null,
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'blocked', { reason });
  return { success: true };
}

export async function moveToBacklog(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'backlog',
      active_rank: null,
      last_touched_at: new Date().toISOString(),
      paused_at: null,
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'moved_to_backlog');
  return { success: true };
}

export async function dropTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'dropped',
      active_rank: null,
      last_touched_at: new Date().toISOString(),
      paused_at: null,
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'dropped');
  return { success: true };
}

export async function touchTask(taskId: string): Promise<void> {
  await supabase
    .from('tasks')
    .update({ last_touched_at: new Date().toISOString() })
    .eq('id', taskId);
}

export async function reorderActiveTasks(taskIds: string[]): Promise<{ success: boolean; error?: string }> {
  for (let i = 0; i < taskIds.length; i++) {
    const { error } = await supabase
      .from('tasks')
      .update({ active_rank: i + 1 })
      .eq('id', taskIds[i]);
    if (error) return { success: false, error: error.message };
  }
  await logTaskEvent(taskIds[0], 'reprioritized', { new_order: taskIds });
  return { success: true };
}

export async function updateTaskGravity(taskId: string, task: Parameters<typeof computeGravityScore>[0]): Promise<void> {
  const gravity = computeGravityScore(task);
  await supabase
    .from('tasks')
    .update({ gravity_score: gravity })
    .eq('id', taskId);
}

export async function getTaskActivityEvents(taskId: string) {
  const { data, error } = await supabase
    .from('task_activity_events')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

export async function checkDailyResetNeeded(): Promise<boolean> {
  const lastReset = localStorage.getItem('task_daily_reset_date');
  const today = new Date().toISOString().split('T')[0];
  return lastReset !== today;
}

export function markDailyResetDone(): void {
  const today = new Date().toISOString().split('T')[0];
  localStorage.setItem('task_daily_reset_date', today);
}
