/**
 * The Active Stakeholders list from Settings (Banking > Stakeholder Accounts),
 * shared by Settings, Payroll and the Payments & Financials recipient report so
 * all three show the same people.
 *
 * Active means what Settings shows: an is_active stakeholder_accounts row of the
 * tenant that is not the tenant's own bank account (operating, or the
 * provider-connected payment account). The server uses the same rule for
 * Settings writes (write-app-metadata.mjs notTenantBank).
 *
 * Pure functions only (no React, no network) so the rules are unit tested.
 */

/** Columns Settings, Payroll and the recipient report read (one cache entry). */
export const ACTIVE_STAKEHOLDER_COLUMNS =
  "id, nickname, account_type, chk_acct, acct_type, is_primary, is_active, custname, homeowner_name, verification_status, verified_at, verification_recipient_email, origin";

export interface ActiveStakeholderRecord {
  id: string;
  nickname?: string | null;
  custname?: string | null;
  homeowner_name?: string | null;
  account_type?: string | null;
  is_primary?: boolean | null;
  is_active?: boolean | null;
  verification_status?: string | null;
  origin?: string | null;
  [field: string]: unknown;
}

/** A stakeholder Settings lists (not the tenant's own bank account, not removed). */
export const isActiveStakeholder = (a: ActiveStakeholderRecord | null | undefined): boolean =>
  !!a && a.is_active !== false && a.account_type !== "operating" && a.origin !== "provider_connected";

export const activeStakeholders = <T extends ActiveStakeholderRecord>(rows: T[] | null | undefined): T[] =>
  (rows ?? []).filter(isActiveStakeholder);

/** Bank setup finished: the payment server can pay this stakeholder. */
export const PAYABLE_VERIFICATION_STATUSES: ReadonlySet<string> = new Set(["verified", "admin_override"]);

export const isPayableStakeholder = (a: ActiveStakeholderRecord): boolean =>
  PAYABLE_VERIFICATION_STATUSES.has(String(a.verification_status ?? "").toLowerCase());

/** Same name Settings shows for the row. */
export const activeStakeholderName = (a: ActiveStakeholderRecord): string =>
  a.homeowner_name || a.custname || a.nickname || "Stakeholder";

/** The name and type the recipient report groups payments under. */
export const reportRecipientKey = (name: string, type: string) => `${type}|${name}`;

export interface RecipientTotalRow {
  name: string;
  type: string;
  total: number;
  count: number;
  /** null when nothing was paid in the selected range. */
  last: string | null;
}

/**
 * Per-recipient report rows plus every Active Stakeholder not paid in the range
 * (listed with $0), honoring the report's search and type filters. A stakeholder
 * already in the paid rows (same name and type) is not listed twice.
 */
export function withActiveStakeholders(
  paid: RecipientTotalRow[],
  stakeholders: ActiveStakeholderRecord[] | null | undefined,
  filters: { search?: string; typeFilter?: string } = {},
): RecipientTotalRow[] {
  const out = [...paid];
  const seen = new Set(paid.map((r) => reportRecipientKey(r.name, r.type)));
  const search = (filters.search ?? "").toLowerCase();
  const typeFilter = filters.typeFilter ?? "all";
  for (const a of activeStakeholders(stakeholders)) {
    // The report names a paid row nickname first, then custname.
    const name = a.nickname ?? a.custname ?? activeStakeholderName(a);
    const type = a.account_type ?? "other";
    const key = reportRecipientKey(name, type);
    if (seen.has(key)) continue;
    if (search && !name.toLowerCase().includes(search)) continue;
    if (typeFilter !== "all" && type !== typeFilter) continue;
    seen.add(key);
    out.push({ name, type, total: 0, count: 0, last: null });
  }
  return out;
}
