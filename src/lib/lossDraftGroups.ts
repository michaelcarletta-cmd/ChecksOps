/*
 * Grouping for the Loss Draft tab's compact list: one header per claim file,
 * then one compact card per loss draft, like the other check tabs.
 * Pure functions, no imports, so they can be unit-tested directly.
 */

export type LossDraftGroupInput = {
  id: string;
  claim_id: string | null;
  claim_number: string | null;
  policyholder_name: string | null;
  payee_line?: string | null;
  escrow_status: string;
  unreleased_amount: number | null;
};

export type LossDraftClaimGroup<T extends LossDraftGroupInput> = {
  key: string;
  claimNumber: string;
  policyholderName: string;
  drafts: T[];
};

/**
 * One group per claim file, in the order the files first appear in `drafts`
 * (so a file whose draft came back from the Mortgage Desk stays on top).
 * A draft without a claim is its own group.
 */
export function groupLossDraftsByClaim<T extends LossDraftGroupInput>(
  drafts: T[],
  insuredFromPayeeLine: (payeeLine: string | null | undefined) => string | null = () => null,
): LossDraftClaimGroup<T>[] {
  const groups = new Map<string, LossDraftClaimGroup<T>>();
  for (const d of drafts) {
    const claimNumber = (d.claim_number ?? "").trim();
    const key = d.claim_id
      ? `claim::${d.claim_id}`
      : claimNumber
        ? `claimno::${claimNumber.toLowerCase()}`
        : `unlinked::${d.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.drafts.push(d);
    } else {
      groups.set(key, {
        key,
        claimNumber: claimNumber || "Unlinked claim",
        policyholderName:
          d.policyholder_name || insuredFromPayeeLine(d.payee_line) || d.payee_line || "Unknown insured",
        drafts: [d],
      });
    }
  }
  return Array.from(groups.values());
}

function money(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The one summary line of a claim file: the draft status(es) and what the lender still holds. */
export function lossDraftGroupDetails(
  drafts: LossDraftGroupInput[],
  statusLabel: (status: string) => string = (s) => s,
): string[] {
  const labels = [...new Set(drafts.map((d) => statusLabel(d.escrow_status)))];
  const status = labels.length <= 2 ? labels.join(", ") : `${labels.length} statuses`;
  const unreleased = drafts.reduce((s, d) => s + (Number(d.unreleased_amount) || 0), 0);
  return [status, `${money(unreleased)} unreleased`];
}
