/**
 * Customer-first label for a deposited check in Payments & Financials (owner, 2026-11-06:
 * "recent deposit only shows Travelers, not the customer name so it is hard to track").
 *
 * The customer is the insured, resolved with the same rule as the Messages subject and the
 * Deposited Checks report (resolveMessageThreadTitle): insured-typed payees, the case's insured
 * name, the claim's policyholder, then a person-shaped untyped payee. The carrier moves to the
 * secondary line. When no customer name exists the carrier (then the claim number) is primary,
 * as before.
 */
import { resolveMessageThreadTitle, type MessageThreadPayee } from "./messageThreadTitle.ts";

type ClaimEmbed = { policyholder_name?: string | null; claim_number?: string | null };

export type DepositCustomerSource = {
  case_id?: string | null;
  claims?: ClaimEmbed | ClaimEmbed[] | null;
  check_payees?: MessageThreadPayee[] | null;
};

/** check_intake_items columns/embeds the customer name needs (allowlisted tables only). */
export const DEPOSIT_CUSTOMER_SELECT = "case_id, claims(policyholder_name), check_payees(payee_name, payee_type)";

const clean = (value: unknown) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
};

function claimOf(claims: DepositCustomerSource["claims"]): ClaimEmbed | null {
  if (!claims) return null;
  return Array.isArray(claims) ? claims[0] ?? null : claims;
}

/** The insured / homeowner name for a check, or null when none applies (never "Unknown"). */
export function depositCustomerName(
  check: DepositCustomerSource | null | undefined,
  caseInsuredNames?: Map<string, string | null> | null,
): string | null {
  if (!check) return null;
  return resolveMessageThreadTitle({
    payees: check.check_payees,
    caseInsuredName: check.case_id ? caseInsuredNames?.get(check.case_id) ?? null : null,
    policyholderName: claimOf(check.claims)?.policyholder_name ?? null,
  });
}

export type DepositPartyLabel = { primary: string; secondary: string | null };

/**
 * Primary: the customer name, else the carrier, else the claim number, else "—".
 * Secondary: whatever of carrier and claim number is not already primary, joined with " · ".
 * `formatCarrier` lets callers apply display capitalization to the carrier.
 */
export function depositPartyLabel(input: {
  customerName?: string | null;
  carrierName?: string | null;
  claimNumber?: string | null;
  formatCarrier?: (carrier: string) => string;
}): DepositPartyLabel {
  const customer = clean(input.customerName);
  const rawCarrier = clean(input.carrierName);
  const carrier = rawCarrier ? clean(input.formatCarrier ? input.formatCarrier(rawCarrier) : rawCarrier) : null;
  const claim = clean(input.claimNumber);
  const ordered = [customer, carrier, claim].filter((v): v is string => Boolean(v));
  if (ordered.length === 0) return { primary: "—", secondary: null };
  const [primary, ...rest] = ordered;
  return { primary, secondary: rest.length ? rest.join(" · ") : null };
}

/** Distinct, sorted case ids of the checks (for one check_cases lookup). */
export const depositCaseIds = (checks: Array<DepositCustomerSource | null | undefined>) =>
  Array.from(new Set(checks.map((c) => c?.case_id).filter((id): id is string => Boolean(id)))).sort();
