/**
 * AWS homeowner-ledger-view returns token/claim/events.
 * The public ledger UI expects mode/homeowner/totals/pending_*.
 * Normalize either shape so tracking pages fail closed instead of crashing.
 */

export type HomeownerLedgerTotals = {
  received: number;
  deposited: number;
  released: number;
  remaining: number;
};

const RECEIVED_EVENTS = new Set([
  "check_received",
  "supplement_check",
  "depreciation_check",
  "deductible_check",
]);
const DEPOSITED_EVENTS = new Set(["deposited", "cleared"]);
const RELEASED_EVENTS = new Set(["funds_released"]);

export function totalsFromLedgerEvents(
  events: Array<{ event_type?: string; amount?: number | null }>,
): HomeownerLedgerTotals {
  const totals = { received: 0, deposited: 0, released: 0, remaining: 0 };
  for (const event of events) {
    const amount = Number(event?.amount || 0);
    if (!amount) continue;
    if (RECEIVED_EVENTS.has(String(event.event_type || ""))) totals.received += amount;
    if (DEPOSITED_EVENTS.has(String(event.event_type || ""))) totals.deposited += amount;
    if (RELEASED_EVENTS.has(String(event.event_type || ""))) totals.released += amount;
  }
  totals.remaining = Math.max(0, totals.received - totals.released);
  return totals;
}

export function shapeHomeownerLedgerSummary(res: Record<string, unknown> | null | undefined) {
  const raw = res && typeof res === "object" ? res : {};
  const claim = (raw.claim as Record<string, unknown> | null) ?? null;
  const events = Array.isArray(raw.events) ? raw.events : [];
  const token = raw.token && typeof raw.token === "object"
    ? raw.token as Record<string, unknown>
    : {};
  const homeowner = raw.homeowner && typeof raw.homeowner === "object"
    ? raw.homeowner as Record<string, unknown>
    : {};
  const incomingTotals = raw.totals && typeof raw.totals === "object"
    ? raw.totals as Record<string, unknown>
    : null;

  return {
    ...raw,
    mode: raw.mode === "pre_claim" || raw.mode === "claim"
      ? raw.mode
      : (claim ? "claim" : "pre_claim"),
    homeowner: {
      name: (homeowner.name as string | null) ?? (token.homeowner_name as string | null) ?? null,
      email: (homeowner.email as string | null) ?? (token.homeowner_email as string | null) ?? null,
    },
    claim,
    events,
    totals: incomingTotals
      ? {
          received: Number(incomingTotals.received || 0),
          deposited: Number(incomingTotals.deposited || 0),
          released: Number(incomingTotals.released || 0),
          remaining: Number(incomingTotals.remaining || 0),
        }
      : totalsFromLedgerEvents(events),
    pending_upload_count: Number(raw.pending_upload_count || 0),
    pending_signatures: Array.isArray(raw.pending_signatures) ? raw.pending_signatures : [],
    pending_endorsements: Array.isArray(raw.pending_endorsements) ? raw.pending_endorsements : [],
    shared_documents: Array.isArray(raw.shared_documents) ? raw.shared_documents : [],
    can_upload: raw.can_upload !== false,
  };
}
