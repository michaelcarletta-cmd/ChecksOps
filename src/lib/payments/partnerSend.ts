/**
 * A partner sends onward from a check shared with it (owner 2026-11-12: "a partner paid from a shared
 * check sends onward from it, and that payment is the partner's own Funds Released").
 *
 * The send route (aws/functions/api/providers/production/moov-send.mjs) accepts a check the owner
 * shares with the sender right now, pays from the sender's own balance (then its bank), and writes
 * the legs under the sender's tenant_id. It checks every recipient again: a stakeholder account of
 * the sender (organization-owned or payee, verified, Moov bank), a partner organization of the
 * sender (active partnership), or a vendor payee of the sender (wallet only).
 *
 * The partner cannot add payees to a check it does not own (check_stakeholders insert needs the
 * check's tenant), so its payees come from its own lists, not the check's.
 *
 * What a partner may send from the check is what it received on it and has not sent on yet: only
 * money that arrived (a completed incoming send, or a settled payment recorded to it), never money
 * still in transit, minus its own send legs on the check that are not failed, canceled or returned.
 */
import type { IncomingTransferRow } from "./transferFinanceRows.ts";
import type { SendRecipient } from "./sends.ts";

export interface OwnSendLegLike {
  leg_role?: string | null;
  status?: string | null;
  amount_cents?: number | string | null;
}

const SEND_ROLES = new Set(["send_wallet", "send_bank"]);
const NOT_SENT = new Set(["failed", "canceled", "cancelled", "returned"]);
const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const cents = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Cents this organization received on the check by sends that completed (not in transit, not returned). */
export function completedIncomingCents(rows: IncomingTransferRow[] | null | undefined, checkId: string): number {
  let total = 0;
  for (const row of rows ?? []) {
    if (!row || String(row.check_id ?? "") !== checkId) continue;
    if (lower(row.status) !== "completed") continue;
    total += cents(row.amount_cents);
  }
  return total;
}

/** Cents this organization has sent (or is sending) on the check: its own send legs that did not fail or come back. */
export function ownSentCents(legs: OwnSendLegLike[] | null | undefined): number {
  let total = 0;
  for (const leg of legs ?? []) {
    if (!leg || !SEND_ROLES.has(lower(leg.leg_role))) continue;
    if (NOT_SENT.has(lower(leg.status))) continue;
    total += cents(leg.amount_cents);
  }
  return total;
}

/** What the partner can still send from the check, in cents. */
export function partnerSendAvailableCents(input: {
  incoming: IncomingTransferRow[] | null | undefined;
  checkId: string;
  /** Settled payments recorded to this organization on the check (claim_check_payments, disbursement splits), in cents. */
  settledRecordedCents?: number;
  ownLegs: OwnSendLegLike[] | null | undefined;
}): number {
  const received = completedIncomingCents(input.incoming, input.checkId) + cents(input.settledRecordedCents);
  return Math.max(0, received - ownSentCents(input.ownLegs));
}

export type PartnerPayeeKind = "stakeholder" | "partner" | "vendor";

export interface PartnerPayee {
  key: string;
  kind: PartnerPayeeKind;
  id: string;
  name: string;
  detail: string;
}

export interface StakeholderAccountLike {
  id: string;
  nickname?: string | null;
  custname?: string | null;
  is_active?: boolean | null;
  origin?: string | null;
  is_partner_payout?: boolean | null;
  verification_status?: string | null;
  provider?: string | null;
  provider_account_id?: string | null;
  provider_bank_account_id?: string | null;
  provider_bank_name?: string | null;
  provider_last_four?: string | null;
}

export interface PartnershipLike {
  inviter_tenant_id?: string | null;
  invitee_tenant_id?: string | null;
  status?: string | null;
  revoked_at?: string | null;
}

export interface VendorPayeeLike {
  vendor_tenant_id: string;
  vendor_name?: string | null;
  vendor_active?: boolean | null;
}

/** The send route pays these stakeholder origins (moov-send.mjs PAYABLE_STAKEHOLDER_ORIGINS). */
const PAYABLE_ORIGINS = new Set(["tenant_owned", "provider_recipient"]);

/** A stakeholder account the send route would pay: active, payable origin, verified, Moov account and bank. */
export function isPayableStakeholder(a: StakeholderAccountLike | null | undefined): boolean {
  if (!a?.id || a.is_active === false || a.is_partner_payout === true) return false;
  if (a.origin && !PAYABLE_ORIGINS.has(a.origin)) return false;
  if (!["verified", "admin_override"].includes(lower(a.verification_status))) return false;
  return lower(a.provider) === "moov" && !!a.provider_account_id && !!a.provider_bank_account_id;
}

/**
 * The payees a partner can choose for a send from a shared check: its own payable stakeholder
 * accounts, its active partner organizations (the sharing organization included) and its active
 * vendor payees. Never itself. Sorted by name within each group; partners first.
 */
export function partnerPayeeOptions(input: {
  tenantId: string;
  stakeholders?: StakeholderAccountLike[] | null;
  partnerships?: PartnershipLike[] | null;
  partnerNames?: Map<string, string> | null;
  vendors?: VendorPayeeLike[] | null;
  showVendors?: boolean;
}): PartnerPayee[] {
  const self = lower(input.tenantId);
  const byName = (a: PartnerPayee, b: PartnerPayee) => a.name.localeCompare(b.name);

  const partners = new Map<string, PartnerPayee>();
  for (const p of input.partnerships ?? []) {
    if (!p || lower(p.status) !== "active" || p.revoked_at) continue;
    const inviter = lower(p.inviter_tenant_id);
    const invitee = lower(p.invitee_tenant_id);
    if (inviter !== self && invitee !== self) continue;
    const other = inviter === self ? invitee : inviter;
    if (!other || other === self || partners.has(other)) continue;
    // partnerNames is keyed by lower-case tenant id.
    const name = input.partnerNames?.get(other) || "Partner organization";
    partners.set(other, { key: `partner:${other}`, kind: "partner", id: other, name, detail: "Partner organization" });
  }

  const stakeholders: PartnerPayee[] = [];
  const seenStakeholders = new Set<string>();
  for (const a of input.stakeholders ?? []) {
    if (!isPayableStakeholder(a) || seenStakeholders.has(a.id)) continue;
    seenStakeholders.add(a.id);
    const bank = a.provider_last_four ? `${a.provider_bank_name || "Bank"} ••${a.provider_last_four}` : "Bank verified";
    stakeholders.push({
      key: `stakeholder:${a.id}`,
      kind: "stakeholder",
      id: a.id,
      name: String(a.custname || a.nickname || "Stakeholder").trim() || "Stakeholder",
      detail: bank,
    });
  }

  const vendors: PartnerPayee[] = [];
  if (input.showVendors) {
    const seenVendors = new Set<string>();
    for (const v of input.vendors ?? []) {
      const id = lower(v?.vendor_tenant_id);
      if (!id || id === self || v.vendor_active === false || seenVendors.has(id) || partners.has(id)) continue;
      seenVendors.add(id);
      vendors.push({ key: `vendor:${id}`, kind: "vendor", id, name: v.vendor_name || "Vendor", detail: "Vendor wallet" });
    }
  }

  return [...[...partners.values()].sort(byName), ...stakeholders.sort(byName), ...vendors.sort(byName)];
}

/** The send route's recipient for a chosen payee. */
export function partnerSendRecipient(payee: Pick<PartnerPayee, "kind" | "id">, amountCents: number): SendRecipient {
  if (payee.kind === "partner") return { kind: "partner", partner_tenant_id: payee.id, amount_cents: amountCents };
  if (payee.kind === "vendor") return { kind: "vendor", vendor_tenant_id: payee.id, amount_cents: amountCents };
  return { kind: "stakeholder", stakeholder_account_id: payee.id, amount_cents: amountCents };
}

/** Dollars typed in the amount box to whole cents; anything not a positive amount is 0. */
export function dollarsInputToCents(raw: string | null | undefined): number {
  const text = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(text) || text === "" || text === ".") return 0;
  return Math.round(Number(text) * 100);
}
