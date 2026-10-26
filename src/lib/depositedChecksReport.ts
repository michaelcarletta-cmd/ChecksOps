/**
 * Deposited Checks report (owner, 2026-10-26): every deposited check with the insured name, the
 * date deposited, the amount, the check number and the claim number when there is one, viewable
 * on screen and exportable as PDF or Excel.
 *
 * Insured name follows the Messages subject rule (resolveMessageThreadTitle): insured-typed
 * payees, then the case's insured name, then the claim's policyholder, then a person-shaped
 * untyped payee. Claim number: the linked claim's number, else the number read from the check.
 */
import { resolveMessageThreadTitle, type MessageThreadPayee } from "./messageThreadTitle.ts";
import { bankDepositDayInRange, localDayKey } from "./bankDepositGroups.ts";

type ClaimEmbed = { claim_number?: string | null; policyholder_name?: string | null };

export type DepositedCheckSource = {
  id: string;
  check_number?: string | null;
  amount?: number | string | null;
  deposited_at?: string | null;
  detected_claim_number?: string | null;
  freedom_claim_number?: string | null;
  case_id?: string | null;
  claims?: ClaimEmbed | ClaimEmbed[] | null;
  check_payees?: MessageThreadPayee[] | null;
};

export type DepositedCheckRow = {
  id: string;
  insuredName: string;
  depositedOn: string;
  amount: number;
  checkNumber: string;
  claimNumber: string;
};

export const DEPOSITED_CHECKS_COLUMNS = ["Insured Name", "Date Deposited", "Amount", "Check #", "Claim #"] as const;

const text = (value: unknown) => String(value ?? "").trim();

function claimOf(claims: DepositedCheckSource["claims"]): ClaimEmbed | null {
  if (!claims) return null;
  return Array.isArray(claims) ? claims[0] ?? null : claims;
}

/** Report rows, newest deposit first; checks without a deposit date are left out. */
export function buildDepositedCheckRows(
  checks: DepositedCheckSource[],
  caseInsuredNames: Map<string, string | null> = new Map(),
  from = "",
  to = "",
): DepositedCheckRow[] {
  const rows: DepositedCheckRow[] = [];
  for (const check of checks || []) {
    const depositedOn = localDayKey(check.deposited_at);
    if (depositedOn === "unknown" || !bankDepositDayInRange(depositedOn, from, to)) continue;
    const claim = claimOf(check.claims);
    rows.push({
      id: check.id,
      insuredName:
        resolveMessageThreadTitle({
          payees: check.check_payees,
          caseInsuredName: check.case_id ? caseInsuredNames.get(check.case_id) : null,
          policyholderName: claim?.policyholder_name,
        }) ?? "",
      depositedOn,
      amount: Number(check.amount ?? 0) || 0,
      checkNumber: text(check.check_number),
      claimNumber: text(claim?.claim_number) || text(check.detected_claim_number) || text(check.freedom_claim_number),
    });
  }
  return rows.sort((a, b) => b.depositedOn.localeCompare(a.depositedOn) || a.checkNumber.localeCompare(b.checkNumber));
}

export const depositedChecksTotal = (rows: DepositedCheckRow[]) =>
  Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;

/** MM/DD/YYYY for a YYYY-MM-DD day key. */
export const formatReportDay = (day: string) => {
  const [y, m, d] = day.split("-");
  return y && m && d ? `${m}/${d}/${y}` : day;
};

export const formatReportMoney = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Spreadsheet rows: header, one row per check (amount stays a number), then the total. */
export function depositedChecksSheetRows(rows: DepositedCheckRow[]): (string | number)[][] {
  return [
    [...DEPOSITED_CHECKS_COLUMNS],
    ...rows.map((r) => [r.insuredName, formatReportDay(r.depositedOn), r.amount, r.checkNumber, r.claimNumber]),
    ["Total", "", depositedChecksTotal(rows), `${rows.length} check${rows.length === 1 ? "" : "s"}`, ""],
  ];
}

/** Report title for a date selection. */
export function depositedChecksTitle(from = "", to = ""): string {
  const a = from.trim();
  const b = to.trim();
  if (!a && !b) return "Deposited Checks";
  if (a && !b) return `Deposited Checks – ${formatReportDay(a)}`;
  if (!a) return `Deposited Checks through ${formatReportDay(b)}`;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return `Deposited Checks – ${formatReportDay(lo)} to ${formatReportDay(hi)}`;
}
