/**
 * Payroll speed fees: one source for the Run Payroll dialog and the finance reports.
 *
 * The fee is shown to the user when they run payroll (Moov pricing, the same schedule the
 * claim-check disbursement console uses). ChecksOps does not charge or store it: payroll_runs
 * records only `speed` and the payee amount. Revenue & Profit derives the fee from `speed` and
 * counts it as a business expense, never as money paid to the payee.
 */

export type PayrollSpeed = "next_day" | "same_day";

export const PAYROLL_SPEED_FEES: Readonly<Record<PayrollSpeed, number>> = { next_day: 0.75, same_day: 1.0 };

export const PAYROLL_SPEED_LABELS: Readonly<Record<PayrollSpeed, string>> = { next_day: "Next Day", same_day: "Same Day" };

export const PAYROLL_SPEED_FEES_LABEL = "Payroll speed fees";

export const isPayrollSpeed = (speed: unknown): speed is PayrollSpeed =>
  speed === "next_day" || speed === "same_day";

/** The speed fee in dollars for a payroll run's `speed`; 0 for a missing or unknown speed. */
export const payrollSpeedFee = (speed: string | null | undefined): number =>
  isPayrollSpeed(speed) ? PAYROLL_SPEED_FEES[speed] : 0;
