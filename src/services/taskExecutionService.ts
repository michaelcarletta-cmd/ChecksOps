import { supabase } from "@/integrations/supabase/client";

export const MAX_ACTIVE_TASKS = 5;
export const MAX_IMMEDIATE_TASKS = 2;

export type TaskStatus = 'active' | 'backlog' | 'blocked' | 'completed' | 'dropped' | 'pending';
export type PriorityLevel = 'low' | 'medium' | 'high' | 'critical' | 'immediate';
export type NotificationStrategy = 'standard' | 'immediate_interrupt' | 'escalating' | 'deadline_sensitive';
export type TaskEventType =
  | 'created' | 'activated' | 'started' | 'paused' | 'resumed'
  | 'reprioritized' | 'moved_to_backlog' | 'blocked' | 'completed'
  | 'dropped' | 'nudged' | 'reviewed' | 'stale_flagged' | 'daily_reset'
  | 'marked_immediate' | 'snoozed' | 'escalation_sent' | 'acknowledged'
  | 'override_started' | 'downgraded_from_immediate' | 'deadline_breached';

export type AcknowledgeAction = 'start_now' | 'snooze' | 'backlog' | 'blocked' | 'complete' | 'downgrade';

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
  // Immediate task fields
  immediate_enabled: boolean;
  notification_channels: string[];
  notification_strategy: string;
  escalation_enabled: boolean;
  push_enabled: boolean;
  sms_enabled: boolean;
  email_enabled: boolean;
  snooze_allowed: boolean;
  max_snooze_count: number;
  snooze_count: number;
  snoozed_until: string | null;
  escalation_level: number;
  last_notified_at: string | null;
  next_notification_at: string | null;
  requires_acknowledgement: boolean;
  due_at: string | null;
  deadline_source: string | null;
  countdown_enabled: boolean;
  last_acknowledged_at: string | null;
  urgent_reason: string | null;
  // joined
  claim_number?: string;
  policyholder_name?: string;
}

const PRIORITY_SCORES: Record<string, number> = {
  immediate: 55,
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

  if (task.last_touched_at) {
    const hoursSinceTouched = (Date.now() - new Date(task.last_touched_at).getTime()) / (1000 * 60 * 60);
    if (hoursSinceTouched >= 72) score += 10;
  }

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

export function computeEscalationLevel(task: ExecutionTask): number {
  if (!task.immediate_enabled) return 0;
  const now = Date.now();
  const lastNotified = task.last_notified_at ? new Date(task.last_notified_at).getTime() : 0;
  const minutesSinceNotified = lastNotified ? (now - lastNotified) / (1000 * 60) : Infinity;

  // Snooze-based escalation
  if (task.snooze_count >= 2 || minutesSinceNotified >= 30) return 3;
  if (task.snooze_count >= 1 || minutesSinceNotified >= 15) return 2;
  return 1;
}

export function getImmediateTaskDueStatus(task: ExecutionTask): 'normal' | 'due_soon' | 'urgent' | 'overdue' {
  const dueAt = task.due_at;
  if (!dueAt) return 'normal';
  const now = Date.now();
  const dueTime = new Date(dueAt).getTime();
  const hoursUntilDue = (dueTime - now) / (1000 * 60 * 60);
  if (hoursUntilDue < 0) return 'overdue';
  if (hoursUntilDue <= 4) return 'urgent';
  if (hoursUntilDue <= 24) return 'due_soon';
  return 'normal';
}

export function isTaskSnoozed(task: ExecutionTask): boolean {
  if (!task.snoozed_until) return false;
  return new Date(task.snoozed_until).getTime() > Date.now();
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

export async function getImmediateTaskCount(userId: string): Promise<number> {
  const { count } = await supabase
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('assigned_to', userId)
    .eq('immediate_enabled', true)
    .not('status', 'in', '("completed","dropped")');
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
      immediate_enabled: false,
      escalation_level: 0,
      snoozed_until: null,
      next_notification_at: null,
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
      immediate_enabled: false,
      escalation_level: 0,
      snoozed_until: null,
      next_notification_at: null,
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
      immediate_enabled: false,
      escalation_level: 0,
      snoozed_until: null,
      next_notification_at: null,
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
      immediate_enabled: false,
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

// ======================== IMMEDIATE TASK LOGIC ========================

export async function markTaskImmediate(
  taskId: string,
  config?: {
    urgent_reason?: string;
    notification_channels?: string[];
    notification_strategy?: NotificationStrategy;
    due_at?: string;
    countdown_enabled?: boolean;
    sms_enabled?: boolean;
    email_enabled?: boolean;
  }
): Promise<{ success: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Not authenticated' };

  const immediateCount = await getImmediateTaskCount(user.id);
  if (immediateCount >= MAX_IMMEDIATE_TASKS) {
    return {
      success: false,
      error: `You already have ${MAX_IMMEDIATE_TASKS} immediate tasks open. Resolve or downgrade one before creating another.`,
    };
  }

  const dueAt = config?.due_at || null;
  const hoursUntilDue = dueAt ? (new Date(dueAt).getTime() - Date.now()) / (1000 * 60 * 60) : null;

  const { error } = await supabase
    .from('tasks')
    .update({
      priority_level: 'immediate',
      priority: 'high',
      immediate_enabled: true,
      notification_channels: config?.notification_channels || ['in_app', 'push'],
      notification_strategy: config?.notification_strategy || 'immediate_interrupt',
      escalation_enabled: true,
      snooze_allowed: true,
      max_snooze_count: 2,
      snooze_count: 0,
      snoozed_until: null,
      escalation_level: 0,
      requires_acknowledgement: true,
      urgent_reason: config?.urgent_reason || null,
      due_at: dueAt,
      countdown_enabled: config?.countdown_enabled ?? (hoursUntilDue !== null && hoursUntilDue <= 24),
      sms_enabled: config?.sms_enabled ?? false,
      email_enabled: config?.email_enabled ?? false,
      last_notified_at: new Date().toISOString(),
      next_notification_at: new Date().toISOString(),
      last_touched_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'marked_immediate', { reason: config?.urgent_reason });
  return { success: true };
}

export async function downgradeImmediateTask(
  taskId: string,
  newPriority: PriorityLevel = 'critical'
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('tasks')
    .update({
      priority_level: newPriority,
      priority: newPriority === 'critical' ? 'high' : newPriority,
      immediate_enabled: false,
      notification_strategy: 'standard',
      escalation_level: 0,
      snoozed_until: null,
      next_notification_at: null,
      last_touched_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'downgraded_from_immediate', { new_priority: newPriority });
  return { success: true };
}

export async function snoozeImmediateTask(
  taskId: string,
  minutes: number
): Promise<{ success: boolean; error?: string }> {
  // Fetch current task to validate
  const { data: task, error: fetchError } = await supabase
    .from('tasks')
    .select('snooze_allowed, snooze_count, max_snooze_count')
    .eq('id', taskId)
    .single();

  if (fetchError || !task) return { success: false, error: 'Task not found' };
  if (!task.snooze_allowed) return { success: false, error: 'Snooze is not allowed on this task' };
  if ((task.snooze_count || 0) >= (task.max_snooze_count || 2)) {
    return { success: false, error: 'Maximum snooze limit reached. You must take action on this task.' };
  }

  const snoozedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const nextNotification = snoozedUntil;

  const { error } = await supabase
    .from('tasks')
    .update({
      snoozed_until: snoozedUntil,
      snooze_count: (task.snooze_count || 0) + 1,
      next_notification_at: nextNotification,
      last_touched_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'snoozed', { minutes, snoozed_until: snoozedUntil });
  return { success: true };
}

export async function acknowledgeImmediateTask(
  taskId: string,
  action: AcknowledgeAction,
  extra?: { snooze_minutes?: number; block_reason?: string; downgrade_to?: PriorityLevel }
): Promise<{ success: boolean; error?: string }> {
  await logTaskEvent(taskId, 'acknowledged', { action });

  switch (action) {
    case 'start_now': {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { success: false, error: 'Not authenticated' };
      // Check active count and handle override
      const activeCount = await getActiveTaskCount(user.id);
      if (activeCount >= MAX_ACTIVE_TASKS) {
        // Still mark acknowledged and clear snooze, but don't auto-activate
        await supabase.from('tasks').update({
          last_acknowledged_at: new Date().toISOString(),
          snoozed_until: null,
          next_notification_at: null,
          last_touched_at: new Date().toISOString(),
        }).eq('id', taskId);
        return { success: false, error: 'QUEUE_FULL' };
      }
      // Activate it
      const result = await activateTask(taskId);
      if (result.success) {
        await supabase.from('tasks').update({
          last_acknowledged_at: new Date().toISOString(),
          snoozed_until: null,
          next_notification_at: null,
        }).eq('id', taskId);
        await logTaskEvent(taskId, 'override_started');
      }
      return result;
    }
    case 'snooze':
      return snoozeImmediateTask(taskId, extra?.snooze_minutes || 5);
    case 'backlog':
      return moveToBacklog(taskId);
    case 'blocked':
      return blockTask(taskId, extra?.block_reason || 'Blocked from immediate task modal');
    case 'complete':
      return completeTask(taskId);
    case 'downgrade':
      return downgradeImmediateTask(taskId, extra?.downgrade_to || 'critical');
    default:
      return { success: false, error: 'Unknown action' };
  }
}

export async function getImmediateTasks(userId: string): Promise<ExecutionTask[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, claims(claim_number, policyholder_name)')
    .eq('assigned_to', userId)
    .eq('immediate_enabled', true)
    .not('status', 'in', '("completed","dropped")')
    .order('escalation_level', { ascending: false })
    .order('due_at', { ascending: true, nullsFirst: false });

  if (error) return [];
  return (data || []).map((t: any) => ({
    ...t,
    claim_number: t.claims?.claim_number,
    policyholder_name: t.claims?.policyholder_name,
  }));
}

export async function logNotificationDelivery(input: {
  task_id: string;
  user_id: string;
  channel: string;
  notification_type: string;
  escalation_level: number;
  delivery_status: string;
  provider_response?: any;
}) {
  await supabase.from('notification_delivery_logs').insert({
    task_id: input.task_id,
    user_id: input.user_id,
    channel: input.channel,
    notification_type: input.notification_type,
    escalation_level: input.escalation_level,
    delivery_status: input.delivery_status,
    provider_response: input.provider_response || null,
  });
}

export async function overrideStartImmediate(
  immediateTaskId: string,
  pauseTaskId: string
): Promise<{ success: boolean; error?: string }> {
  // Pause the current task
  const pauseResult = await pauseTask(pauseTaskId);
  if (!pauseResult.success) return pauseResult;

  // Now activate the immediate task
  const activateResult = await activateTask(immediateTaskId);
  if (activateResult.success) {
    await supabase.from('tasks').update({
      last_acknowledged_at: new Date().toISOString(),
      snoozed_until: null,
      next_notification_at: null,
    }).eq('id', immediateTaskId);
    await logTaskEvent(immediateTaskId, 'override_started', { paused_task_id: pauseTaskId });
  }
  return activateResult;
}
