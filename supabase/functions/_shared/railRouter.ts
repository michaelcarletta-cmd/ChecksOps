/**
 * Server-side payout rail router (Moov).
 *
 * Pure, dependency-free decision logic: given the speed the user asked for,
 * what the recipient's bank actually supports, the amount, and the clock, it
 * returns the single best Moov rail to use — downgrading instant -> same-day
 * -> standard rather than ever failing a payout.
 *
 * Nothing here performs I/O, so it is exercised directly by
 * `scripts/test-rail-router.mjs`.
 *
 * Actum and Plaid are untouched: this only chooses among Moov rails.
 */

export type PaymentSpeed = "standard" | "same_day" | "instant";

/** Moov payment-method types, in ChecksOps speed order. */
export const MOOV_RAIL_BY_SPEED: Record<PaymentSpeed, string> = {
  instant: "rtp-credit",
  same_day: "ach-credit-same-day",
  standard: "ach-credit-standard",
};

/** Downgrade chain. Index 0 is the fastest. */
export const SPEED_ORDER: PaymentSpeed[] = ["instant", "same_day", "standard"];

/** RTP network per-transfer ceiling ($1,000,000). */
export const RTP_MAX_CENTS = 100_000_000;
/** NACHA same-day ACH per-transfer ceiling ($1,000,000). */
export const SAME_DAY_MAX_CENTS = 100_000_000;

/** Same-day ACH submission cutoff, US Eastern time. */
export const SAME_DAY_CUTOFF_HOUR_ET = 16;
export const SAME_DAY_CUTOFF_MINUTE_ET = 45;

export interface RailDecisionInput {
  /** Speed the caller asked for. Unknown values are treated as "standard". */
  requestedSpeed?: string | null;
  amountCents: number;
  /** Moov payment-method type -> paymentMethodID for the destination. */
  railPaymentMethodIds?: Record<string, string> | null;
  /** Optional explicit list of supported Moov payment-method types. */
  supportedRails?: string[] | null;
  /** Fallback paymentMethodID used when no rail metadata exists yet. */
  fallbackPaymentMethodId?: string | null;
  now?: Date;
}

export interface RailDecision {
  requestedSpeed: PaymentSpeed;
  selectedSpeed: PaymentSpeed;
  /** Moov payment-method type, or null when we fall back to legacy behaviour. */
  railType: string | null;
  /** paymentMethodID to send to Moov as the destination. */
  paymentMethodId: string | null;
  downgraded: boolean;
  /** Machine-readable reason for the downgrade / fallback, null when honoured. */
  reason: string | null;
  /** Human-readable trail of every speed that was considered and rejected. */
  evaluated: Array<{ speed: PaymentSpeed; eligible: boolean; reason: string | null }>;
}

export function normalizeSpeed(value: unknown): PaymentSpeed {
  const v = String(value ?? "standard").toLowerCase().replace(/[\s-]/g, "_");
  if (v === "instant" || v === "rtp" || v === "fednow") return "instant";
  if (v === "same_day" || v === "sameday") return "same_day";
  return "standard";
}

/** Minutes past midnight in US Eastern time for the given instant. */
export function easternMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

/** Weekday (0=Sun..6=Sat) in US Eastern time. */
export function easternWeekday(now: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name.slice(0, 3));
}

/** Same-day ACH is only accepted on banking days before the ET cutoff. */
export function sameDayWindowOpen(now: Date): boolean {
  const weekday = easternWeekday(now);
  if (weekday === 0 || weekday === 6) return false;
  return easternMinutes(now) < SAME_DAY_CUTOFF_HOUR_ET * 60 + SAME_DAY_CUTOFF_MINUTE_ET;
}

function railsFrom(input: RailDecisionInput): { ids: Record<string, string>; types: Set<string> } {
  const ids = input.railPaymentMethodIds ?? {};
  const types = new Set<string>([
    ...Object.keys(ids).filter((k) => !!ids[k]),
    ...(input.supportedRails ?? []),
  ]);
  return { ids, types };
}

function eligibility(
  speed: PaymentSpeed,
  input: RailDecisionInput,
  types: Set<string>,
  now: Date,
): string | null {
  const rail = MOOV_RAIL_BY_SPEED[speed];
  if (!types.has(rail)) return "rail_not_supported_by_recipient";
  if (speed === "instant" && input.amountCents > RTP_MAX_CENTS) return "amount_exceeds_rtp_limit";
  if (speed === "same_day") {
    if (input.amountCents > SAME_DAY_MAX_CENTS) return "amount_exceeds_same_day_limit";
    if (!sameDayWindowOpen(now)) return "past_same_day_cutoff";
  }
  return null;
}

/**
 * Chooses the fastest allowed rail at or below the requested speed.
 *
 * When the destination has no rail metadata yet, the decision falls back to
 * today's behaviour: the caller's existing bank paymentMethodID with no rail
 * hint, i.e. plain standard ACH.
 */
export function selectRail(input: RailDecisionInput): RailDecision {
  const now = input.now ?? new Date();
  const requestedSpeed = normalizeSpeed(input.requestedSpeed);
  const { ids, types } = railsFrom(input);
  const evaluated: RailDecision["evaluated"] = [];

  if (types.size === 0) {
    return {
      requestedSpeed,
      selectedSpeed: "standard",
      railType: null,
      paymentMethodId: input.fallbackPaymentMethodId ?? null,
      downgraded: requestedSpeed !== "standard",
      reason: "rail_metadata_unavailable",
      evaluated,
    };
  }

  const chain = SPEED_ORDER.slice(SPEED_ORDER.indexOf(requestedSpeed));
  for (const speed of chain) {
    const reason = eligibility(speed, input, types, now);
    evaluated.push({ speed, eligible: !reason, reason });
    if (reason) continue;
    const railType = MOOV_RAIL_BY_SPEED[speed];
    return {
      requestedSpeed,
      selectedSpeed: speed,
      railType,
      paymentMethodId: ids[railType] ?? input.fallbackPaymentMethodId ?? null,
      downgraded: speed !== requestedSpeed,
      reason: speed === requestedSpeed ? null : evaluated[0]?.reason ?? "downgraded",
      evaluated,
    };
  }

  // Nothing in the chain is usable — keep money moving on legacy standard ACH.
  return {
    requestedSpeed,
    selectedSpeed: "standard",
    railType: null,
    paymentMethodId: input.fallbackPaymentMethodId ?? null,
    downgraded: true,
    reason: evaluated[0]?.reason ?? "no_eligible_rail",
    evaluated,
  };
}

/** Compact object stored on transfers/splits and payment events for debugging. */
export function railDecisionMetadata(decision: RailDecision) {
  return {
    requested_speed: decision.requestedSpeed,
    selected_speed: decision.selectedSpeed,
    selected_rail: decision.railType,
    downgraded: decision.downgraded,
    downgrade_reason: decision.reason,
    evaluated: decision.evaluated,
  };
}
