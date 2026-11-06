/**
 * Funds Released rows for this organization's own checks that money was sent from (owner request
 * 2026-11-06: "Once funds are disbursed once from a check, the check should move to funds released
 * for the disburser ... Tenants should still be able to send money from that check always").
 *
 * A send from the Funds tab (aws/functions/api/providers/production/moov-send.mjs) writes
 * payment_transfers legs (leg_role send_wallet / send_bank, check_id = the check) under the
 * sender's tenant_id. It writes no disbursement_splits row and does not change the check's
 * check_stage, so the Funds Released tab (settled splits) never listed it and the check stayed
 * in Deposited after money left it.
 *
 * Disbursed means at least one send leg for the check that Moov accepted: status submitted,
 * pending, processing or completed (moov-send.mjs ACCEPTED). A leg still ready or submitting, one
 * whose outcome is unknown, and failed, canceled or returned legs do not count. Partial
 * disbursement counts. One row per check and recipient, in the split shape the tab renders.
 *
 * Placement only: the Send action is not gated on any of this.
 */

export const SEND_LEG_ROLES = ["send_wallet", "send_bank"] as const;
export const DISBURSED_SEND_STATUSES = new Set(["submitted", "pending", "processing", "completed"]);

export interface SendLegLike {
  id?: string | null;
  check_id?: string | null;
  leg_role?: string | null;
  status?: string | null;
  amount_cents?: number | string | null;
  created_at?: string | null;
  submitted_at?: string | null;
  completed_at?: string | null;
  destination_tenant_id?: string | null;
  provider_metadata?: {
    recipient_kind?: string | null;
    recipient_id?: string | null;
    recipient_name?: string | null;
    recipient_index?: number | null;
  } | null;
}

export interface SentCheckLike {
  id: string;
  check_stage?: string | null;
  amount?: number | string | null;
  [key: string]: unknown;
}

export interface SentReleasedRow {
  id: string;
  amount: number;
  settled_at: string | null;
  updated_at: string | null;
  recipient_name: string;
  method: "send";
  external_check_number: null;
  stakeholder_accounts: null;
  disbursement_batches: { id: null; check_intake_item_id: string; check_intake_items: SentCheckLike | { id: string } };
  _sentAt: string | null;
  _sendStatus: "completed" | "in_transit";
}

/** The empty value while the sends are loading (one object, so memos keyed on it stay stable). */
export const NO_CHECK_SENDS: { legs: SendLegLike[]; checks: SentCheckLike[] } = Object.freeze({
  legs: [],
  checks: [],
}) as { legs: SendLegLike[]; checks: SentCheckLike[] };

const isSendLeg =(leg: SendLegLike) =>
  (SEND_LEG_ROLES as readonly string[]).includes(String(leg?.leg_role || ""));

/** True when the leg is a send from a check that Moov accepted (posted, not draft or failed). */
export const isDisbursedSendLeg = (leg: SendLegLike | null | undefined): boolean =>
  !!leg && !!leg.check_id && isSendLeg(leg) && DISBURSED_SEND_STATUSES.has(String(leg.status || ""));

/** Ids of the checks with at least one disbursed send leg. */
export function disbursedCheckIds(legs: SendLegLike[]): Set<string> {
  const out = new Set<string>();
  for (const leg of legs || []) if (isDisbursedSendLeg(leg)) out.add(String(leg.check_id));
  return out;
}

const latest = (a: string | null, b: string | null) => {
  if (!a) return b;
  if (!b) return a;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
};

const recipientKey = (leg: SendLegLike) => {
  const meta = leg.provider_metadata ?? {};
  if (leg.destination_tenant_id) return `partner:${String(leg.destination_tenant_id).toLowerCase()}`;
  if (meta.recipient_id) return `${meta.recipient_kind || "recipient"}:${String(meta.recipient_id).toLowerCase()}`;
  return `name:${String(meta.recipient_name || "").toLowerCase()}`;
};

/**
 * One Funds Released row per check and recipient with disbursed sends. `checks` supplies the
 * check details the row shows (number, carrier, claim); a check not in it still gets a row.
 */
export function sentReleasedRows(legs: SendLegLike[], checks: SentCheckLike[] = []): SentReleasedRow[] {
  const byId = new Map((checks || []).filter((c) => c?.id).map((c) => [c.id, c]));
  const groups = new Map<string, { checkId: string; cents: number; name: string; at: string | null; done: boolean }>();
  for (const leg of legs || []) {
    if (!isDisbursedSendLeg(leg)) continue;
    const checkId = String(leg.check_id);
    const key = `${checkId}|${recipientKey(leg)}`;
    const at = leg.completed_at || leg.submitted_at || leg.created_at || null;
    const g = groups.get(key) ?? {
      checkId,
      cents: 0,
      name: String(leg.provider_metadata?.recipient_name || "Recipient"),
      at: null,
      done: true,
    };
    g.cents += Math.round(Number(leg.amount_cents) || 0);
    g.at = latest(g.at, at);
    g.done = g.done && String(leg.status) === "completed";
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      id: `send-release-${key}`,
      amount: g.cents / 100,
      settled_at: g.done ? g.at : null,
      updated_at: g.at,
      recipient_name: g.name,
      method: "send" as const,
      external_check_number: null,
      stakeholder_accounts: null,
      disbursement_batches: {
        id: null,
        check_intake_item_id: g.checkId,
        check_intake_items: byId.get(g.checkId) ?? { id: g.checkId },
      },
      _sentAt: g.at,
      _sendStatus: g.done ? ("completed" as const) : ("in_transit" as const),
    }))
    .sort((a, b) => new Date(b._sentAt ?? 0).getTime() - new Date(a._sentAt ?? 0).getTime());
}

/**
 * Count and total of the sent checks the server's stage totals still count as Deposited (their
 * check_stage stays deposited after a send), so the Deposited badge can leave them out.
 */
export function sentStillDeposited(checks: SentCheckLike[], sentIds: Set<string>) {
  let count = 0;
  let total = 0;
  for (const c of checks || []) {
    if (!c?.id || !sentIds.has(c.id) || c.check_stage !== "deposited") continue;
    count += 1;
    total += Number(c.amount) || 0;
  }
  return { count, total };
}
