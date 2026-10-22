/**
 * Display-only conversation/thread title (subject) for ChecksOps Messages.
 *
 * The subject is the insured name, never the raw payee line. Sources, in order:
 *   1. check payees typed insured / homeowner / policyholder;
 *   2. the linked case's insured name (check_cases.insured_name via case_id);
 *   3. the linked claim's named insured (claims.policyholder_name via claim_id);
 *   4. untyped payees (OCR stores payee_type 'unknown') whose name is shaped
 *      like a person and carries no company, bank or adjuster wording.
 * Returns null when none apply; callers then show only the check number.
 * Never returns "Unknown". Titles are derived at display time from the linked
 * check, so threads that already exist show the insured name too.
 */

const INSURED_PAYEE_TYPES = new Set(["insured", "homeowner", "policyholder"]);
const UNTYPED_PAYEE_TYPES = new Set(["", "unknown", "other"]);

const BUSINESS_WORDS =
  /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|lp|llp|pllc|n\.?a|bank|bancorp|mortgage|mtg|lending|lender|loans?|financial|finance|savings|credit|union|federal|fsb|trust|trustee|servicing|servicer|insurance|mutual|adjust\w*|public|claims?|roofing|construction|contractors?|contracting|restoration|builders?|services?|group|partners|associates|enterprises|holdings|solutions|isaoa|atima|estate|attorneys?|treasury)\b/i;

export type MessageThreadPayee = {
  payee_name?: string | null;
  payee_type?: string | null;
};

export type MessageThreadTitleSource = {
  payees?: MessageThreadPayee[] | null;
  /** check_cases.insured_name for the check's case_id. */
  caseInsuredName?: string | null;
  /** claims.policyholder_name for the check's claim_id. */
  policyholderName?: string | null;
};

function isInsuredPayeeType(type: string | null | undefined): boolean {
  return INSURED_PAYEE_TYPES.has((type ?? "").toLowerCase().trim());
}

function isUntypedPayeeType(type: string | null | undefined): boolean {
  return UNTYPED_PAYEE_TYPES.has((type ?? "").toLowerCase().trim());
}

function normalizeName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (/^unknown\.?$/i.test(name)) return null;
  return name;
}

function uniqueNames(names: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function lastToken(full: string): string | null {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return parts[parts.length - 1].replace(/[.,]+$/g, "");
}

function givenNames(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.slice(0, -1).join(" ");
}

/** Personal-name shape used only to compress already-selected insured names. */
function looksLikePersonName(name: string): boolean {
  const cleaned = name.trim();
  if (!cleaned || /\d/.test(cleaned)) return false;
  if (/\b(llc|inc\.?|corp\.?|ltd\.?|n\.?a\.?)\b/i.test(cleaned)) return false;
  const words = cleaned.split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Za-z][A-Za-z'.-]*$/.test(w));
}

function splitCoupledNames(value: string): string[] | null {
  const parts = value.split(/\s*(?:&|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  if (!parts.every(looksLikePersonName)) return null;
  return parts;
}

function formatSharedLastName(names: string[]): string | null {
  if (names.length < 2 || !names.every(looksLikePersonName)) return null;
  const lasts = names.map(lastToken);
  const firstLast = lasts[0];
  if (!firstLast || lasts.some((last) => !last || last.toLowerCase() !== firstLast.toLowerCase())) {
    return null;
  }
  return `${names.map(givenNames).join(" & ")} ${firstLast}`;
}

function formatInsuredDisplayNames(names: Array<string | null | undefined>): string | null {
  const unique = uniqueNames(names);
  if (unique.length === 0) return null;

  if (unique.length === 1) {
    const coupled = splitCoupledNames(unique[0]);
    return (coupled && formatSharedLastName(coupled)) || unique[0];
  }

  return formatSharedLastName(unique) || unique.join(" & ");
}

/** An untyped payee name that reads as a person (or a couple), not a business. */
function looksLikeIndividualPayee(name: string | null | undefined): boolean {
  const cleaned = normalizeName(name);
  if (!cleaned || BUSINESS_WORDS.test(cleaned)) return false;
  return looksLikePersonName(cleaned) || splitCoupledNames(cleaned) !== null;
}

/**
 * Returns the Messages thread/conversation title, or null when no insured
 * name is available (callers must not substitute "Unknown" or the payee line).
 */
export function resolveMessageThreadTitle(source: MessageThreadTitleSource): string | null {
  const payees = source.payees ?? [];

  const fromPayees = formatInsuredDisplayNames(
    payees.filter((payee) => isInsuredPayeeType(payee.payee_type)).map((payee) => payee.payee_name),
  );
  if (fromPayees) return fromPayees;

  const fromCase = formatInsuredDisplayNames([source.caseInsuredName]);
  if (fromCase) return fromCase;

  const fromClaim = formatInsuredDisplayNames([source.policyholderName]);
  if (fromClaim) return fromClaim;

  return formatInsuredDisplayNames(
    payees
      .filter((payee) => isUntypedPayeeType(payee.payee_type))
      .map((payee) => payee.payee_name)
      .filter(looksLikeIndividualPayee),
  );
}
