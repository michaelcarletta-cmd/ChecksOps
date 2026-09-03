/**
 * Faithful port of supabase/functions/_shared/railRouter.ts
 * Pure decision logic. No I/O.
 */

export const MOOV_RAIL_BY_SPEED = {
  instant: 'rtp-credit',
  same_day: 'ach-credit-same-day',
  standard: 'ach-credit-standard',
};

export const SPEED_ORDER = ['instant', 'same_day', 'standard'];
export const RTP_MAX_CENTS = 100_000_000;
export const SAME_DAY_MAX_CENTS = 100_000_000;
export const SAME_DAY_CUTOFF_HOUR_ET = 16;
export const SAME_DAY_CUTOFF_MINUTE_ET = 45;

export function normalizeSpeed(value) {
  const v = String(value ?? 'standard').toLowerCase().replace(/[\s-]/g, '_');
  if (v === 'instant' || v === 'rtp' || v === 'fednow') return 'instant';
  if (v === 'same_day' || v === 'sameday') return 'same_day';
  return 'standard';
}

export function easternMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
}

export function easternWeekday(now) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(now);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name.slice(0, 3));
}

export function sameDayWindowOpen(now) {
  const weekday = easternWeekday(now);
  if (weekday === 0 || weekday === 6) return false;
  return easternMinutes(now) < SAME_DAY_CUTOFF_HOUR_ET * 60 + SAME_DAY_CUTOFF_MINUTE_ET;
}

function railsFrom(input) {
  const ids = input.railPaymentMethodIds ?? {};
  const types = new Set([
    ...Object.keys(ids).filter((k) => !!ids[k]),
    ...(input.supportedRails ?? []),
  ]);
  return { ids, types };
}

function eligibility(speed, input, types, now) {
  const rail = MOOV_RAIL_BY_SPEED[speed];
  if (!types.has(rail)) return 'rail_not_supported_by_recipient';
  if (speed === 'instant' && input.amountCents > RTP_MAX_CENTS) return 'amount_exceeds_rtp_limit';
  if (speed === 'same_day') {
    if (input.amountCents > SAME_DAY_MAX_CENTS) return 'amount_exceeds_same_day_limit';
    if (!sameDayWindowOpen(now)) return 'past_same_day_cutoff';
  }
  return null;
}

export function selectRail(input) {
  const now = input.now ?? new Date();
  const requestedSpeed = normalizeSpeed(input.requestedSpeed);
  const { ids, types } = railsFrom(input);
  const evaluated = [];

  if (types.size === 0) {
    return {
      requestedSpeed,
      selectedSpeed: 'standard',
      railType: null,
      paymentMethodId: input.fallbackPaymentMethodId ?? null,
      downgraded: requestedSpeed !== 'standard',
      reason: 'rail_metadata_unavailable',
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
      reason: speed === requestedSpeed ? null : evaluated[0]?.reason ?? 'downgraded',
      evaluated,
    };
  }

  return {
    requestedSpeed,
    selectedSpeed: 'standard',
    railType: null,
    paymentMethodId: input.fallbackPaymentMethodId ?? null,
    downgraded: true,
    reason: evaluated[0]?.reason ?? 'no_eligible_rail',
    evaluated,
  };
}

export function railDecisionMetadata(decision) {
  return {
    requested_speed: decision.requestedSpeed,
    selected_speed: decision.selectedSpeed,
    selected_rail: decision.railType,
    downgraded: decision.downgraded,
    downgrade_reason: decision.reason,
    evaluated: decision.evaluated,
  };
}
