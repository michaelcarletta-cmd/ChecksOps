/**
 * Usage page details for disbursement fees (next-day / same-day sends, SQL 120).
 *
 * A send fee event links to the first posted leg of one recipient's payment
 * (check_billing_events.payment_transfer_id), not to the check. A recipient's
 * payment can be two legs (wallet part and bank top-up) that share
 * provider_metadata request_hash and recipient_index. The amount sent is the
 * sum of those legs that did not fail or get canceled; the check, its insured
 * and the payee come from the legs and the check's claim.
 *
 * Labels never name a payment or deposit provider.
 */

export interface UsageFeeEvent {
  id: string;
  event_type?: string | null;
  payment_transfer_id?: string | null;
  claim_id?: string | null;
  status?: string | null;
}

export interface SendLeg {
  id: string;
  amount_cents?: number | string | null;
  status?: string | null;
  check_id?: string | null;
  provider_metadata?: Record<string, unknown> | null;
}

export interface UsageCheck {
  id: string;
  check_number?: string | null;
  payee_line?: string | null;
  claim_id?: string | null;
}

export interface UsageClaim {
  id: string;
  claim_number?: string | null;
  policyholder_name?: string | null;
}

export interface DisbursementDetail {
  amount_cents: number;
  check_id: string | null;
  check_number: string | null;
  insured_name: string | null;
  claim_number: string | null;
  payee_name: string | null;
}

const SEND_FEE_TYPES = new Set(["moov_next_day", "moov_same_day", "moov_instant"]);
const NOT_SENT = new Set(["draft", "ready", "failed", "canceled", "cancelled"]);

export const isSendFeeEvent = (eventType: string | null | undefined): boolean =>
  SEND_FEE_TYPES.has(String(eventType || ""));

const LABELS: Record<string, string> = {
  check_processing: "Check processing",
  moov_next_day: "Next-day payment",
  moov_same_day: "Same-day payment",
  moov_instant: "Instant payment",
  mortgage_handling: "Mortgage handling",
  mortgage_shipping_label: "Mortgage shipping label",
  mortgage_ops_initial: "Mortgage handling",
  mortgage_ops_additional_check: "Mortgage handling, additional check",
};

/** A tenant-facing name for a usage event type (never a provider name). */
export function usageEventLabel(eventType: string | null | undefined): string {
  const key = String(eventType || "");
  if (LABELS[key]) return LABELS[key];
  if (!key) return "Processing";
  const words = key.replace(/^(moov|checkalt|check_alt|actum)_/i, "").replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Processing";
}

const meta = (leg: SendLeg) => (leg.provider_metadata || {}) as Record<string, unknown>;
const text = (value: unknown): string | null => {
  const s = value == null ? "" : String(value).trim();
  return s ? s : null;
};

/** The legs of the same recipient of the same send (the leg alone when it carries no send hash). */
export function recipientLegs(anchor: SendLeg, legs: SendLeg[]): SendLeg[] {
  const hash = text(meta(anchor).request_hash);
  if (!hash) return [anchor];
  const index = text(meta(anchor).recipient_index);
  const same = legs.filter((leg) => text(meta(leg).request_hash) === hash && text(meta(leg).recipient_index) === index);
  return same.some((leg) => leg.id === anchor.id) ? same : [anchor, ...same];
}

const cents = (value: number | string | null | undefined): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** Per send fee event: the amount sent to that recipient and the check, insured and payee. */
export function disbursementDetails(
  events: UsageFeeEvent[],
  legs: SendLeg[],
  checks: UsageCheck[],
  claims: UsageClaim[],
): Map<string, DisbursementDetail> {
  const legById = new Map((legs || []).map((leg) => [leg.id, leg]));
  const checkById = new Map((checks || []).map((check) => [check.id, check]));
  const claimById = new Map((claims || []).map((claim) => [claim.id, claim]));
  const out = new Map<string, DisbursementDetail>();
  for (const event of events || []) {
    if (!isSendFeeEvent(event.event_type) || event.status === "voided") continue;
    const anchor = event.payment_transfer_id ? legById.get(event.payment_transfer_id) : undefined;
    const group = anchor ? recipientLegs(anchor, legs || []) : [];
    const amount = group
      .filter((leg) => !NOT_SENT.has(String(leg.status || "").toLowerCase()))
      .reduce((sum, leg) => sum + cents(leg.amount_cents), 0);
    const checkId = anchor?.check_id ?? null;
    const check = checkId ? checkById.get(checkId) : undefined;
    const claim = claimById.get(String(event.claim_id || check?.claim_id || ""));
    out.set(event.id, {
      amount_cents: amount,
      check_id: checkId,
      check_number: text(check?.check_number),
      insured_name: text(claim?.policyholder_name) ?? text(check?.payee_line),
      claim_number: text(claim?.claim_number),
      payee_name: anchor ? text(meta(anchor).recipient_name) : null,
    });
  }
  return out;
}

/** Total sent this period across the send fee events shown. */
export function disbursementVolumeCents(details: Map<string, DisbursementDetail>): number {
  let total = 0;
  for (const detail of details.values()) total += detail.amount_cents;
  return total;
}
