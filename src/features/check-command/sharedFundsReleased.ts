/**
 * Checks a partner shared with this organization (shared_checks) after the source organization
 * released the funds.
 *
 * Both organizations read the same check row, so its check_stage moves on at the source. Once it is
 * funds_released (or disbursed_externally) the Deposited tab drops it on both sides.
 *
 * On the viewer's side the release is money coming in, so the check is listed under Funds
 * Received (owner 2026-11-12: "All of the checks that were in their funds released should have
 * been funds received since they received funds"). It is never listed under the viewer's Funds
 * Released, which is the viewer's own money out (owner report 2026-11-12: Condition One sent
 * nothing through ChecksOps and must see zero there), and it must not leave every tab (owner
 * report 2026-11-04: 45 Freedom to Condition One shares).
 *
 * When the source recorded a payment to the viewer, that payment is already a Funds Received row
 * (get_tenant_funds_received, incoming transfers) with its real amount, and nothing is added. For
 * a released shared check with no such row, one row is built from the check itself, labelled
 * "Released by <source>". The viewer cannot read the source's payouts, so what it was paid from
 * that check is not known here: the row shows the check amount and adds nothing to the Funds
 * Received totals (receivedAmount).
 */

export const RELEASED_STAGES = new Set(["funds_released", "disbursed_externally"]);

export interface SharedCheckLike {
  id: string;
  amount?: number | string | null;
  status?: string | null;
  check_stage?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  _shared?: boolean;
  _sourceTenantName?: string | null;
  [key: string]: unknown;
}

export interface SharedReleasedReceivedRow {
  id: string;
  amount: number;
  settled_at: null;
  updated_at: string | null;
  created_at: string | null;
  recipient_name: null;
  method: null;
  external_check_number: null;
  sender: { name: string };
  disbursement_batches: { id: null; check_intake_item_id: string; check_intake_items: SharedCheckLike };
  _sharedReleasedBy: string;
}

type ReceivedLike = { disbursement_batches?: { check_intake_item_id?: string | null } | null } | null | undefined;

/** True for a check shared with the viewer whose funds the source organization released. */
export const isSharedReleased = (c: SharedCheckLike | null | undefined): boolean =>
  !!c && !!c._shared && RELEASED_STAGES.has(String(c.check_stage || ""));

/**
 * Funds Received rows for the released shared checks that have no Funds Received row yet.
 * `received` is every other Funds Received row (recorded payouts and incoming transfers).
 */
export function sharedReleasedReceivedRows(
  sharedChecks: SharedCheckLike[],
  received: ReceivedLike[] = [],
): SharedReleasedReceivedRow[] {
  const covered = new Set(
    (received || []).map((r) => r?.disbursement_batches?.check_intake_item_id).filter(Boolean) as string[],
  );
  const seen = new Set<string>();
  const out: SharedReleasedReceivedRow[] = [];
  for (const c of sharedChecks || []) {
    if (!isSharedReleased(c) || covered.has(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    const source = String(c._sourceTenantName || "Partner");
    out.push({
      id: `shared-release-${c.id}`,
      amount: Number(c.amount) || 0,
      settled_at: null,
      updated_at: (c.updated_at as string | null) ?? (c.created_at as string | null) ?? null,
      created_at: (c.created_at as string | null) ?? null,
      recipient_name: null,
      method: null,
      external_check_number: null,
      sender: { name: source },
      disbursement_batches: { id: null, check_intake_item_id: c.id, check_intake_items: c },
      _sharedReleasedBy: source,
    });
  }
  return out;
}

/** What a Funds Received / Funds Released row adds to a total: nothing for a row built from a shared check. */
export const receivedAmount = (split: { amount?: number | string | null; _sharedReleasedBy?: string | null } | null | undefined): number =>
  !split || split._sharedReleasedBy ? 0 : Number(split.amount) || 0;
