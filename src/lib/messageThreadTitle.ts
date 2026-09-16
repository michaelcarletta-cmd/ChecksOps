/**
 * Display-only conversation/thread title for ChecksOps Messages.
 *
 * Resolves the insured/homeowner name from structured check payee roles or
 * the claim's named insured. Never infers insureds by stripping companies
 * out of the raw payee line. Never returns "Unknown".
 */

const INSURED_PAYEE_TYPES = new Set(["insured", "homeowner", "policyholder"]);

export type MessageThreadPayee = {
  payee_name?: string | null;
  payee_type?: string | null;
};

export type MessageThreadTitleSource = {
  payees?: MessageThreadPayee[] | null;
  policyholderName?: string | null;
  fallbackTitle?: string | null;
};

function isInsuredPayeeType(type: string | null | undefined): boolean {
  return INSURED_PAYEE_TYPES.has((type ?? "").toLowerCase().trim());
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

/**
 * Returns the Messages thread/conversation title, or null when nothing
 * displayable is available (callers must not substitute "Unknown").
 */
export function resolveMessageThreadTitle(source: MessageThreadTitleSource): string | null {
  const insuredPayeeNames = (source.payees ?? [])
    .filter((payee) => isInsuredPayeeType(payee.payee_type))
    .map((payee) => payee.payee_name);

  const fromPayees = formatInsuredDisplayNames(insuredPayeeNames);
  if (fromPayees) return fromPayees;

  const fromClaim = formatInsuredDisplayNames(
    source.policyholderName ? [source.policyholderName] : [],
  );
  if (fromClaim) return fromClaim;

  return normalizeName(source.fallbackTitle);
}
