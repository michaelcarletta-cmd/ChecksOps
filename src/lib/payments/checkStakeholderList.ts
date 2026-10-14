/**
 * One list of who can be paid on a check: saved stakeholders, partners the check
 * is shared with (listed automatically unless removed), and partners chosen in the
 * picker. Also works out how much each of them has been sent on this check.
 *
 * Pure functions only (no React, no network) so both the stakeholder list and the
 * payment screen read the same rows, and the rules are unit tested.
 */

/** Send transfers that never left (anything else counts against the check). */
export const NOT_SENT = new Set(["failed", "canceled", "returned"]);
/** Disbursement batches and splits that never left ChecksOps. */
export const NOT_SENT_BATCH = new Set(["failed", "cancelled"]);
export const NOT_SENT_SPLIT = new Set(["failed", "cancelled", "returned"]);

export type StakeholderRowKind = "stakeholder" | "partner";
/** manual = saved stakeholder on the check; partner_share = check_stakeholders partner row;
 *  shared = live share only; selected = chosen in the picker (nothing written). */
export type StakeholderRowSource = "manual" | "partner_share" | "shared" | "selected";

/** The stakeholder account embedded on a check_stakeholders row (fields this screen reads). */
export interface StakeholderAccountEmbed {
  id?: string | null;
  nickname?: string | null;
  custname?: string | null;
  homeowner_name?: string | null;
  account_type?: string | null;
  is_active?: boolean | null;
  verification_status?: string | null;
  verification_source?: string | null;
  plaid_account_id?: string | null;
  provider_account_id?: string | null;
  [field: string]: unknown;
}

export interface CheckStakeholderRecord {
  id: string;
  added_via?: string | null;
  partner_tenant_id?: string | null;
  stakeholder_account_id?: string | null;
  stakeholder_accounts?: StakeholderAccountEmbed | null;
  partner?: { id?: string; name?: string | null } | null;
}

export interface PartnerRef {
  partner_tenant_id: string;
  partner_name: string;
}

export interface PartnerRemovalRecord {
  id: string;
  partner_tenant_id: string;
}

export interface CheckStakeholderRow {
  /** Same key the payment screen uses for allocations. */
  key: string;
  kind: StakeholderRowKind;
  source: StakeholderRowSource;
  name: string;
  /** check_stakeholders.id when the row is saved on the check. */
  checkStakeholderId: string | null;
  stakeholderAccountId: string | null;
  partnerTenantId: string | null;
  /** Embedded stakeholder account, when readable. */
  account: StakeholderAccountEmbed | null;
  /** The check is currently shared with this partner. */
  sharedLive: boolean;
  selected: boolean;
  status: "active" | "removed";
  removalId: string | null;
}

const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
export const partnerKey = (partnerTenantId: string) => `partner:${lower(partnerTenantId)}`;

export const stakeholderLabel = (acct: StakeholderAccountEmbed | null | undefined) =>
  (acct && (acct.custname || acct.nickname || acct.homeowner_name)) || null;

export function buildCheckStakeholderRows(input: {
  checkStakeholders: CheckStakeholderRecord[];
  sharedPartners: PartnerRef[];
  removals: PartnerRemovalRecord[];
  selectedPartners?: PartnerRef[];
}): CheckStakeholderRow[] {
  const rows: CheckStakeholderRow[] = [];
  const byKey = new Map<string, CheckStakeholderRow>();
  const push = (row: CheckStakeholderRow) => {
    rows.push(row);
    byKey.set(row.key, row);
  };
  const sharedNames = new Map<string, string>();
  for (const p of input.sharedPartners ?? []) {
    if (p?.partner_tenant_id) sharedNames.set(lower(p.partner_tenant_id), p.partner_name);
  }

  for (const s of input.checkStakeholders ?? []) {
    const acct = s.stakeholder_accounts ?? null;
    // An account switched off in Stakeholder Settings is no longer offered.
    if (acct && acct.is_active === false) continue;
    if (s.partner_tenant_id) {
      const key = partnerKey(s.partner_tenant_id);
      const existing = byKey.get(key);
      if (existing) {
        existing.checkStakeholderId ??= s.id;
        continue;
      }
      push({
        key,
        kind: "partner",
        source: "partner_share",
        name: s.partner?.name || sharedNames.get(lower(s.partner_tenant_id)) || "Partner organization",
        checkStakeholderId: s.id,
        stakeholderAccountId: s.stakeholder_account_id ?? null,
        partnerTenantId: lower(s.partner_tenant_id),
        // The partner's own account is not readable here; never shown as ours.
        account: null,
        sharedLive: false,
        selected: false,
        status: "active",
        removalId: null,
      });
      continue;
    }
    const accountId = s.stakeholder_account_id || acct?.id;
    if (!accountId) continue;
    const key = String(accountId);
    if (byKey.has(key)) continue;
    push({
      key,
      kind: "stakeholder",
      source: "manual",
      // Show the row even when the account itself cannot be read.
      name: stakeholderLabel(acct) || "Saved stakeholder",
      checkStakeholderId: s.id,
      stakeholderAccountId: String(accountId),
      partnerTenantId: null,
      account: acct,
      sharedLive: false,
      selected: false,
      status: "active",
      removalId: null,
    });
  }

  for (const p of input.sharedPartners ?? []) {
    if (!p?.partner_tenant_id) continue;
    const key = partnerKey(p.partner_tenant_id);
    const existing = byKey.get(key);
    if (existing) {
      existing.sharedLive = true;
      if (existing.name === "Partner organization" && p.partner_name) existing.name = p.partner_name;
      continue;
    }
    push({
      key,
      kind: "partner",
      source: "shared",
      name: p.partner_name || "Partner organization",
      checkStakeholderId: null,
      stakeholderAccountId: null,
      partnerTenantId: lower(p.partner_tenant_id),
      account: null,
      sharedLive: true,
      selected: false,
      status: "active",
      removalId: null,
    });
  }

  for (const p of input.selectedPartners ?? []) {
    if (!p?.partner_tenant_id) continue;
    const key = partnerKey(p.partner_tenant_id);
    const existing = byKey.get(key);
    if (existing) {
      existing.selected = true;
      continue;
    }
    push({
      key,
      kind: "partner",
      source: "selected",
      name: p.partner_name || "Partner organization",
      checkStakeholderId: null,
      stakeholderAccountId: null,
      partnerTenantId: lower(p.partner_tenant_id),
      account: null,
      sharedLive: false,
      selected: true,
      status: "active",
      removalId: null,
    });
  }

  // A removal only counts while the check is still shared with that partner
  // (sharing again clears it on the server).
  const removalByPartner = new Map<string, string>();
  for (const r of input.removals ?? []) {
    if (r?.partner_tenant_id) removalByPartner.set(lower(r.partner_tenant_id), r.id);
  }
  for (const row of rows) {
    if (row.kind !== "partner" || !row.sharedLive || !row.partnerTenantId) continue;
    const removalId = removalByPartner.get(row.partnerTenantId);
    if (removalId) {
      row.status = "removed";
      row.removalId = removalId;
    }
  }

  return rows;
}

/** Partners removed as stakeholders on this check (lower-case tenant ids). */
export function removedPartnerIds(sharedPartners: PartnerRef[], removals: PartnerRemovalRecord[]): Set<string> {
  const shared = new Set((sharedPartners ?? []).map((p) => lower(p.partner_tenant_id)));
  const out = new Set<string>();
  for (const r of removals ?? []) {
    const id = lower(r?.partner_tenant_id);
    if (id && shared.has(id)) out.add(id);
  }
  return out;
}

export interface SendTransferRecord {
  amount_cents: number | string | null;
  status: string | null;
  destination_tenant_id?: string | null;
  provider_metadata?: { recipient_kind?: string | null; recipient_id?: string | null } | null;
}

export interface DisbursementBatchRecord {
  status?: string | null;
  disbursement_splits?: Array<{ amount: number | string | null; status: string | null; stakeholder_account_id?: string | null }> | null;
}

/**
 * Cents already sent on this check, per row key. Same counting rule as the
 * payment screen's "Already disbursed": sends that did not fail, plus batch splits
 * (pending, submitted, settled) on batches that did not fail.
 */
export function releasedCentsByKey(input: {
  transfers: SendTransferRecord[];
  batches: DisbursementBatchRecord[];
}): Map<string, number> {
  const out = new Map<string, number>();
  const add = (key: string, cents: number) => {
    if (!key || !Number.isFinite(cents) || cents === 0) return;
    out.set(key, (out.get(key) ?? 0) + cents);
  };
  for (const t of input.transfers ?? []) {
    if (NOT_SENT.has(String(t?.status))) continue;
    const cents = Math.round(Number(t.amount_cents) || 0);
    const meta = t.provider_metadata ?? {};
    if (t.destination_tenant_id) add(partnerKey(t.destination_tenant_id), cents);
    else if (meta.recipient_kind === "partner" && meta.recipient_id) add(partnerKey(meta.recipient_id), cents);
    else if (meta.recipient_id) add(lower(meta.recipient_id), cents);
  }
  for (const b of input.batches ?? []) {
    if (NOT_SENT_BATCH.has(String(b?.status))) continue;
    for (const s of b.disbursement_splits ?? []) {
      if (NOT_SENT_SPLIT.has(String(s?.status))) continue;
      if (!s.stakeholder_account_id) continue;
      add(lower(s.stakeholder_account_id), Math.round((Number(s.amount) || 0) * 100));
    }
  }
  return out;
}

/** Released cents for one row (stakeholder ids compared case-insensitively). */
export const releasedForRow = (released: Map<string, number>, row: Pick<CheckStakeholderRow, "key">) =>
  released.get(row.key) ?? released.get(lower(row.key)) ?? 0;

export const formatUsdCents = (cents: number) =>
  `$${((Number(cents) || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Who the payment screen offers for allocation: this check's own payees, then
 * shared and chosen partners not listed yet, minus partners removed as
 * stakeholders on this check.
 */
export function mergeDisbursementPayees<T extends { id: string; partner_tenant_id?: string | null }>(input: {
  ownAccounts: T[];
  sharedPartners: PartnerRef[];
  selectedPartners: PartnerRef[];
  removedPartnerIds: Set<string>;
  makePartner: (p: PartnerRef & { added_via: string }) => T;
}): T[] {
  const removed = input.removedPartnerIds;
  const isRemoved = (id: string | null | undefined) => !!id && removed.has(lower(id));
  const merged = (input.ownAccounts ?? []).filter((a) => !isRemoved(a.partner_tenant_id));
  const partnerRows = [
    ...(input.sharedPartners ?? []).map((p) => ({ ...p, added_via: "partner_share" })),
    ...(input.selectedPartners ?? []).map((p) => ({ ...p, added_via: "partner_selected" })),
  ];
  for (const p of partnerRows) {
    if (isRemoved(p.partner_tenant_id)) continue;
    // A partner already listed (on this check's stakeholders or shared) appears once.
    if (merged.some((a) => lower(a.partner_tenant_id) === lower(p.partner_tenant_id))) continue;
    merged.push(input.makePartner(p));
  }
  return merged;
}
