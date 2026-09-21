export const SAME_DAY_DISBURSEMENT_CENTS = 100;
export const NEXT_DAY_DISBURSEMENT_CENTS = 75;
export const BILLABLE_SPLIT_STATUSES = new Set([
  "pending", "submitted", "processing", "completed", "settled", "paid",
]);

export function disbursementSpeedOf(
  split: { requested_speed?: string | null },
  batch?: { delivery_speed?: string | null } | null,
) {
  return String(split.requested_speed || batch?.delivery_speed || "").toLowerCase();
}

export function countDisbursementFees(
  batchData: Array<{ id?: string; delivery_speed?: string | null; status?: string | null }> | null | undefined,
  splitData: Array<{ requested_speed?: string | null; status?: string | null; batch_id?: string | null }> | null | undefined,
) {
  const batches = new Map((batchData ?? []).map((b) => [b.id, b]));
  const billableSplits = (splitData ?? []).filter((s) => BILLABLE_SPLIT_STATUSES.has(String(s.status || "").toLowerCase()));
  const source = billableSplits.length
    ? billableSplits
    : (batchData ?? []).filter((b) => BILLABLE_SPLIT_STATUSES.has(String(b.status || "").toLowerCase()));
  let sameDay = 0;
  let nextDay = 0;
  source.forEach((row) => {
    const speed = billableSplits.length
      ? disbursementSpeedOf(row, batches.get((row as { batch_id?: string }).batch_id))
      : String((row as { delivery_speed?: string }).delivery_speed || "").toLowerCase();
    if (speed === "same_day") sameDay += 1;
    if (speed === "next_day") nextDay += 1;
  });
  return { sameDay, nextDay };
}

export function billedUnitRateCents(
  events: Array<{ event_type?: string; unit_price_cents?: number | null }>,
  eventType: string,
  fallbackCents = 0,
) {
  const prices = [...new Set(
    events.filter((e) => e.event_type === eventType).map((e) => Number(e.unit_price_cents ?? 0)),
  )];
  if (prices.length === 1) return { cents: prices[0], mixed: false };
  if (prices.length > 1) return { cents: fallbackCents, mixed: true };
  return { cents: fallbackCents, mixed: false };
}

export function periodPreviewCents(input: {
  checkCents: number;
  mortgageCents: number;
  sameDay: number;
  nextDay: number;
  monthlyRateCents: number;
  referralDiscountCents: number;
}) {
  return input.checkCents
    + input.mortgageCents
    + input.sameDay * SAME_DAY_DISBURSEMENT_CENTS
    + input.nextDay * NEXT_DAY_DISBURSEMENT_CENTS
    + input.monthlyRateCents
    - input.referralDiscountCents;
}

export function ytdChargesCents(input: {
  checkCents: number;
  mortgageCents: number;
  sameDay: number;
  nextDay: number;
  recordedMaintenanceCents: number;
}) {
  return input.checkCents
    + input.mortgageCents
    + input.sameDay * SAME_DAY_DISBURSEMENT_CENTS
    + input.nextDay * NEXT_DAY_DISBURSEMENT_CENTS
    + input.recordedMaintenanceCents;
}
