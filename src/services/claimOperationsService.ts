/**
 * Claim Operations Service
 * 
 * Centralized scoring, follow-up status, and next-best-action logic
 * for the Claims Control Board. All thresholds are constants for easy tuning.
 */

// ======================== TUNING CONSTANTS ========================

/** Days thresholds for follow-up status */
export const FOLLOWUP_ON_TRACK_DAYS = 5;
export const FOLLOWUP_DUE_DAYS = 7;
export const FOLLOWUP_OVERDUE_DAYS = 14;
export const FOLLOWUP_ESCALATION_DAYS = 21;

/** Pressure score weights (sum to ~100 at max) */
export const PRESSURE_WEIGHTS = {
  financialExposure: 25,    // high RCV / claim value
  carrierDelay: 20,         // days without carrier response
  contradiction: 15,        // contradictions in file
  evidenceReadiness: 15,    // documents / reports uploaded
  escalationReadiness: 15,  // litigation posture, DOBI filings
  staleInactivity: 10,      // no activity for extended period
} as const;

/** Lifecycle stages */
export const LIFECYCLE_STAGES = [
  'new',
  'inspection_pending',
  'estimate_in_progress',
  'supplement_submitted',
  'negotiation',
  'demand_sent',
  'appraisal',
  'litigation',
  'settled',
  'closed',
] as const;

export type LifecycleStage = typeof LIFECYCLE_STAGES[number];

export type FollowUpStatus = 'on_track' | 'due' | 'overdue' | 'escalation';
export type MicrotaskPriority = 'low' | 'normal' | 'high' | 'immediate';
export type MicrotaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

// ======================== TYPES ========================

export interface ClaimOperationalState {
  claim_id: string;
  lifecycle_stage: string;
  next_best_action: string | null;
  next_best_action_confidence: number;
  follow_up_status: string;
  last_activity_at: string | null;
  days_since_last_activity: number;
  pressure_score: number;
  priority_rank: number;
  stale_flag: boolean;
  contradiction_flag: boolean;
  high_exposure_flag: boolean;
  immediate_task_count: number;
  blocking_task_count: number;
  updated_at: string;
}

export interface ClaimMicrotask {
  id: string;
  claim_id: string;
  title: string;
  description: string | null;
  task_type: string | null;
  priority: MicrotaskPriority;
  status: MicrotaskStatus;
  due_at: string | null;
  is_blocking: boolean;
  surfaced_on_board: boolean;
  created_by: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ClaimFollowupLog {
  id: string;
  claim_id: string;
  trigger_reason: string;
  status: string;
  triggered_at: string;
  resolved_at: string | null;
  notes: string | null;
}

export interface ClaimBoardEntry {
  claim_id: string;
  claim_number: string | null;
  policyholder_name: string | null;
  property_address: string | null;
  insurance_carrier: string | null;
  status: string | null;
  sub_status: string | null;
  // Operational state
  ops: ClaimOperationalState | null;
  // Aggregated microtask info
  immediate_microtasks: number;
  blocking_microtasks: number;
}

// ======================== FOLLOW-UP STATUS ========================

/**
 * Determine follow-up status from days since last activity.
 * Rules-first: deterministic thresholds, no AI needed.
 */
export function computeFollowUpStatus(
  daysSinceActivity: number,
  hasContradiction: boolean = false,
  hasRegulatoryRisk: boolean = false
): FollowUpStatus {
  if (hasContradiction || hasRegulatoryRisk || daysSinceActivity >= FOLLOWUP_ESCALATION_DAYS) {
    return 'escalation';
  }
  if (daysSinceActivity >= FOLLOWUP_OVERDUE_DAYS) return 'overdue';
  if (daysSinceActivity >= FOLLOWUP_DUE_DAYS) return 'due';
  return 'on_track';
}

// ======================== PRESSURE SCORE ========================

export interface PressureInputs {
  /** Total claim value / RCV in dollars */
  claimValue: number;
  /** Days since last carrier response */
  carrierDelayDays: number;
  /** Whether contradictions exist in the claim file */
  hasContradiction: boolean;
  /** Number of key documents uploaded (estimate, engineer, photos) */
  keyDocumentsUploaded: number;
  /** Expected key documents for this stage */
  expectedDocuments: number;
  /** Whether litigation/appraisal/DOBI has been initiated */
  escalationInitiated: boolean;
  /** Days since any activity */
  daysSinceActivity: number;
}

/**
 * Compute pressure score 0-100. Higher = more urgent claim.
 */
export function computePressureScore(inputs: PressureInputs): number {
  let score = 0;

  // Financial exposure: claims > $50k get max points, linear scale
  const exposureRatio = Math.min(inputs.claimValue / 50000, 1);
  score += exposureRatio * PRESSURE_WEIGHTS.financialExposure;

  // Carrier delay: max at 30+ days
  const delayRatio = Math.min(inputs.carrierDelayDays / 30, 1);
  score += delayRatio * PRESSURE_WEIGHTS.carrierDelay;

  // Contradiction
  if (inputs.hasContradiction) {
    score += PRESSURE_WEIGHTS.contradiction;
  }

  // Evidence readiness (inverse — missing docs = more pressure)
  if (inputs.expectedDocuments > 0) {
    const gap = 1 - Math.min(inputs.keyDocumentsUploaded / inputs.expectedDocuments, 1);
    score += gap * PRESSURE_WEIGHTS.evidenceReadiness;
  }

  // Escalation readiness
  if (inputs.escalationInitiated) {
    score += PRESSURE_WEIGHTS.escalationReadiness;
  }

  // Stale inactivity: max at 21+ days
  const staleRatio = Math.min(inputs.daysSinceActivity / 21, 1);
  score += staleRatio * PRESSURE_WEIGHTS.staleInactivity;

  return Math.round(Math.min(score, 100) * 10) / 10;
}

// ======================== NEXT BEST ACTION ========================

interface NextActionInput {
  lifecycleStage: string;
  followUpStatus: FollowUpStatus;
  hasContradiction: boolean;
  hasUnansweredDemand: boolean;
  hasPendingSupplement: boolean;
  hasEngineerReport: boolean;
  needsInspection: boolean;
  immediateMicrotasks: number;
  blockingMicrotasks: number;
}

interface NextAction {
  action: string;
  confidence: number;
}

/**
 * Rules-first next best action. Returns exactly one primary action.
 */
export function computeNextBestAction(input: NextActionInput): NextAction {
  // Blocking microtasks take precedence
  if (input.blockingMicrotasks > 0) {
    return { action: `Resolve ${input.blockingMicrotasks} blocking task(s) before proceeding`, confidence: 0.95 };
  }

  // Immediate microtasks
  if (input.immediateMicrotasks > 0) {
    return { action: `Complete ${input.immediateMicrotasks} immediate action item(s)`, confidence: 0.9 };
  }

  // Contradiction takes priority
  if (input.hasContradiction) {
    return { action: 'Escalate contradiction between denial and payment activity', confidence: 0.85 };
  }

  // Stage-specific rules
  switch (input.lifecycleStage) {
    case 'new':
      return { action: 'Schedule initial inspection and begin documentation', confidence: 0.9 };

    case 'inspection_pending':
      if (input.needsInspection) {
        return { action: 'Schedule inspection', confidence: 0.9 };
      }
      return { action: 'Await inspection completion', confidence: 0.7 };

    case 'estimate_in_progress':
      if (!input.hasEngineerReport) {
        return { action: 'Upload engineer report and prepare scope', confidence: 0.85 };
      }
      return { action: 'Finalize estimate and submit to carrier', confidence: 0.8 };

    case 'supplement_submitted':
      if (input.followUpStatus === 'overdue' || input.followUpStatus === 'escalation') {
        return { action: 'Follow up with carrier on unanswered supplement', confidence: 0.9 };
      }
      return { action: 'Await carrier response on supplement', confidence: 0.6 };

    case 'negotiation':
      if (input.hasUnansweredDemand) {
        return { action: 'Follow up with carrier on unanswered demand', confidence: 0.9 };
      }
      return { action: 'Review carrier response and prepare counter-position', confidence: 0.75 };

    case 'demand_sent':
      if (input.followUpStatus === 'overdue') {
        return { action: 'Follow up on unanswered demand — carrier deadline approaching', confidence: 0.95 };
      }
      return { action: 'Await carrier response to demand', confidence: 0.5 };

    case 'appraisal':
      return { action: 'Prepare appraisal documentation and evidence package', confidence: 0.8 };

    case 'litigation':
      return { action: 'Coordinate with attorney on litigation timeline', confidence: 0.8 };

    case 'settled':
      return { action: 'Verify final payment received and close out', confidence: 0.7 };

    case 'closed':
      return { action: 'No immediate action needed', confidence: 1.0 };

    default:
      break;
  }

  // Follow-up status fallbacks
  if (input.followUpStatus === 'escalation') {
    return { action: 'Escalate — claim requires immediate strategic review', confidence: 0.85 };
  }
  if (input.followUpStatus === 'overdue') {
    return { action: 'Follow up — no activity for extended period', confidence: 0.8 };
  }
  if (input.followUpStatus === 'due') {
    return { action: 'Review claim status and determine next step', confidence: 0.6 };
  }

  return { action: 'Await carrier response, no immediate action needed', confidence: 0.5 };
}

// ======================== PRIORITY RANK ========================

/**
 * Compute a composite priority rank. Higher = more urgent.
 * Combines pressure score, follow-up urgency, and flag multipliers.
 */
export function computePriorityRank(
  pressureScore: number,
  followUpStatus: FollowUpStatus,
  flags: { stale: boolean; contradiction: boolean; highExposure: boolean }
): number {
  let rank = pressureScore;

  // Follow-up multiplier
  const followUpMultiplier: Record<FollowUpStatus, number> = {
    on_track: 1.0,
    due: 1.2,
    overdue: 1.5,
    escalation: 2.0,
  };
  rank *= followUpMultiplier[followUpStatus];

  // Flag boosts
  if (flags.contradiction) rank += 15;
  if (flags.highExposure) rank += 10;
  if (flags.stale) rank += 5;

  return Math.round(rank * 10) / 10;
}

// ======================== DAYS SINCE ACTIVITY ========================

export function daysBetween(dateStr: string | null): number {
  if (!dateStr) return 999;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// ======================== MICROTASK HELPERS ========================

export function isOverdueMicrotask(task: ClaimMicrotask): boolean {
  if (!task.due_at) return false;
  if (task.status === 'done' || task.status === 'cancelled') return false;
  return new Date(task.due_at).getTime() < Date.now();
}

export function isOpenMicrotask(task: ClaimMicrotask): boolean {
  return task.status === 'pending' || task.status === 'in_progress';
}

export function getImmediateOpenTasks(tasks: ClaimMicrotask[]): ClaimMicrotask[] {
  return tasks.filter(t => t.priority === 'immediate' && isOpenMicrotask(t));
}

export function getBlockingOpenTasks(tasks: ClaimMicrotask[]): ClaimMicrotask[] {
  return tasks.filter(t => t.is_blocking && isOpenMicrotask(t));
}

export function getOldestOverdueMicrotask(tasks: ClaimMicrotask[]): ClaimMicrotask | null {
  const overdue = tasks
    .filter(t => isOverdueMicrotask(t))
    .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
  return overdue[0] || null;
}

export interface MicrotaskSummary {
  immediateOpen: number;
  blockingOpen: number;
  totalOpen: number;
  overdueCount: number;
  hasUrgentWork: boolean;
}

export function summarizeMicrotasks(tasks: ClaimMicrotask[]): MicrotaskSummary {
  const open = tasks.filter(isOpenMicrotask);
  const immediateOpen = open.filter(t => t.priority === 'immediate').length;
  const blockingOpen = open.filter(t => t.is_blocking).length;
  const overdueCount = tasks.filter(isOverdueMicrotask).length;

  return {
    immediateOpen,
    blockingOpen,
    totalOpen: open.length,
    overdueCount,
    hasUrgentWork: immediateOpen > 0 || blockingOpen > 0 || overdueCount > 0,
  };
}

// ======================== FOLLOW-UP STATUS DISPLAY ========================

export const FOLLOWUP_STATUS_CONFIG: Record<FollowUpStatus, { label: string; color: string }> = {
  on_track: { label: 'On Track', color: 'text-green-600 dark:text-green-400' },
  due: { label: 'Due', color: 'text-amber-600 dark:text-amber-400' },
  overdue: { label: 'Overdue', color: 'text-red-600 dark:text-red-400' },
  escalation: { label: 'Escalation', color: 'text-red-700 dark:text-red-300' },
};

export const PRIORITY_CONFIG: Record<MicrotaskPriority, { label: string; color: string; bgColor: string }> = {
  low: { label: 'Low', color: 'text-muted-foreground', bgColor: 'bg-muted' },
  normal: { label: 'Normal', color: 'text-blue-600 dark:text-blue-400', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
  high: { label: 'High', color: 'text-amber-600 dark:text-amber-400', bgColor: 'bg-amber-100 dark:bg-amber-900/30' },
  immediate: { label: 'Immediate', color: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-100 dark:bg-red-900/30' },
};
