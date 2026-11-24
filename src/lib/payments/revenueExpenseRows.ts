/**
 * Revenue & Profit: the itemised "Expenses" list under Revenue Sources.
 *
 * Owner request 2026-11-05: the Total Paid (Expenses) card counted settled disbursements, paid
 * payroll and payroll speed fees, but nothing on the tab listed them. These rows are exactly the
 * items behind that card, with the same rules, so the list sums to it:
 * - every settled disbursement split the card's query returns (status = settled);
 * - every paid payroll run (submitted / completed, as payrollExpenseTotal);
 * - every paid run's speed fee as its own row (as payrollSpeedFeeExpenseTotal).
 * Pure: no data access; the component passes the rows it already reads.
 */

import { PAYROLL_SOURCE_LABEL, isPayrollPaid, payrollAmount, payrollRecipientName, type PayrollRun } from "./payrollRows.ts";
import { PAYROLL_SPEED_LABELS, isPayrollSpeed, payrollSpeedFee } from "./payrollSpeedFees.ts";

/** The columns the Revenue & Profit split query selects (the display subset of Payment History's select). */
export const REVENUE_EXPENSE_SPLIT_COLUMNS = `
  id, amount, status, settled_at, created_at, method, recipient_name, external_check_number,
  stakeholder_accounts (id, nickname, custname),
  disbursement_batches (id, check_intake_items:check_intake_item_id (check_number))
`;

export const PAYROLL_SPEED_FEE_ROW_LABEL = "Payroll speed fee";

export type ExpenseSplit = {
  id?: string | null;
  amount?: number | string | null;
  status?: string | null;
  settled_at?: string | null;
  created_at?: string | null;
  method?: string | null;
  recipient_name?: string | null;
  external_check_number?: string | null;
  stakeholder_accounts?: { nickname?: string | null; custname?: string | null } | null;
  disbursement_batches?: { check_intake_items?: { check_number?: string | null } | null } | null;
};

// "send": a payment sent from the Funds tab (payment_transfers send legs; transferFinanceRows.ts).
export type RevenueExpenseKind = "disbursement" | "payroll" | "payroll_speed_fee" | "send";

export type RevenueExpenseRow = {
  key: string;
  kind: RevenueExpenseKind;
  at: string | null;
  title: string;
  subtitle: string | null;
  reference: string;
  /** Dollars, positive; the view shows it as "-$x". */
  amount: number;
  status: string;
};

const toAmount = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const time = (at: string | null): number => {
  if (!at) return 0;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** "external_check" -> "External check", "ach" -> "ACH", missing -> "Disbursement". */
export const splitMethodLabel = (method: string | null | undefined): string => {
  const m = String(method ?? "").trim().toLowerCase();
  if (!m) return "Disbursement";
  if (m === "ach" || m === "rtp") return m.toUpperCase();
  const words = m.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function splitRow(split: ExpenseSplit, index: number): RevenueExpenseRow {
  const acct = split.stakeholder_accounts ?? null;
  const claimCheck = split.disbursement_batches?.check_intake_items?.check_number ?? null;
  const external = split.method === "external_check";
  let reference = splitMethodLabel(split.method);
  if (external && split.external_check_number) reference = `Ck #${split.external_check_number}`;
  else if (!external && claimCheck) reference = `Ck #${claimCheck}`;
  return {
    key: `split-${split.id ?? index}`,
    kind: "disbursement",
    at: split.settled_at ?? split.created_at ?? null,
    title: acct?.nickname || acct?.custname || split.recipient_name || "Disbursement",
    subtitle: split.method ? `Disbursement · ${splitMethodLabel(split.method)}` : "Disbursement",
    reference,
    amount: toAmount(split.amount),
    status: "Settled",
  };
}

/**
 * Expense rows, newest first. `splits` are the rows the card's query returned (already
 * filtered to settled); a split in any other status is skipped so the list never counts more
 * than the card. Payroll and speed-fee rows follow payrollExpenseTotal and
 * payrollSpeedFeeExpenseTotal exactly. A run's fee row sorts right after its payroll row.
 */
export function revenueExpenseRows(input: {
  splits?: ExpenseSplit[] | null;
  payrollRuns?: PayrollRun[] | null;
}): RevenueExpenseRow[] {
  const rows: RevenueExpenseRow[] = [];
  (input.splits ?? []).forEach((split, index) => {
    if (String(split.status ?? "").toLowerCase() !== "settled") return;
    rows.push(splitRow(split, index));
  });
  for (const run of input.payrollRuns ?? []) {
    if (!isPayrollPaid(run)) continue;
    const at = run.created_at ?? null;
    const payee = payrollRecipientName(run);
    rows.push({
      key: `payroll-${run.id}`,
      kind: "payroll",
      at,
      title: payee,
      subtitle: run.memo ? `${PAYROLL_SOURCE_LABEL} · ${run.memo}` : PAYROLL_SOURCE_LABEL,
      reference: PAYROLL_SOURCE_LABEL,
      amount: payrollAmount(run),
      status: "Paid",
    });
    const fee = payrollSpeedFee(run.speed);
    if (fee > 0 && isPayrollSpeed(run.speed)) {
      rows.push({
        key: `payroll-fee-${run.id}`,
        kind: "payroll_speed_fee",
        at,
        title: PAYROLL_SPEED_FEE_ROW_LABEL,
        subtitle: `${PAYROLL_SPEED_LABELS[run.speed]} · ${payee}`,
        reference: PAYROLL_SPEED_LABELS[run.speed],
        amount: fee,
        status: "Fee",
      });
    }
  }
  // Array.prototype.sort is stable, so a fee row stays right after its payroll row.
  return rows.sort((a, b) => time(b.at) - time(a.at));
}

/** Sum of the rows in dollars, added in cents so it matches the card to the cent. */
export const revenueExpenseRowsTotal = (rows: RevenueExpenseRow[]): number =>
  rows.reduce((cents, row) => cents + Math.round(row.amount * 100), 0) / 100;
