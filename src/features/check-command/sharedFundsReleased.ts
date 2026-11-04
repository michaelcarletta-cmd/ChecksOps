/**
 * Funds Released rows for checks a partner shared with this organization (shared_checks) after the
 * source organization released the funds.
 *
 * Both organizations read the same check row, so its check_stage moves on at the source. Once it is
 * funds_released (or disbursed_externally) the Deposited tab drops it, but the Funds Released tab
 * lists disbursement_splits filtered by the viewer's own tenant_id, and the source's payouts are not
 * the viewer's. Without these rows the check left every tab on the partner's side (owner report
 * 2026-11-04: 45 Freedom to Condition One shares). Each row has the split shape the tab renders,
 * built from the shared check itself: the check amount, no payout details, dated by the check's
 * updated_at (no release timestamp is stored on the check).
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

export interface SharedReleasedRow {
  id: string;
  amount: number;
  settled_at: null;
  updated_at: string | null;
  recipient_name: null;
  method: null;
  external_check_number: null;
  stakeholder_accounts: null;
  disbursement_batches: { id: null; check_intake_item_id: string; check_intake_items: SharedCheckLike };
  _sharedReleasedBy: string;
}

export function sharedReleasedRows(
  sharedChecks: SharedCheckLike[],
  ownSplits: Array<{ disbursement_batches?: { check_intake_item_id?: string | null } | null }> = [],
): SharedReleasedRow[] {
  const covered = new Set(
    (ownSplits || []).map((s) => s?.disbursement_batches?.check_intake_item_id).filter(Boolean) as string[],
  );
  return (sharedChecks || [])
    .filter((c) => c && c._shared && RELEASED_STAGES.has(String(c.check_stage || "")))
    .filter((c) => !covered.has(c.id))
    .map((c) => ({
      id: `shared-release-${c.id}`,
      amount: Number(c.amount) || 0,
      settled_at: null,
      updated_at: (c.updated_at as string | null) ?? (c.created_at as string | null) ?? null,
      recipient_name: null,
      method: null,
      external_check_number: null,
      stakeholder_accounts: null,
      disbursement_batches: { id: null, check_intake_item_id: c.id, check_intake_items: c },
      _sharedReleasedBy: String(c._sourceTenantName || "Partner"),
    }));
}
