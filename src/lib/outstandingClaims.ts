/**
 * Checks "Outstanding" tab (owner 2026-11-17): every claim that still has money outstanding, by the
 * claim ledger's own figure (claimLedgerTotals.ts): expected (the full RCV across all categories plus
 * any expected supplement) minus received (the checks on that claim). A claim stays listed while its
 * balance is above $0, whatever happened to its checks since (deposited, released, disbursed); it
 * leaves when the balance reaches $0. Each row also shows recoverable depreciation and the deductible,
 * and opens the claim's most recent check (the check file and its ledger).
 *
 * Website only: the rows are built from claims, claim_settlements and check_intake_items as the
 * Claim Ledger card reads them. The builders are pure; the Excel and PDF files come from the same
 * writers as the recipient report (payments/recipientReportExport.ts).
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */
import { claimLedgerTotals, type ClaimSettlementAmounts } from "./claimLedgerTotals.ts";
import type { ReportCell, ReportColumn, ReportTable } from "./payments/recipientReportExport.ts";

export interface OutstandingClaimInput {
  id: string;
  claim_number?: string | null;
  policyholder_name?: string | null;
  policyholder_address?: string | null;
}

export type OutstandingSettlementInput = ClaimSettlementAmounts & { claim_id?: string | null };

export interface OutstandingCheckInput {
  id: string;
  claim_id?: string | null;
  amount?: number | string | null;
  check_number?: string | null;
  carrier_name?: string | null;
  issue_date?: string | null;
  status?: string | null;
  check_stage?: string | null;
  created_at?: string | null;
}

export interface OutstandingClaimRow {
  claimId: string;
  claimNumber: string | null;
  policyholderName: string | null;
  policyholderAddress: string | null;
  /** Full RCV plus any expected supplement. */
  expected: number;
  /** The amounts of the checks on the claim. */
  received: number;
  /** Expected minus received; above $0 for every listed row. */
  outstanding: number;
  recoverableDepreciation: number;
  deductible: number;
  checkCount: number;
  /** The claim's most recent check: what a row opens. */
  openCheckId: string;
  openCheckNumber: string | null;
  carrierName: string | null;
}

const centsOf = (value: number) => Math.round(Number(value || 0) * 100);
const text = (value: unknown) => {
  const out = String(value ?? "").trim();
  return out.length ? out : null;
};

/** Newest first by created_at, then issue date, then id (stable). */
const newestFirst = (a: OutstandingCheckInput, b: OutstandingCheckInput) =>
  String(b.created_at || "").localeCompare(String(a.created_at || ""))
  || String(b.issue_date || "").localeCompare(String(a.issue_date || ""))
  || String(b.id).localeCompare(String(a.id));

/**
 * One row per claim that has at least one check and a balance above $0 (compared in whole cents),
 * largest balance first. A claim with no settlement entered expects $0 and is not listed; a check
 * with no claim is ignored; a check row repeated in the input counts once.
 */
export function buildOutstandingClaimRows(input: {
  claims: OutstandingClaimInput[];
  settlements: OutstandingSettlementInput[];
  checks: OutstandingCheckInput[];
}): OutstandingClaimRow[] {
  const claims = new Map<string, OutstandingClaimInput>();
  for (const claim of input.claims || []) if (claim?.id) claims.set(String(claim.id), claim);
  const settlements = new Map<string, OutstandingSettlementInput>();
  for (const settlement of input.settlements || []) {
    // One settlement per claim (the card reads it with maybeSingle); the first one wins.
    if (settlement?.claim_id && !settlements.has(String(settlement.claim_id))) settlements.set(String(settlement.claim_id), settlement);
  }
  const checksByClaim = new Map<string, OutstandingCheckInput[]>();
  const seen = new Set<string>();
  for (const check of input.checks || []) {
    if (!check?.id || !check.claim_id || seen.has(String(check.id))) continue;
    seen.add(String(check.id));
    const list = checksByClaim.get(String(check.claim_id)) ?? [];
    list.push(check);
    checksByClaim.set(String(check.claim_id), list);
  }

  const rows: OutstandingClaimRow[] = [];
  for (const [claimId, checks] of checksByClaim) {
    const totals = claimLedgerTotals(settlements.get(claimId), checks);
    if (centsOf(totals.remaining) <= 0) continue;
    const claim = claims.get(claimId);
    const latest = [...checks].sort(newestFirst)[0];
    rows.push({
      claimId,
      claimNumber: text(claim?.claim_number),
      policyholderName: text(claim?.policyholder_name),
      policyholderAddress: text(claim?.policyholder_address),
      expected: totals.totalExpected,
      received: totals.totalReceived,
      outstanding: totals.remaining,
      recoverableDepreciation: totals.totalRecDep,
      deductible: totals.totalDeductible,
      checkCount: checks.length,
      openCheckId: String(latest.id),
      openCheckNumber: text(latest.check_number),
      carrierName: text(latest.carrier_name),
    });
  }
  return rows.sort((a, b) =>
    centsOf(b.outstanding) - centsOf(a.outstanding)
    || String(a.claimNumber || "").localeCompare(String(b.claimNumber || ""))
    || a.claimId.localeCompare(b.claimId));
}

/** Rows whose claim number, policyholder, address, carrier or a check number contains the search text. */
export function filterOutstandingClaimRows(rows: OutstandingClaimRow[], search: string | null | undefined): OutstandingClaimRow[] {
  const q = String(search ?? "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => [row.claimNumber, row.policyholderName, row.policyholderAddress, row.carrierName, row.openCheckNumber]
    .some((value) => String(value ?? "").toLowerCase().includes(q)));
}

export interface OutstandingTotals {
  count: number;
  expected: number;
  received: number;
  outstanding: number;
  recoverableDepreciation: number;
  deductible: number;
}

/** Column totals of the rows as shown, summed in cents. */
export function outstandingTotals(rows: OutstandingClaimRow[]): OutstandingTotals {
  const sum = (pick: (row: OutstandingClaimRow) => number) => rows.reduce((cents, row) => cents + centsOf(pick(row)), 0) / 100;
  return {
    count: rows.length,
    expected: sum((r) => r.expected),
    received: sum((r) => r.received),
    outstanding: sum((r) => r.outstanding),
    recoverableDepreciation: sum((r) => r.recoverableDepreciation),
    deductible: sum((r) => r.deductible),
  };
}

export const OUTSTANDING_CLAIMS_COLUMNS: ReportColumn[] = [
  { label: "Claim #", width: 18, pdf: 96 },
  { label: "Policyholder", width: 30, pdf: 168 },
  { label: "Checks", width: 8, pdf: 44 },
  { label: "Expected", width: 15, pdf: 84, money: true },
  { label: "Received", width: 15, pdf: 84, money: true },
  { label: "Recoverable Dep.", width: 17, pdf: 84, money: true },
  { label: "Deductible", width: 14, pdf: 68, money: true },
  { label: "Outstanding", width: 15, pdf: 84, money: true },
];

/** The Outstanding list as shown (search applied), with a grand total, for the Excel and PDF writers. */
export function outstandingClaimsTable(input: {
  rows: OutstandingClaimRow[];
  search?: string | null;
  companyName?: string | null;
  /** e.g. "As of 11/17/2026". */
  asOfLabel: string;
  /** Formats a stored name for display (displayCase in the app). */
  displayName?: (value: string) => string;
}): ReportTable {
  const search = String(input.search ?? "").trim();
  const show = input.displayName ?? ((value: string) => value);
  const totals = outstandingTotals(input.rows);
  const join = (...parts: Array<string | null | undefined>) => parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(" – ");
  const rows: ReportCell[][] = input.rows.map((r) => [
    r.claimNumber ?? "",
    r.policyholderName ? show(r.policyholderName) : "",
    r.checkCount,
    r.expected,
    r.received,
    r.recoverableDepreciation,
    r.deductible,
    r.outstanding,
  ]);
  return {
    sheetName: "Outstanding",
    title: join(input.companyName, "Outstanding Claims"),
    subtitle: join("Claims with a balance above $0", search ? `matching "${search}"` : null, input.asOfLabel),
    columns: OUTSTANDING_CLAIMS_COLUMNS,
    rows,
    totals: [[
      `Total (${totals.count} claim${totals.count === 1 ? "" : "s"})`, "", "",
      totals.expected, totals.received, totals.recoverableDepreciation, totals.deductible, totals.outstanding,
    ]],
    note: "Outstanding = expected (full RCV across all categories plus any expected supplement) minus the checks received on the claim.",
  };
}
