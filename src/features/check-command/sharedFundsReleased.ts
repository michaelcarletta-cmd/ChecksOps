/**
 * Checks a partner shared with this organization (shared_checks) after the source organization
 * released the funds.
 *
 * Both organizations read the same check row, so its check_stage moves on at the source. Once it is
 * funds_released (or disbursed_externally) the Deposited tab dropped it, and the Funds Released tab
 * lists the viewer's own payouts, which the source's are not: the check left every tab on the
 * partner's side (owner report 2026-11-04: 45 Freedom to Condition One shares).
 *
 * Funds Released is this organization's own money out, so a partner's release is not listed there
 * (owner report 2026-11-12: Condition One sent nothing through ChecksOps and must see zero). The
 * shared check stays in the viewer's Deposited tab instead, labelled "Released by <source>".
 */

export const RELEASED_STAGES = new Set(["funds_released", "disbursed_externally"]);

export interface SharedCheckLike {
  id: string;
  amount?: number | string | null;
  status?: string | null;
  check_stage?: string | null;
  _shared?: boolean;
  _sourceTenantName?: string | null;
  [key: string]: unknown;
}

/** True for a check shared with the viewer whose funds the source organization released. */
export const isSharedReleased = (c: SharedCheckLike | null | undefined): boolean =>
  !!c && !!c._shared && RELEASED_STAGES.has(String(c.check_stage || ""));

/** Ids, count and total of the shared checks the source released (they stay in Deposited). */
export function sharedReleasedSummary(sharedChecks: SharedCheckLike[]) {
  const ids = new Set<string>();
  let total = 0;
  for (const c of sharedChecks || []) {
    if (!isSharedReleased(c) || ids.has(c.id)) continue;
    ids.add(c.id);
    total += Number(c.amount) || 0;
  }
  return { ids, count: ids.size, total };
}

/** The Deposited-tab label of a shared check the source released. */
export const sharedReleasedLabel = (c: SharedCheckLike): string =>
  `Released by ${String(c._sourceTenantName || "Partner")}`;
