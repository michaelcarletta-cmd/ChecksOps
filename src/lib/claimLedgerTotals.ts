/**
 * The claim ledger's own totals, in one place: the Claim Ledger card (ClaimLedgerCard.tsx) and the
 * Checks "Outstanding" tab (outstandingClaims.ts) read the same figures.
 *
 * Expected funds = the full RCV across every category (dwelling, other structures, Ordinance & Law,
 * personal property, ALE) plus any expected supplement. Deductible and non-recoverable or withheld
 * amounts are shown in the breakdown but do not reduce the target: otherwise a claim can look fully
 * funded while money is still outstanding. Received = the amounts of the checks on the claim.
 * Remaining = expected minus received, never below $0.
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */
import { fundsReceivedFromScopedIntakeRows } from "./claimLedgerSync.ts";

/** The claim_settlements columns the totals read (numbers, numeric strings or null). */
export type ClaimSettlementAmounts = Partial<Record<
  | "replacement_cost_value" | "recoverable_depreciation" | "deductible"
  | "other_structures_rcv" | "other_structures_recoverable_depreciation" | "other_structures_deductible"
  | "pwi_rcv" | "pwi_recoverable_depreciation"
  | "personal_property_rcv" | "personal_property_recoverable_depreciation"
  | "ale_rcv" | "ale_recoverable_depreciation"
  | "supplement_expected",
  number | string | null
>>;

export interface ClaimLedgerExpected {
  /** Full RCV across every category. */
  totalRcv: number;
  /** Recoverable depreciation across every category. */
  totalRecDep: number;
  /** Dwelling plus other structures deductible. */
  totalDeductible: number;
  /** totalRcv plus the expected supplement. */
  totalExpected: number;
}

const n = (value: unknown) => Number(value || 0);

export function claimLedgerExpected(settlement: ClaimSettlementAmounts | null | undefined): ClaimLedgerExpected {
  const s = settlement || {};
  const totalRecDep =
    n(s.recoverable_depreciation)
    + n(s.other_structures_recoverable_depreciation)
    + n(s.pwi_recoverable_depreciation)
    + n(s.personal_property_recoverable_depreciation)
    + n(s.ale_recoverable_depreciation);
  const totalRcv =
    n(s.replacement_cost_value)
    + n(s.other_structures_rcv)
    + n(s.pwi_rcv)
    + n(s.personal_property_rcv)
    + n(s.ale_rcv);
  const totalDeductible =
    n(s.deductible)
    + n(s.other_structures_deductible);
  const totalExpected = totalRcv + n(s.supplement_expected);
  return { totalRcv, totalRecDep, totalDeductible, totalExpected };
}

/** Expected minus received, never below $0. */
export const claimLedgerRemaining = (totalExpected: number, totalReceived: number) =>
  Math.max(0, totalExpected - totalReceived);

export interface ClaimLedgerTotals extends ClaimLedgerExpected {
  totalReceived: number;
  remaining: number;
}

/** The ledger's totals for one claim: its settlement and the checks already scoped to that claim. */
export function claimLedgerTotals(
  settlement: ClaimSettlementAmounts | null | undefined,
  claimChecks: Array<{ amount?: number | string | null }> = [],
): ClaimLedgerTotals {
  const expected = claimLedgerExpected(settlement);
  const totalReceived = fundsReceivedFromScopedIntakeRows(claimChecks as Array<{ amount?: number | null }>);
  return { ...expected, totalReceived, remaining: claimLedgerRemaining(expected.totalExpected, totalReceived) };
}
