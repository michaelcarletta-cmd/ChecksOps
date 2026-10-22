/**
 * Bank Deposits grouping (owner, 2026-10-22: "Bank deposit should only show
 * the checks that were deposited and on what day they were deposited").
 *
 * A check is deposited only when its Check Alt deposit is `cleared` AND
 * `cleared_at` holds the FinCapture depositDate (the bank-credit day the
 * reconcile persisted). Deposited checks are grouped by that day with a daily
 * total. Everything else (pending_approval, submitted, unresolved) is in
 * transit and is never placed on a deposit day; submitted_at is not a deposit
 * date.
 */

export type BankDepositRowLike = {
  amount?: number | string | null;
  status?: string | null;
  cleared_at?: string | null;
  submitted_at?: string | null;
};

/** YYYY-MM-DD of a stored timestamp, or "unknown". */
export const bankDepositDayKey = (iso: string | null | undefined): string => {
  if (!iso) return "unknown";
  const day = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "unknown";
};

export const sumDepositAmounts = (rows: { amount?: number | string | null }[]): number =>
  rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

/** Deposited only when local status is cleared and the provider depositDate was stored. */
export const isBankDepositSettled = (row: { status?: string | null; cleared_at?: string | null }): boolean =>
  row?.status === "cleared" && Boolean(row?.cleared_at) && bankDepositDayKey(row?.cleared_at) !== "unknown";

export type BankDepositDay<T> = {
  key: string;
  dayKey: string;
  total: number;
  rows: T[];
};

export function groupBankDeposits<T extends BankDepositRowLike>(rows: T[]): {
  days: BankDepositDay<T>[];
  inTransit: T[];
  depositedTotal: number;
  inTransitTotal: number;
} {
  const byDay = new Map<string, BankDepositDay<T>>();
  const inTransit: T[] = [];
  for (const row of rows || []) {
    if (!isBankDepositSettled(row)) {
      inTransit.push(row);
      continue;
    }
    const dayKey = bankDepositDayKey(row.cleared_at);
    const key = `deposited:${dayKey}`;
    let day = byDay.get(key);
    if (!day) {
      day = { key, dayKey, total: 0, rows: [] };
      byDay.set(key, day);
    }
    day.rows.push(row);
    day.total = sumDepositAmounts(day.rows);
  }
  const days = Array.from(byDay.values()).sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  inTransit.sort((a, b) => String(b.submitted_at || "").localeCompare(String(a.submitted_at || "")));
  return {
    days,
    inTransit,
    depositedTotal: days.reduce((s, d) => s + d.total, 0),
    inTransitTotal: sumDepositAmounts(inTransit),
  };
}

const TRANSIT_WORDS: Record<string, string> = {
  pending_approval: "Waiting in Check Alt",
  submitted: "Approved, not yet deposited",
  cleared: "Cleared, deposit date not reported",
};

/** Status words for an in-transit row. */
export const inTransitStatusLabel = (status: string | null | undefined): string =>
  (status && TRANSIT_WORDS[status]) || (status ? status.replace(/_/g, " ") : "Unknown");
