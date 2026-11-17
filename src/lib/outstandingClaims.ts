/**
 * Checks "Outstanding" tab (owner 2026-11-17): every claim that still has money outstanding, by the
 * claim ledger's own figure (claimLedgerTotals.ts): expected (the full RCV across all categories plus
 * any expected supplement) minus received (the checks on that claim). A claim stays listed while its
 * balance is above $0, whatever happened to its checks since (deposited, released, disbursed); it
 * leaves when the balance reaches $0. Each row also shows recoverable depreciation and the deductible,
 * and opens the claim's most recent check (the check file and its ledger).
 *
 * Owner 2026-11-17 (after the first production use): a row always names at least one insured. When the
 * claim has no policyholder name, the name comes from the claim's checks, as the Checks lanes do: an
 * insured payee of a check, then the insured read from a check's payee line. And the deductible can be
 * hidden (public adjusters and attorneys do not collect deductibles, only contractors do): the list and
 * its Excel and PDF then leave the deductible out. Owner 2026-11-17, after using it: "When toggling the
 * deductible on and off it should also adjust the outstanding amount". With the deductible off, each claim's
 * expected and outstanding amounts are reduced by its deductible (applyDeductibleChoice): what is still due
 * when nobody collects the deductible. A claim whose balance is then $0 leaves the list. The Claim Ledger
 * card in the check file keeps the ledger's figure.
 *
 * Owner 2026-11-17: "filter outstanding by partners to show which partners, if any, are involved with the
 * outstanding claim check files". A row lists the partner companies any of the claim's checks is actively
 * shared with (shared_checks, not revoked), and the list can be narrowed to one partner, or to claims with
 * no partner.
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
  /** The check's raw payee line (OCR). */
  payee_line?: string | null;
  /** The check's payees (embedded read). */
  check_payees?: Array<{ payee_name?: string | null; payee_type?: string | null }> | null;
}

export interface OutstandingPartner {
  id: string;
  name: string;
}

/** An active share of one of this company's checks with a partner company (shared_checks, revoked_at null). */
export interface OutstandingShareInput {
  check_id?: string | null;
  target_tenant_id?: string | null;
}

/** The partner filter: every claim, claims with no partner, or one partner's claims (its tenant id). */
export const OUTSTANDING_PARTNER_ALL = "all";
export const OUTSTANDING_PARTNER_NONE = "none";

export interface OutstandingClaimRow {
  claimId: string;
  claimNumber: string | null;
  /** The claim's policyholder, or else an insured named on one of its checks; null only when no check names one. */
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
  /** Partner companies any of the claim's checks is actively shared with, by name. */
  partners: OutstandingPartner[];
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
 * At least one insured name for a claim: the claim's policyholder; else an insured payee of one of its checks
 * (newest check first); else the insured read from a check's payee line (insuredNameFromPayeeLine, the Checks
 * page's extractInsuredName). The same order the Checks lanes use.
 */
export function insuredNameForClaim(
  claim: OutstandingClaimInput | null | undefined,
  checksNewestFirst: OutstandingCheckInput[],
  insuredNameFromPayeeLine?: (payeeLine: string | null | undefined) => string | null,
): string | null {
  const fromClaim = text(claim?.policyholder_name);
  if (fromClaim) return fromClaim;
  for (const check of checksNewestFirst) {
    for (const payee of check.check_payees ?? []) {
      if (String(payee?.payee_type ?? "").toLowerCase() === "insured" && text(payee?.payee_name)) return text(payee?.payee_name);
    }
  }
  if (insuredNameFromPayeeLine) {
    for (const check of checksNewestFirst) {
      const parsed = text(insuredNameFromPayeeLine(check.payee_line));
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * One row per claim that has at least one check and a balance above $0 (compared in whole cents),
 * largest balance first. A claim with no settlement entered expects $0 and is not listed; a check
 * with no claim is ignored; a check row repeated in the input counts once.
 */
export function buildOutstandingClaimRows(input: {
  claims: OutstandingClaimInput[];
  settlements: OutstandingSettlementInput[];
  checks: OutstandingCheckInput[];
  /** Reads an insured name out of a check's payee line (the Checks page's extractInsuredName). */
  insuredNameFromPayeeLine?: (payeeLine: string | null | undefined) => string | null;
  /** Active shares of this company's checks with partners. */
  shares?: OutstandingShareInput[];
  /** Partner company names by tenant id (tenants_public). */
  partnerNames?: Array<{ id: string; name?: string | null }>;
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

  const partnerName = new Map<string, string>();
  for (const partner of input.partnerNames || []) if (partner?.id) partnerName.set(String(partner.id), text(partner.name) ?? "Partner");
  const partnersByCheck = new Map<string, Set<string>>();
  for (const share of input.shares || []) {
    if (!share?.check_id || !share.target_tenant_id) continue;
    const set = partnersByCheck.get(String(share.check_id)) ?? new Set<string>();
    set.add(String(share.target_tenant_id));
    partnersByCheck.set(String(share.check_id), set);
  }

  const rows: OutstandingClaimRow[] = [];
  for (const [claimId, checks] of checksByClaim) {
    const totals = claimLedgerTotals(settlements.get(claimId), checks);
    if (centsOf(totals.remaining) <= 0) continue;
    const claim = claims.get(claimId);
    const newest = [...checks].sort(newestFirst);
    const latest = newest[0];
    const partnerIds = new Set<string>();
    for (const check of checks) for (const id of partnersByCheck.get(String(check.id)) ?? []) partnerIds.add(id);
    const partners = [...partnerIds]
      .map((id) => ({ id, name: partnerName.get(id) ?? "Partner" }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    rows.push({
      claimId,
      claimNumber: text(claim?.claim_number),
      policyholderName: insuredNameForClaim(claim, newest, input.insuredNameFromPayeeLine),
      policyholderAddress: text(claim?.policyholder_address),
      expected: totals.totalExpected,
      received: totals.totalReceived,
      outstanding: totals.remaining,
      recoverableDepreciation: totals.totalRecDep,
      deductible: totals.totalDeductible,
      checkCount: checks.length,
      partners,
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

/**
 * The rows with or without the deductible counted. Included (the ledger's figure): unchanged. Not included:
 * expected and outstanding are each reduced by the claim's deductible, never below $0; claims left with no
 * balance (in whole cents) are dropped, and the rest are ordered largest balance first again. The deductible
 * figure itself stays on the row.
 */
export function applyDeductibleChoice(rows: OutstandingClaimRow[], includeDeductible: boolean): OutstandingClaimRow[] {
  if (includeDeductible) return rows;
  return rows
    .map((row) => {
      const expected = Math.max(0, (centsOf(row.expected) - centsOf(row.deductible)) / 100);
      const outstanding = Math.max(0, (centsOf(expected) - centsOf(row.received)) / 100);
      return { ...row, expected, outstanding };
    })
    .filter((row) => centsOf(row.outstanding) > 0)
    .sort((a, b) =>
      centsOf(b.outstanding) - centsOf(a.outstanding)
      || String(a.claimNumber || "").localeCompare(String(b.claimNumber || ""))
      || a.claimId.localeCompare(b.claimId));
}

/** The partners involved in the rows, by name, each with the number of claims it is on. */
export function outstandingPartnerOptions(rows: OutstandingClaimRow[]): Array<OutstandingPartner & { count: number }> {
  const byId = new Map<string, OutstandingPartner & { count: number }>();
  for (const row of rows) {
    for (const partner of row.partners) {
      const entry = byId.get(partner.id) ?? { ...partner, count: 0 };
      entry.count += 1;
      byId.set(partner.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Every row ("all"), rows with no partner ("none"), or rows one partner (its tenant id) is involved in. */
export function filterOutstandingByPartner(rows: OutstandingClaimRow[], partner: string | null | undefined): OutstandingClaimRow[] {
  const value = String(partner ?? "") || OUTSTANDING_PARTNER_ALL;
  if (value === OUTSTANDING_PARTNER_ALL) return rows;
  if (value === OUTSTANDING_PARTNER_NONE) return rows.filter((row) => row.partners.length === 0);
  return rows.filter((row) => row.partners.some((p) => p.id === value));
}

/** Rows whose claim number, policyholder, address, carrier, a check number or a partner name contains the search text. */
export function filterOutstandingClaimRows(rows: OutstandingClaimRow[], search: string | null | undefined): OutstandingClaimRow[] {
  const q = String(search ?? "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => [row.claimNumber, row.policyholderName, row.policyholderAddress, row.carrierName, row.openCheckNumber,
    ...row.partners.map((p) => p.name)]
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
  { label: "Claim #", width: 20, pdf: 104 },
  { label: "Policyholder", width: 30, pdf: 118 },
  { label: "Partner(s)", width: 30, pdf: 120 },
  { label: "Checks", width: 8, pdf: 40 },
  { label: "Expected", width: 15, pdf: 78, money: true },
  { label: "Received", width: 15, pdf: 78, money: true },
  { label: "Recoverable Dep.", width: 17, pdf: 104, money: true },
  { label: "Deductible", width: 14, pdf: 72, money: true },
  { label: "Outstanding", width: 15, pdf: 82, money: true },
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
  /** false leaves the Deductible column out and says so (pass rows from applyDeductibleChoice(rows, false)). Default true. */
  showDeductible?: boolean;
  /** The partner filter as shown, e.g. "Partner: Condition One" or "No partner"; omitted for all partners. */
  partnerFilterLabel?: string | null;
}): ReportTable {
  const search = String(input.search ?? "").trim();
  const show = input.displayName ?? ((value: string) => value);
  const totals = outstandingTotals(input.rows);
  const join = (...parts: Array<string | null | undefined>) => parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(" – ");
  const deductibleAt = OUTSTANDING_CLAIMS_COLUMNS.findIndex((c) => c.label === "Deductible");
  const keep = <T,>(cells: T[]): T[] => (input.showDeductible === false ? cells.filter((_cell, i) => i !== deductibleAt) : cells);
  const rows: ReportCell[][] = input.rows.map((r) => keep<ReportCell>([
    r.claimNumber ?? "",
    r.policyholderName ? show(r.policyholderName) : "Unknown insured",
    r.partners.map((p) => p.name).join(", "),
    r.checkCount,
    r.expected,
    r.received,
    r.recoverableDepreciation,
    r.deductible,
    r.outstanding,
  ]));
  return {
    sheetName: "Outstanding",
    title: join(input.companyName, "Outstanding Claims"),
    subtitle: join("Claims with a balance above $0", input.showDeductible === false ? "deductible not included" : null,
      input.partnerFilterLabel, search ? `matching "${search}"` : null, input.asOfLabel),
    columns: keep(OUTSTANDING_CLAIMS_COLUMNS),
    rows,
    totals: [keep<ReportCell>([
      `Total (${totals.count} claim${totals.count === 1 ? "" : "s"})`, "", "", "",
      totals.expected, totals.received, totals.recoverableDepreciation, totals.deductible, totals.outstanding,
    ])],
    note: input.showDeductible === false
      ? "Outstanding = expected (full RCV across all categories plus any expected supplement, less the deductible) minus the checks received on the claim."
      : "Outstanding = expected (full RCV across all categories plus any expected supplement) minus the checks received on the claim.",
  };
}
