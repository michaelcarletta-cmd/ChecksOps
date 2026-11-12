/**
 * Group Funds Released / Funds Received rows by claim #, newest file first.
 *
 * The order must depend on the rows alone. A row with no settled_at (a send still in transit, a
 * receipt not yet settled) used to be dated "now", read again for every row on every render, so
 * those groups changed places each time the page refreshed (owner report 2026-11-12: the names
 * "keep rotating"). Such a row is dated by when it was sent or last updated, and equal dates are
 * ordered by the group key.
 */

export type SplitClaimGroup = {
  key: string;
  claimNumber: string;
  policyholderName: string;
  rows: any[];
  total: number;
  latest: string;
};

const time = (iso: string) => {
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};

/** The date a row is ordered by; "" when the row carries none. */
export const splitOrderDate = (split: any): string =>
  String(split?.settled_at ?? split?._sentAt ?? split?.updated_at ?? split?.created_at ?? "");

export function groupSplitsByClaim(
  rows: any[],
  resolve: (check: any) => { claimNumber: string | null; policyholderName: string | null },
): SplitClaimGroup[] {
  const groups = new Map<string, SplitClaimGroup>();
  rows.forEach((split: any) => {
    const check = split.disbursement_batches?.check_intake_items;
    const resolved = resolve(check);
    const claimNumber = resolved.claimNumber || "Unlinked claim";
    const policyholderName = resolved.policyholderName || "Unknown insured";
    const key = resolved.claimNumber
      ? `claim::${String(claimNumber).trim().toLowerCase()}`
      : `unlinked::${split.id}`;
    const existing = groups.get(key);
    const at = splitOrderDate(split);
    if (existing) {
      existing.rows.push(split);
      existing.total += Number(split.amount) || 0;
      if (time(at) > time(existing.latest)) existing.latest = at;
    } else {
      groups.set(key, { key, claimNumber, policyholderName, rows: [split], total: Number(split.amount) || 0, latest: at });
    }
  });
  return Array.from(groups.values()).sort(
    (x, y) => time(y.latest) - time(x.latest) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );
}
