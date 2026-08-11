/**
 * Check Validity Analyzer
 *
 * Most US bank/carrier policies treat checks as stale-dated after ~180 days
 * from the issue date. This helper grades a check by age relative to today
 * (or an explicit reference date) so the UI can warn before a check is
 * likely to be returned by the bank or refused by the carrier.
 */

export type CheckValidityRisk = "unknown" | "ok" | "warning" | "stale" | "expired";

export interface CheckValidityAssessment {
  risk: CheckValidityRisk;
  daysSinceIssue: number | null;
  daysUntilStale: number | null;
  staleThresholdDays: number;
  warningWindowDays: number;
  label: string;
  detail: string;
}

const DEFAULT_STALE_DAYS = 180;
const DEFAULT_WARNING_WINDOW = 30;
const EXPIRED_DAYS = 365;

const MS_PER_DAY = 86_400_000;

function diffDays(a: Date, b: Date): number {
  // Normalize to UTC midnight to avoid TZ skew.
  const aUTC = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bUTC = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.floor((aUTC - bUTC) / MS_PER_DAY);
}

export function assessCheckValidity(
  issueDate: string | Date | null | undefined,
  options: {
    referenceDate?: Date;
    staleThresholdDays?: number | null;
    warningWindowDays?: number;
  } = {},
): CheckValidityAssessment {
  const staleThresholdDays = options.staleThresholdDays ?? DEFAULT_STALE_DAYS;
  const warningWindowDays = options.warningWindowDays ?? DEFAULT_WARNING_WINDOW;
  const reference = options.referenceDate ?? new Date();

  if (!issueDate) {
    return {
      risk: "unknown",
      daysSinceIssue: null,
      daysUntilStale: null,
      staleThresholdDays,
      warningWindowDays,
      label: "No issue date",
      detail: "Issue date missing — cannot assess validity.",
    };
  }

  const issued = typeof issueDate === "string" ? new Date(issueDate) : issueDate;
  if (Number.isNaN(issued.getTime())) {
    return {
      risk: "unknown",
      daysSinceIssue: null,
      daysUntilStale: null,
      staleThresholdDays,
      warningWindowDays,
      label: "Invalid issue date",
      detail: "Issue date could not be parsed.",
    };
  }

  const days = diffDays(reference, issued);
  const daysUntilStale = staleThresholdDays - days;

  if (days < 0) {
    return {
      risk: "ok",
      daysSinceIssue: days,
      daysUntilStale,
      staleThresholdDays,
      warningWindowDays,
      label: "Post-dated",
      detail: `Issue date is ${Math.abs(days)} day(s) in the future.`,
    };
  }

  if (days >= EXPIRED_DAYS) {
    return {
      risk: "expired",
      daysSinceIssue: days,
      daysUntilStale,
      staleThresholdDays,
      warningWindowDays,
      label: `Likely expired · ${days}d old`,
      detail: `Check is ${days} days old (over 1 year). Most banks will return it. Request a reissue.`,
    };
  }

  if (days >= staleThresholdDays) {
    return {
      risk: "stale",
      daysSinceIssue: days,
      daysUntilStale,
      staleThresholdDays,
      warningWindowDays,
      label: `Stale-dated · ${days}d old`,
      detail: `Check has passed the ${staleThresholdDays}-day stale threshold (${days} days old). High risk of being kicked back at deposit — consider requesting a reissue.`,
    };
  }

  if (daysUntilStale <= warningWindowDays) {
    return {
      risk: "warning",
      daysSinceIssue: days,
      daysUntilStale,
      staleThresholdDays,
      warningWindowDays,
      label: `Expires in ${daysUntilStale}d`,
      detail: `Check is ${days} days old. Will hit the ${staleThresholdDays}-day stale threshold in ${daysUntilStale} day(s). Prioritize endorsement and deposit.`,
    };
  }

  return {
    risk: "ok",
    daysSinceIssue: days,
    daysUntilStale,
    staleThresholdDays,
    warningWindowDays,
    label: `${days}d old`,
    detail: `Check is ${days} days old. Within normal deposit window (${daysUntilStale} day(s) until stale).`,
  };
}

export const CHECK_VALIDITY_BADGE_CLASS: Record<CheckValidityRisk, string> = {
  unknown: "bg-muted text-muted-foreground border-border",
  ok: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  stale: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  expired: "bg-red-500/20 text-red-400 border-red-500/40",
};

export function isAtRisk(risk: CheckValidityRisk): boolean {
  return risk === "warning" || risk === "stale" || risk === "expired";
}
