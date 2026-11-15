/**
 * Per-recipient drill-down for Payments & Financials > Per-Recipient Detail (owner 2026-11-15:
 * "In recipient report, I want to be able to click the recipient and the system shows me every
 * transaction between the tenant and that recipient, filter between sent and received.").
 *
 * Built from rows the report already loads, nothing new is read:
 *  - Sent: the report's normalized rows (disbursement_splits, payroll_runs, sends from
 *    sendRecipientReportRows), grouped under the same recipientNameKey as the report's row.
 *  - Received: incoming partner payments (get_tenant_incoming_transfers rows) from the same
 *    organization, matched by the same name key.
 *  - Organization id: a partner or vendor send records the receiving organization
 *    (destination_tenant_id) and an incoming payment records the sending one (sender_tenant_id).
 *    Every organization id seen on a row matched by name also matches rows recorded under another
 *    name (a renamed organization, or a Moov account name such as "Condition One Commrecial").
 *
 * Totals count what the report counts: sent rows with status settled, received payments that were
 * not returned. Other rows (failed, returned, submitted) are listed with their status, not totaled.
 *
 * Pure: no data access.
 */

import { recipientNameKey } from "./activeStakeholders.ts";
import { incomingPayments, sentPayments, type IncomingTransferRow, type SendLeg } from "./transferFinanceRows.ts";

export type DrilldownDirection = "sent" | "received";
export type DrilldownFilter = "all" | DrilldownDirection;

export interface RecipientTransaction {
  id: string;
  date: string;
  direction: DrilldownDirection;
  /** The name the row was recorded under. */
  name: string;
  amount: number;
  /** split method, "payroll", "send" or "partner_wallet" (received). */
  method: string;
  /** ACH, External check, Wire, Manual payment, Payroll, Partner wallet, Vendor wallet, Wallet send. */
  methodLabel: string;
  status: string;
  statusLabel: string;
  /** Check number and/or claim number when the data has one. */
  reference: string | null;
  /** The other organization's tenant id, when the row records one. */
  orgId: string | null;
  /** Counted in the totals (the report's rule). */
  counted: boolean;
}

/** A row of the report's normalized list, with the optional fields the drill-down reads. */
export interface ReportSentRow {
  id: string;
  date: string | null;
  name: string;
  type?: string | null;
  amount: number;
  status: string;
  method?: string | null;
  acct4?: string | null;
  /** disbursement_splits.external_check_number, or the batch's check number. */
  reference?: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  ach: "ACH",
  actum: "ACH",
  plaid: "ACH",
  external_check: "External check",
  wire: "Wire",
  manual: "Manual payment",
  payroll: "Payroll",
  send: "Wallet send",
  partner_wallet: "Partner wallet",
};

const STATUS_LABELS: Record<string, string> = {
  settled: "Settled",
  completed: "Received",
  submitted: "Submitted",
  processing: "Processing",
  in_transit: "In transit",
  returned: "Returned",
  failed: "Failed",
  cancelled: "Cancelled",
  canceled: "Cancelled",
};

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
const time = (at: string | null | undefined): number => {
  const t = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
};
const titleCase = (value: string) => value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const drilldownMethodLabel = (method: string | null | undefined): string => {
  const m = lower(method) || "ach";
  return METHOD_LABELS[m] ?? titleCase(m);
};

export const drilldownStatusLabel = (status: string | null | undefined): string => {
  const s = lower(status);
  return STATUS_LABELS[s] ?? (s ? titleCase(s) : "—");
};

const sendKey = (id: string) => id.replace(/^send:/, "");

/**
 * Sent transactions from the report's normalized rows. `legs` (the same send legs the report read)
 * adds what sendRecipientReportRows leaves out: the receiving organization, the check number and
 * whether the send completed. Rows without a date are left out.
 */
export function sentTransactions(rows: ReportSentRow[] | null | undefined, legs?: SendLeg[] | null): RecipientTransaction[] {
  const sends = new Map(sentPayments(legs).map((p) => [p.key, p]));
  const out: RecipientTransaction[] = [];
  for (const r of rows ?? []) {
    if (!r?.date) continue;
    const method = lower(r.method) || "ach";
    const send = method === "send" ? sends.get(sendKey(r.id)) : undefined;
    const wallet = send?.recipientKind === "partner" ? "Partner wallet" : send?.recipientKind === "vendor" ? "Vendor wallet" : "Wallet send";
    const status = send ? (send.completed ? "settled" : "in_transit") : lower(r.status);
    const checkNumber = send?.check?.check_number ?? null;
    out.push({
      id: r.id,
      date: r.date,
      direction: "sent",
      name: r.name,
      amount: Number(r.amount ?? 0),
      method,
      methodLabel: method === "send" ? wallet : drilldownMethodLabel(method),
      status,
      statusLabel: drilldownStatusLabel(status),
      reference: send ? (checkNumber ? `Ck #${checkNumber}` : null) : r.reference ? `Ck #${r.reference}` : null,
      orgId: send && (send.recipientKind === "partner" || send.recipientKind === "vendor") ? send.partnerTenantId : null,
      // The report counts settled rows; a send it lists is counted (accepted by Moov).
      counted: method === "send" ? true : lower(r.status) === "settled",
    });
  }
  return out;
}

/** Received transactions: incoming partner payments, returned ones listed but not counted. */
export function receivedTransactions(
  rows: IncomingTransferRow[] | null | undefined,
  keep: (at: string) => boolean = () => true,
): RecipientTransaction[] {
  const out: RecipientTransaction[] = [];
  for (const p of incomingPayments(rows)) {
    const at = p.at ?? p.createdAt;
    if (!at || !keep(at)) continue;
    const check = p.check?.check_number ? `Ck #${p.check.check_number}` : null;
    const claimNumber = p.check?.claim_number || p.check?.detected_claim_number || null;
    const claim = claimNumber ? `Claim ${claimNumber}` : null;
    out.push({
      id: p.key,
      date: at,
      direction: "received",
      name: p.senderName,
      amount: p.amountCents / 100,
      method: "partner_wallet",
      methodLabel: METHOD_LABELS.partner_wallet,
      status: p.status,
      statusLabel: drilldownStatusLabel(p.status),
      reference: [check, claim].filter(Boolean).join(" · ") || null,
      orgId: p.senderTenantId,
      counted: p.counted,
    });
  }
  return out;
}

/**
 * Every transaction with one recipient: rows whose name has the recipient's recipientNameKey, plus
 * rows recorded under another name whose organization id is one of the ids the name-matched rows
 * carry (one step, not transitive). Newest first.
 */
export function recipientTransactions(name: string, transactions: RecipientTransaction[]): RecipientTransaction[] {
  const key = recipientNameKey(name) || `name:${name}`;
  const keyOf = (t: RecipientTransaction) => recipientNameKey(t.name) || `name:${t.name}`;
  const byName = transactions.filter((t) => keyOf(t) === key);
  const orgIds = new Set(byName.map((t) => lower(t.orgId)).filter(Boolean));
  const matched = transactions.filter((t) => keyOf(t) === key || (!!t.orgId && orgIds.has(lower(t.orgId))));
  return [...matched].sort((a, b) => time(b.date) - time(a.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const filterByDirection = (transactions: RecipientTransaction[], filter: DrilldownFilter): RecipientTransaction[] =>
  filter === "all" ? transactions : transactions.filter((t) => t.direction === filter);

export interface DrilldownTotals {
  sent: { total: number; count: number };
  received: { total: number; count: number };
  /** received - sent. */
  net: number;
  /** Every listed row, counted or not. */
  rows: { all: number; sent: number; received: number };
}

/** Totals in cents, then dollars, so 0.1 + 0.2 stays 0.3. */
export function drilldownTotals(transactions: RecipientTransaction[]): DrilldownTotals {
  const cents = { sent: 0, received: 0 };
  const counts = { sent: 0, received: 0 };
  const rows = { all: 0, sent: 0, received: 0 };
  for (const t of transactions) {
    rows.all += 1;
    rows[t.direction] += 1;
    if (!t.counted) continue;
    cents[t.direction] += Math.round(Number(t.amount || 0) * 100);
    counts[t.direction] += 1;
  }
  return {
    sent: { total: cents.sent / 100, count: counts.sent },
    received: { total: cents.received / 100, count: counts.received },
    net: (cents.received - cents.sent) / 100,
    rows,
  };
}
