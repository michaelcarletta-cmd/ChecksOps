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

/**
 * The key the recipient report groups payments under: the person's or company's name, not
 * the payment's type (owner 2026-11-12: "recipients in payments and financials should track by
 * the name of person or company not by type"). One organization paid as a partner and as a
 * contractor is one recipient. The name is compared the way normalize_org_name compares
 * organization names: case, punctuation, spacing and a trailing LLC / Inc / Corp ... are ignored.
 */
export const recipientNameKey = (name: string | null | undefined): string =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|group|holdings)$/, "")
    .trim();

export interface RecipientTotalRow {
  name: string;
  type: string;
  total: number;
  count: number;
  /** How many of `count` are payroll runs (not editable split rows). */
  payrollCount?: number;
  /** How many of `count` are sends from the Funds tab (payment_transfers legs, not editable split rows). */
  sendCount?: number;
  /** null when nothing was paid in the selected range. */
  last: string | null;
  /** Every type this recipient was paid under, the one with the largest total first (`type` is that one). */
  types?: string[];
  /** The editable split rows behind this recipient, by the exact name and type they were recorded under. */
  splitVariants?: Array<{ name: string; type: string; count: number }>;
}

export interface RecipientPaymentRow {
  name: string;
  type: string;
  amount: number;
  date: string;
  method?: string | null;
}

/**
 * Per-recipient totals of the paid rows: one row per name (recipientNameKey), whatever types the
 * payments were recorded under. The row shows the name most of its payments used and lists its
 * types, largest total first. Largest total first; equal totals by name.
 */
export function recipientTotalsByName(rows: RecipientPaymentRow[]): RecipientTotalRow[] {
  type Acc = RecipientTotalRow & {
    last: string;
    key: string;
    names: Map<string, number>;
    typeTotals: Map<string, number>;
    variants: Map<string, { name: string; type: string; count: number }>;
  };
  const acc = new Map<string, Acc>();
  for (const r of rows ?? []) {
    const key = recipientNameKey(r.name) || `name:${r.name}`;
    const g = acc.get(key) ?? {
      key, name: r.name, type: r.type, total: 0, count: 0, payrollCount: 0, sendCount: 0, last: r.date,
      names: new Map(), typeTotals: new Map(), variants: new Map(),
    };
    g.total += r.amount;
    g.count += 1;
    if (r.method === "payroll") g.payrollCount = (g.payrollCount ?? 0) + 1;
    else if (r.method === "send") g.sendCount = (g.sendCount ?? 0) + 1;
    else {
      const vk = `${r.type}|${r.name}`;
      const v = g.variants.get(vk) ?? { name: r.name, type: r.type, count: 0 };
      v.count += 1;
      g.variants.set(vk, v);
    }
    if (new Date(r.date) > new Date(g.last)) g.last = r.date;
    g.names.set(r.name, (g.names.get(r.name) ?? 0) + 1);
    g.typeTotals.set(r.type, (g.typeTotals.get(r.type) ?? 0) + r.amount);
    acc.set(key, g);
  }
  const byCountThenText = (a: [string, number], b: [string, number]) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return [...acc.values()]
    .map(({ key, names, typeTotals, variants, ...row }) => {
      const types = [...typeTotals.entries()].sort(byCountThenText).map(([t]) => t);
      return {
        ...row,
        name: [...names.entries()].sort(byCountThenText)[0][0],
        type: types[0],
        types,
        splitVariants: [...variants.values()],
      };
    })
    .sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Per-recipient report rows plus every Active Stakeholder not paid in the range
 * (listed with $0), honoring the report's search and type filters. A stakeholder
 * already in the paid rows (same name, whatever the type) is not listed twice.
 */
export function withActiveStakeholders(
  paid: RecipientTotalRow[],
  stakeholders: ActiveStakeholderRecord[] | null | undefined,
  filters: { search?: string; typeFilter?: string } = {},
): RecipientTotalRow[] {
  const out = [...paid];
  const seen = new Set(paid.map((r) => recipientNameKey(r.name)));
  const search = (filters.search ?? "").toLowerCase();
  const typeFilter = filters.typeFilter ?? "all";
  for (const a of activeStakeholders(stakeholders)) {
    // The report names a paid row nickname first, then custname.
    const name = a.nickname ?? a.custname ?? activeStakeholderName(a);
    const type = a.account_type ?? "other";
    const key = recipientNameKey(name);
    if (seen.has(key)) continue;
    if (search && !name.toLowerCase().includes(search)) continue;
    if (typeFilter !== "all" && type !== typeFilter) continue;
    seen.add(key);
    out.push({ name, type, total: 0, count: 0, last: null });
  }
  return out;
}
