import { supabase } from "@/integrations/supabase/client";

// ======================== CONSTANTS ========================

export const MAX_ACTIVE_TASKS = 5;
export const MAX_IMMEDIATE_TASKS = 2;

/** Terminal states — tasks in these states are resolved and should not interrupt, escalate, or appear in active work. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'dropped'] as const;

/** Open statuses — tasks still requiring attention. */
export const OPEN_STATUSES: readonly TaskStatus[] = ['active', 'backlog', 'blocked', 'pending'] as const;

// ======================== TYPES ========================

export type TaskStatus = 'active' | 'backlog' | 'blocked' | 'completed' | 'dropped' | 'pending';
export type PriorityLevel = 'low' | 'medium' | 'high' | 'critical' | 'immediate';
export type NotificationStrategy = 'standard' | 'immediate_interrupt' | 'escalating' | 'deadline_sensitive';
export type DueStatus = 'normal' | 'due_soon' | 'urgent' | 'overdue';
export type AcknowledgeAction = 'start_now' | 'snooze' | 'backlog' | 'blocked' | 'complete' | 'downgrade';

export type TaskEventType =
  | 'created' | 'activated' | 'started' | 'paused' | 'resumed'
  | 'reprioritized' | 'moved_to_backlog' | 'blocked' | 'completed'
  | 'dropped' | 'nudged' | 'reviewed' | 'stale_flagged' | 'daily_reset'
  | 'marked_immediate' | 'snoozed' | 'escalation_sent' | 'acknowledged'
  | 'override_started' | 'downgraded_from_immediate' | 'deadline_breached';

export interface ExecutionTask {
  id: string;
  tenant_id?: string | null;
  title: string;
  description: string | null;
  claim_id: string | null;
  status: string;
  active_rank: number | null;
  priority_level: string;
  priority: string;
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
  // Joined fields
  claim_number?: string;
  policyholder_name?: string;
}

export interface ImmediateTaskTriggerInput {
  claim_id: string;
  title: string;
  description?: string;
  urgent_reason: string;
  event_type: string;
  severity: 'high' | 'critical';
  due_at?: string;
  deadline_source?: string;
  auto_immediate?: boolean;
  assigned_to?: string;
  dedupe_key?: string;
}

// ======================== STATUS HELPERS ========================

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

export function isActiveStatus(status: string): boolean {
  return status === 'active';
}

export function isBacklogLikeStatus(status: string): boolean {
  return status === 'backlog' || status === 'pending';
}

export function isBlockedStatus(status: string): boolean {
  return status === 'blocked';
}

/** Build PostgREST-safe filter string for terminal statuses. */
function terminalStatusFilter(): string {
  return `("${TERMINAL_STATUSES.join('","')}")`;
}

// ======================== PRIORITY HELPERS ========================

const PRIORITY_SCORES: Record<string, number> = {
  immediate: 55,
  critical: 40,
  high: 25,
  medium: 12,
  low: 4,
};

/**
 * Get canonical priority_level. Normalizes legacy `priority` field to `priority_level`.
 * priority_level is always the source of truth.
 */
export function getCanonicalPriority(task: { priority_level?: string; priority?: string }): PriorityLevel {
  const pl = task.priority_level;
  if (pl && pl in PRIORITY_SCORES) return pl as PriorityLevel;
  // Fallback to legacy priority only if priority_level is missing
  const p = task.priority;
  if (p && p in PRIORITY_SCORES) return p as PriorityLevel;
  return 'medium';
}

/** Map priority_level to the legacy priority field value for backward compat. */
function toLegacyPriority(priorityLevel: PriorityLevel): string {
  if (priorityLevel === 'critical' || priorityLevel === 'immediate') return 'high';
  return priorityLevel;
}

// ======================== GRAVITY ========================

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

// ======================== STALE / PAUSE ========================

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

// ======================== DUE STATUS ========================

export function getImmediateTaskDueStatus(task: Pick<ExecutionTask, 'due_at'>): DueStatus {
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

// ======================== SNOOZE ========================

export function isTaskSnoozed(task: Pick<ExecutionTask, 'snoozed_until'>): boolean {
  if (!task.snoozed_until) return false;
  return new Date(task.snoozed_until).getTime() > Date.now();
}

// ======================== ESCALATION ========================

export function computeEscalationLevel(task: ExecutionTask): number {
  if (!task.immediate_enabled) return 0;
  const now = Date.now();
  const lastNotified = task.last_notified_at ? new Date(task.last_notified_at).getTime() : 0;
  const minutesSinceNotified = lastNotified ? (now - lastNotified) / (1000 * 60) : Infinity;

  if (task.snooze_count >= 2 || minutesSinceNotified >= 30) return 3;
  if (task.snooze_count >= 1 || minutesSinceNotified >= 15) return 2;
  return 1;
}

// ======================== ACKNOWLEDGEMENT LOGIC ========================

/**
 * Determines whether an immediate task should currently require acknowledgement.
 * Prevents nagging immediately after start/acknowledgement.
 */
export function shouldRequireAcknowledgement(task: ExecutionTask): boolean {
  if (!task.immediate_enabled) return false;
  if (isTerminalStatus(task.status)) return false;
  if (!task.requires_acknowledgement) return false;

  // If snoozed into the future, don't interrupt
  if (isTaskSnoozed(task)) return false;

  const now = Date.now();

  // If acknowledged recently (within 2 minutes), don't re-interrupt
  if (task.last_acknowledged_at) {
    const ackAge = now - new Date(task.last_acknowledged_at).getTime();
    if (ackAge < 2 * 60 * 1000) return false;
  }

  // If task is active and was touched recently (within 5 minutes), don't nag
  if (task.status === 'active' && task.last_touched_at) {
    const touchAge = now - new Date(task.last_touched_at).getTime();
    if (touchAge < 5 * 60 * 1000) return false;
  }

  // Re-enable acknowledgement when:
  // - due window worsened
  const dueStatus = getImmediateTaskDueStatus(task);
  if (dueStatus === 'overdue' || dueStatus === 'urgent') return true;

  // - escalation criteria met (snooze expired, time elapsed)
  const computedEscalation = computeEscalationLevel(task);
  if (computedEscalation > task.escalation_level) return true;

  // - task became stale
  if (task.status === 'active' && task.last_touched_at) {
    const touchAge = now - new Date(task.last_touched_at).getTime();
    if (touchAge >= 15 * 60 * 1000) return true; // 15 min untouched for immediate tasks
  }

  // Default: if not recently acknowledged, require it
  if (!task.last_acknowledged_at) return true;
  const ackAge = now - new Date(task.last_acknowledged_at).getTime();
  return ackAge >= 10 * 60 * 1000; // 10 min cooldown after acknowledgement
}

/**
 * Select the most urgent task to interrupt with, from a list of candidates.
 * Deterministic: overdue first, then highest escalation, nearest due, most recent notification.
 */
export function selectInterruptTask(tasks: ExecutionTask[]): ExecutionTask | null {
  const candidates = tasks.filter(t => shouldRequireAcknowledgement(t));
  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    // Overdue first
    const aDue = getImmediateTaskDueStatus(a);
    const bDue = getImmediateTaskDueStatus(b);
    const dueRank: Record<string, number> = { overdue: 0, urgent: 1, due_soon: 2, normal: 3 };
    const dueDiff = (dueRank[aDue] ?? 3) - (dueRank[bDue] ?? 3);
    if (dueDiff !== 0) return dueDiff;

    // Highest escalation
    if (b.escalation_level !== a.escalation_level) return b.escalation_level - a.escalation_level;

    // Nearest due_at
    if (a.due_at && b.due_at) {
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    }
    if (a.due_at) return -1;
    if (b.due_at) return 1;

    // Most recent urgent_reason / notification as final tiebreaker
    const aNotif = a.last_notified_at ? new Date(a.last_notified_at).getTime() : 0;
    const bNotif = b.last_notified_at ? new Date(b.last_notified_at).getTime() : 0;
    return bNotif - aNotif;
  })[0];
}

// ======================== ACTIVITY LOGGING ========================

async function logTaskEvent(taskId: string, eventType: TaskEventType, metadata?: Record<string, any>) {
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from('task_activity_events').insert({
    task_id: taskId,
    user_id: user?.id || null,
    event_type: eventType,
    metadata_json: metadata || {},
  });
}

// ======================== NOTIFICATION DELIVERY LOGGING ========================

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

// ======================== COUNTS ========================

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
    .not('status', 'in', terminalStatusFilter());
  return count || 0;
}

// ======================== QUEUE NORMALIZATION ========================

/**
 * Normalize active_rank for all active tasks of a user.
 * Ensures no gaps, no duplicates, sequential from 1.
 */
export async function normalizeActiveQueue(userId: string): Promise<void> {
  const { data } = await supabase
    .from('tasks')
    .select('id, active_rank, immediate_enabled')
    .eq('assigned_to', userId)
    .eq('status', 'active')
    .order('active_rank', { ascending: true, nullsFirst: false });

  if (!data || data.length === 0) return;

  // Immediate tasks get top ranks
  const sorted = [...data].sort((a, b) => {
    if (a.immediate_enabled && !b.immediate_enabled) return -1;
    if (!a.immediate_enabled && b.immediate_enabled) return 1;
    return (a.active_rank || 99) - (b.active_rank || 99);
  });

  for (let i = 0; i < sorted.length; i++) {
    const expectedRank = i + 1;
    if (sorted[i].active_rank !== expectedRank) {
      await supabase
        .from('tasks')
        .update({ active_rank: expectedRank })
        .eq('id', sorted[i].id);
    }
  }
}

// ======================== CORE TASK ACTIONS ========================

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
  await normalizeActiveQueue(user.id);
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

function clearImmediateFields() {
  return {
    immediate_enabled: false,
    escalation_level: 0,
    snoozed_until: null,
    next_notification_at: null,
  };
}

export async function completeTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { data: task } = await supabase.from('tasks').select('assigned_to').eq('id', taskId).single();

  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      active_rank: null,
      last_touched_at: new Date().toISOString(),
      paused_at: null,
      ...clearImmediateFields(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };

  // Post-mutation verification: re-read and warn if stale
  const { data: verify } = await supabase.from('tasks').select('status').eq('id', taskId).single();
  if (verify && verify.status !== 'completed') {
    console.error(`[completeTask] Stale read after completion — task ${taskId} still has status "${verify.status}"`);
  }

  await logTaskEvent(taskId, 'completed');
  if (task?.assigned_to) await normalizeActiveQueue(task.assigned_to);
  return { success: true };
}

export async function blockTask(taskId: string, reason: string): Promise<{ success: boolean; error?: string }> {
  const { data: task } = await supabase.from('tasks').select('assigned_to').eq('id', taskId).single();

  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'blocked',
      blocked_reason: reason,
      active_rank: null,
      last_touched_at: new Date().toISOString(),
      paused_at: null,
      ...clearImmediateFields(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'blocked', { reason });
  if (task?.assigned_to) await normalizeActiveQueue(task.assigned_to);
  return { success: true };
}

export async function moveToBacklog(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { data: task } = await supabase.from('tasks').select('assigned_to').eq('id', taskId).single();

  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'backlog',
      active_rank: null,
      last_touched_at: new Date().toISOString(),
      paused_at: null,
      ...clearImmediateFields(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'moved_to_backlog');
  if (task?.assigned_to) await normalizeActiveQueue(task.assigned_to);
  return { success: true };
}

export async function dropTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { data: task } = await supabase.from('tasks').select('assigned_to').eq('id', taskId).single();

  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'dropped',
      active_rank: null,
      last_touched_at: new Date().toISOString(),
      paused_at: null,
      ...clearImmediateFields(),
    })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };
  await logTaskEvent(taskId, 'dropped');
  if (task?.assigned_to) await normalizeActiveQueue(task.assigned_to);
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

// ======================== DAILY RESET ========================

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
      priority: toLegacyPriority(newPriority),
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

  const { error } = await supabase
    .from('tasks')
    .update({
      snoozed_until: snoozedUntil,
      snooze_count: (task.snooze_count || 0) + 1,
      next_notification_at: snoozedUntil,
      last_touched_at: new Date().toISOString(),
      last_acknowledged_at: new Date().toISOString(),
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
      const activeCount = await getActiveTaskCount(user.id);
      if (activeCount >= MAX_ACTIVE_TASKS) {
        await supabase.from('tasks').update({
          last_acknowledged_at: new Date().toISOString(),
          snoozed_until: null,
          next_notification_at: null,
          last_touched_at: new Date().toISOString(),
        }).eq('id', taskId);
        return { success: false, error: 'QUEUE_FULL' };
      }
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

// ======================== IMMEDIATE TASK FETCHING ========================

export async function getImmediateTasks(userId: string): Promise<ExecutionTask[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, claims(claim_number, policyholder_name)')
    .eq('assigned_to', userId)
    .eq('immediate_enabled', true)
    .not('status', 'in', terminalStatusFilter())
    .order('escalation_level', { ascending: false })
    .order('due_at', { ascending: true, nullsFirst: false });

  if (error) return [];
  return (data || []).map((t: any) => ({
    ...t,
    claim_number: t.claims?.claim_number,
    policyholder_name: t.claims?.policyholder_name,
  }));
}

/** Get immediate tasks linked to a specific claim. */
export async function getClaimImmediateTasks(claimId: string): Promise<ExecutionTask[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, claims(claim_number, policyholder_name)')
    .eq('claim_id', claimId)
    .eq('immediate_enabled', true)
    .not('status', 'in', terminalStatusFilter())
    .order('escalation_level', { ascending: false });

  if (error) return [];
  return (data || []).map((t: any) => ({
    ...t,
    claim_number: t.claims?.claim_number,
    policyholder_name: t.claims?.policyholder_name,
  }));
}

// ======================== QUEUE OVERRIDE ========================

export async function overrideStartImmediate(
  immediateTaskId: string,
  pauseTaskId: string
): Promise<{ success: boolean; error?: string }> {
  const pauseResult = await pauseTask(pauseTaskId);
  if (!pauseResult.success) return pauseResult;

  // Move the paused task to backlog to free up a slot
  await moveToBacklog(pauseTaskId);

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

// ======================== TRIGGER-BASED IMMEDIATE TASK CREATION ========================

export async function createImmediateTaskFromTrigger(
  input: ImmediateTaskTriggerInput
): Promise<{ success: boolean; error?: string; taskId?: string }> {
  // Dedupe: check for existing open urgent task for the same claim + event_type
  const dedupeKey = input.dedupe_key || `${input.claim_id}:${input.event_type}`;
  const { data: existing } = await supabase
    .from('tasks')
    .select('id')
    .eq('claim_id', input.claim_id)
    .eq('immediate_enabled', true)
    .not('status', 'in', terminalStatusFilter())
    .limit(10);

  if (existing && existing.length > 0) {
    // Check if any existing task has the same dedupe key in urgent_reason prefix
    const hasDuplicate = existing.length > 0;
    // If there's already an open immediate task on this claim, don't stack another
    // unless it's a different event type (check via urgent_reason pattern match)
    const { data: existingWithReason } = await supabase
      .from('tasks')
      .select('id, urgent_reason')
      .eq('claim_id', input.claim_id)
      .eq('immediate_enabled', true)
      .not('status', 'in', terminalStatusFilter());

    const isDuplicate = (existingWithReason || []).some(t => 
      t.urgent_reason?.includes(`[${input.event_type}]`)
    );
    if (isDuplicate) {
      return { success: false, error: 'Duplicate urgent task already exists for this claim and event type' };
    }
  }

  // Check immediate count for the assignee
  if (input.assigned_to) {
    const count = await getImmediateTaskCount(input.assigned_to);
    if (count >= MAX_IMMEDIATE_TASKS) {
      // Downgrade to critical instead of failing silently
      const dueAt = input.due_at || null;
      const { data: inserted, error } = await supabase
        .from('tasks')
        .insert({
          claim_id: input.claim_id,
          title: input.title,
          description: input.description || null,
          urgent_reason: `[${input.event_type}] ${input.urgent_reason}`,
          priority_level: 'critical',
          priority: 'high',
          status: 'backlog',
          assigned_to: input.assigned_to,
          immediate_enabled: false,
          due_at: dueAt,
          deadline_source: input.deadline_source || null,
          countdown_enabled: dueAt ? true : false,
        })
        .select('id')
        .single();

      if (error) return { success: false, error: error.message };
      await logTaskEvent(inserted.id, 'created', { trigger: input.event_type, downgraded_from_immediate: true });
      return { success: true, taskId: inserted.id };
    }
  }

  const dueAt = input.due_at || null;
  const hoursUntilDue = dueAt ? (new Date(dueAt).getTime() - Date.now()) / (1000 * 60 * 60) : null;

  const { data: inserted, error } = await supabase
    .from('tasks')
    .insert({
      claim_id: input.claim_id,
      title: input.title,
      description: input.description || null,
      urgent_reason: `[${input.event_type}] ${input.urgent_reason}`,
      priority_level: input.auto_immediate ? 'immediate' : 'critical',
      priority: 'high',
      status: input.auto_immediate ? 'backlog' : 'backlog',
      assigned_to: input.assigned_to || null,
      immediate_enabled: input.auto_immediate ?? false,
      notification_channels: ['in_app', 'push'],
      notification_strategy: 'immediate_interrupt',
      escalation_enabled: true,
      requires_acknowledgement: true,
      snooze_allowed: true,
      max_snooze_count: 2,
      due_at: dueAt,
      deadline_source: input.deadline_source || null,
      countdown_enabled: hoursUntilDue !== null && hoursUntilDue <= 24,
      sms_enabled: hoursUntilDue !== null && hoursUntilDue <= 4,
      last_notified_at: input.auto_immediate ? new Date().toISOString() : null,
      next_notification_at: input.auto_immediate ? new Date().toISOString() : null,
    })
    .select('id')
    .single();

  if (error) return { success: false, error: error.message };
  await logTaskEvent(inserted.id, 'created', { trigger: input.event_type, severity: input.severity });
  if (input.auto_immediate) {
    await logTaskEvent(inserted.id, 'marked_immediate', { trigger: input.event_type });
  }
  return { success: true, taskId: inserted.id };
}

/**
 * Evaluate whether a Darwin claim event should trigger an urgent task.
 * Returns trigger input if it should, null otherwise.
 */
export function evaluateUrgentTaskTrigger(event: {
  type: string;
  claim_id: string;
  severity?: string;
  due_at?: string;
  description?: string;
  assigned_to?: string;
}): ImmediateTaskTriggerInput | null {
  const titleMap: Record<string, string> = {
    carrier_denial: 'Review carrier denial and determine response',
    carrier_reservation: 'Review carrier reservation of rights',
    proof_of_loss_deadline: 'Proof of loss due — prepare and submit',
    inspection_today: 'Inspection today — prepare file and confirm scope',
    document_deadline: 'Document deadline approaching — review and submit',
    client_complaint: 'Urgent client escalation requires response',
    payment_blocked: 'Payment blocked — resolve endorsement or signature',
    endorsement_overdue: 'Outstanding endorsement is blocking payment release',
    war_room_risk: 'War Room risk detected — review contradictions',
    payment_failed: 'Payment failed or returned — investigate',
  };

  const title = titleMap[event.type];
  if (!title) return null;

  const hoursUntilDue = event.due_at
    ? (new Date(event.due_at).getTime() - Date.now()) / (1000 * 60 * 60)
    : null;

  const autoImmediate =
    (hoursUntilDue !== null && hoursUntilDue <= 24) ||
    event.type === 'inspection_today' ||
    event.type === 'payment_blocked' ||
    event.type === 'client_complaint' ||
    event.severity === 'critical';

  return {
    claim_id: event.claim_id,
    title,
    description: event.description,
    urgent_reason: event.description || title,
    event_type: event.type,
    severity: (event.severity === 'critical' ? 'critical' : 'high') as 'high' | 'critical',
    due_at: event.due_at,
    auto_immediate: autoImmediate,
    assigned_to: event.assigned_to,
    dedupe_key: `${event.claim_id}:${event.type}`,
  };
}

// ======================== NOTIFICATION CHANNEL RESOLUTION ========================

export interface UserNotificationCapability {
  push_available: boolean;
  sms_available: boolean;
  email_available: boolean;
  phone?: string;
  email?: string;
}

/**
 * Resolve which notification channels should actually be used for a task,
 * given the task's config and the user's actual capabilities.
 */
export function resolveNotificationChannels(
  task: Pick<ExecutionTask, 'notification_channels' | 'push_enabled' | 'sms_enabled' | 'email_enabled'>,
  userCapability: UserNotificationCapability
): { channels: string[]; skipped: { channel: string; reason: string }[] } {
  const channels: string[] = [];
  const skipped: { channel: string; reason: string }[] = [];

  // in_app is always available
  if (task.notification_channels.includes('in_app')) {
    channels.push('in_app');
  } else {
    channels.push('in_app'); // Always include in_app as baseline
  }

  // Push
  if (task.push_enabled && task.notification_channels.includes('push')) {
    if (userCapability.push_available) {
      channels.push('push');
    } else {
      skipped.push({ channel: 'push', reason: 'No push token/device registered' });
      // Fallback: try email if push fails
      if (task.email_enabled && userCapability.email_available && !channels.includes('email')) {
        channels.push('email');
      }
    }
  }

  // SMS
  if (task.sms_enabled && task.notification_channels.includes('sms')) {
    if (userCapability.sms_available && userCapability.phone) {
      channels.push('sms');
    } else {
      skipped.push({ channel: 'sms', reason: userCapability.phone ? 'SMS not available' : 'No phone number' });
    }
  }

  // Email
  if (task.email_enabled && task.notification_channels.includes('email')) {
    if (userCapability.email_available && userCapability.email) {
      if (!channels.includes('email')) channels.push('email');
    } else {
      skipped.push({ channel: 'email', reason: userCapability.email ? 'Email not available' : 'No email address' });
    }
  }

  return { channels, skipped };
}

// ======================== NOTIFICATION CHANNEL ADAPTERS ========================

async function sendInAppTaskNotification(task: ExecutionTask, escalationLevel: number): Promise<{ success: boolean }> {
  // In-app notifications are handled by the realtime subscription + polling in useImmediateTasks.
  // We just need to ensure the task fields are set correctly so the UI picks it up.
  return { success: true };
}

async function sendPushTaskNotification(task: ExecutionTask, escalationLevel: number): Promise<{ success: boolean; error?: string }> {
  // Push notification delivery requires a push provider (e.g., FCM, APNs).
  // Log as skipped until a push provider is configured.
  return { success: false, error: 'Push provider not configured' };
}

async function sendSmsTaskNotification(task: ExecutionTask, escalationLevel: number, phone: string): Promise<{ success: boolean; error?: string }> {
  // SMS delivery requires Telnyx or similar. Attempt via existing infrastructure if available.
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.functions.invoke('send-sms-notification', {
      body: {
        to: phone,
        message: `URGENT: ${task.title}${task.urgent_reason ? ` — ${task.urgent_reason}` : ''}`,
        task_id: task.id,
      }
    });
    return { success: true };
  } catch {
    return { success: false, error: 'SMS delivery failed' };
  }
}

async function sendEmailTaskNotification(task: ExecutionTask, escalationLevel: number, email: string): Promise<{ success: boolean; error?: string }> {
  // Email delivery via existing transactional email infrastructure
  try {
    await supabase.functions.invoke('send-transactional-email', {
      body: {
        templateName: 'urgent-task-notification',
        recipientEmail: email,
        idempotencyKey: `urgent-task-${task.id}-${escalationLevel}-${Date.now()}`,
        templateData: {
          title: task.title,
          urgent_reason: task.urgent_reason || '',
          escalation_level: escalationLevel,
          claim_number: task.claim_number || '',
        },
      },
    });
    return { success: true };
  } catch {
    return { success: false, error: 'Email delivery failed' };
  }
}

// ======================== NOTIFICATION PROCESSING ========================

/**
 * Process immediate task notifications for a user.
 * Finds unresolved immediate tasks needing notification and sends via resolved channels.
 */
export async function processImmediateTaskNotifications(userId: string): Promise<{
  processed: number;
  sent: number;
  skipped: number;
  errors: number;
}> {
  const result = { processed: 0, sent: 0, skipped: 0, errors: 0 };
  const now = new Date();

  const tasks = await getImmediateTasks(userId);
  const unresolvedTasks = tasks.filter(t => {
    if (isTerminalStatus(t.status)) return false;
    if (isTaskSnoozed(t)) return false;
    if (!t.next_notification_at) return false;
    return new Date(t.next_notification_at).getTime() <= now.getTime();
  });

  // Fetch user profile for notification capabilities
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, phone, email')
    .eq('id', userId)
    .single();

  const userCapability: UserNotificationCapability = {
    push_available: false, // Until push provider is configured
    sms_available: !!profile?.phone,
    email_available: !!profile?.email,
    phone: profile?.phone || undefined,
    email: profile?.email || undefined,
  };

  for (const task of unresolvedTasks) {
    result.processed++;
    const newEscalation = computeEscalationLevel(task);
    const { channels, skipped: skippedChannels } = resolveNotificationChannels(task, userCapability);

    for (const ch of channels) {
      let deliveryResult: { success: boolean; error?: string } = { success: false };

      switch (ch) {
        case 'in_app':
          deliveryResult = await sendInAppTaskNotification(task, newEscalation);
          break;
        case 'push':
          deliveryResult = await sendPushTaskNotification(task, newEscalation);
          break;
        case 'sms':
          deliveryResult = await sendSmsTaskNotification(task, newEscalation, userCapability.phone!);
          break;
        case 'email':
          deliveryResult = await sendEmailTaskNotification(task, newEscalation, userCapability.email!);
          break;
      }

      const status = deliveryResult.success ? 'sent' : 'failed';
      if (deliveryResult.success) result.sent++;
      else result.errors++;

      await logNotificationDelivery({
        task_id: task.id,
        user_id: userId,
        channel: ch,
        notification_type: task.notification_strategy,
        escalation_level: newEscalation,
        delivery_status: status,
        provider_response: deliveryResult.error ? { error: deliveryResult.error } : null,
      });
    }

    // Log skipped channels
    for (const skip of skippedChannels) {
      result.skipped++;
      await logNotificationDelivery({
        task_id: task.id,
        user_id: userId,
        channel: skip.channel,
        notification_type: task.notification_strategy,
        escalation_level: newEscalation,
        delivery_status: 'skipped_fallback',
        provider_response: { reason: skip.reason },
      });
    }

    // Compute next notification time based on escalation
    const nextMinutes = newEscalation >= 3 ? 10 : newEscalation >= 2 ? 15 : 20;
    const nextNotificationAt = new Date(now.getTime() + nextMinutes * 60 * 1000).toISOString();

    await supabase.from('tasks').update({
      last_notified_at: now.toISOString(),
      next_notification_at: nextNotificationAt,
      escalation_level: newEscalation,
    }).eq('id', task.id);

    if (newEscalation > task.escalation_level) {
      await logTaskEvent(task.id, 'escalation_sent', {
        from_level: task.escalation_level,
        to_level: newEscalation,
        channels,
      });
    }

    // Deadline breach detection (log once)
    const dueStatus = getImmediateTaskDueStatus(task);
    if (dueStatus === 'overdue' && task.escalation_level < 3) {
      await logTaskEvent(task.id, 'deadline_breached', {
        due_at: task.due_at,
        detected_at: now.toISOString(),
      });
    }
  }

  return result;
}
