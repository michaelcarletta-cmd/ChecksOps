/**
 * Bank Deposits grouping (owner, 2026-10-22): once a check has passed to
 * Check Alt it belongs on Bank Deposits, under the day it was deposited,
 * with a drop-down of that day's checks. There is no separate in-transit
 * list; checks still waiting are on the "Waiting on Deposit" tab.
 *
 * On Bank Deposits: status `submitted` (Check Alt approved it) or `cleared`.
 * Deposit day: the Check Alt depositDate stored in `cleared_at` when the
 * deposit cleared (isBankDepositSettled), otherwise the local day the check
 * was sent to Check Alt (`submitted_at`).
 */

export type BankDepositRowLike = {
  amount?: number | string | null;
  status?: string | null;
  cleared_at?: string | null;
  submitted_at?: string | null;
};

const BANK_DEPOSIT_STATUSES = new Set(["submitted", "cleared"]);

/** YYYY-MM-DD of a stored timestamp (its UTC date), or "unknown". */
export const bankDepositDayKey = (iso: string | null | undefined): string => {
  if (!iso) return "unknown";
  const day = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "unknown";
};

/** YYYY-MM-DD of a timestamp in the viewer's local time zone, or "unknown". */
export const localDayKey = (iso: string | null | undefined): string => {
  if (!iso) return "unknown";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

export const sumDepositAmounts = (rows: { amount?: number | string | null }[]): number =>
  rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

/** Cleared with the Check Alt depositDate stored in cleared_at. */
export const isBankDepositSettled = (row: { status?: string | null; cleared_at?: string | null }): boolean =>
  row?.status === "cleared" && Boolean(row?.cleared_at) && bankDepositDayKey(row?.cleared_at) !== "unknown";

/** Passed to Check Alt: approved (submitted) or cleared. Waiting checks are not listed. */
export const isOnBankDeposits = (row: { status?: string | null }): boolean =>
  BANK_DEPOSIT_STATUSES.has(String(row?.status || ""));

/** The day a check is listed under on Bank Deposits. */
export const bankDepositDayOf = (row: BankDepositRowLike): string =>
  isBankDepositSettled(row) ? bankDepositDayKey(row.cleared_at) : localDayKey(row.submitted_at);

export type BankDepositDay<T> = {
  key: string;
  dayKey: string;
  total: number;
  rows: T[];
};

export function groupBankDeposits<T extends BankDepositRowLike>(rows: T[]): {
  days: BankDepositDay<T>[];
  total: number;
} {
  const byDay = new Map<string, BankDepositDay<T>>();
  for (const row of rows || []) {
    if (!isOnBankDeposits(row)) continue;
    const dayKey = bankDepositDayOf(row);
    const key = `deposited:${dayKey}`;
    let day = byDay.get(key);
    if (!day) {
      day = { key, dayKey, total: 0, rows: [] };
      byDay.set(key, day);
    }
    day.rows.push(row);
    day.total = sumDepositAmounts(day.rows);
  }
  // Newest day first; "unknown" sorts last.
  const days = Array.from(byDay.values()).sort((a, b) => {
    if (a.dayKey === "unknown") return 1;
    if (b.dayKey === "unknown") return -1;
    return b.dayKey.localeCompare(a.dayKey);
  });
  return { days, total: days.reduce((s, d) => s + d.total, 0) };
}
