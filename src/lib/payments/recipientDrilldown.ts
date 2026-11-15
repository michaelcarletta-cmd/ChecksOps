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
 * Client (owner 2026-11-15: "For the recipient report how can we show the exact client name the
 * payment was for."): each row carries the insured/homeowner of the check it was paid from, by the
 * check file's rule (checkClientName). Payroll has no check, so no client.
 *
 * Pure: no data access.
 */

import { extractInsuredName } from "../../features/check-command/status.ts";
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
  /** The client (insured/homeowner) the payment was for, by checkClientName; null when unknown. */
  clientName: string | null;
  /** The check number and claim number on their own, for the search. */
  checkNumber: string | null;
  claimNumber: string | null;
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
  /** The client of the deposited check the split paid from (checkClientName). */
  clientName?: string | null;
  /** The claim number of that check (linked claim, else the detected one). */
  claimNumber?: string | null;
}

/**
 * The check columns the client name and claim number read, for a check_intake_items embed or read:
 * the linked claim (claims:claim_id), the payees (check_payees, a has-many on check_id) and the
 * printed payee line. Embeds the AWS data API resolves (aws/functions/api/data.mjs).
 */
export const CHECK_CLIENT_COLUMNS =
  "claim_id, detected_claim_number, payee_line, claims:claim_id (claim_number, policyholder_name), check_payees (payee_type, payee_name)";

/**
 * The recipient report's disbursement_splits read: the report's columns, the check number the
 * reference shows, and the deposited check's client columns (CHECK_CLIENT_COLUMNS).
 */
export const RECIPIENT_REPORT_SPLIT_SELECT = `
          id, amount, status, method, recipient_name, recipient_type, created_at, settled_at, external_check_number,
          stakeholder_accounts (id, nickname, custname, account_type, chk_acct),
          disbursement_batches (check_intake_items:check_intake_item_id (check_number, ${CHECK_CLIENT_COLUMNS}))
        `;

/** A check as a read or an RPC returns it; every field optional. */
export interface ClientNameCheck {
  /** The linked claim (an embed may return an object or a one-row array). */
  claims?: { claim_number?: string | null; policyholder_name?: string | null } | Array<{ claim_number?: string | null; policyholder_name?: string | null }> | null;
  /** Flat claim columns, as get_tenant_incoming_transfers returns them. */
  policyholder_name?: string | null;
  claim_number?: string | null;
  detected_claim_number?: string | null;
  check_payees?: Array<{ payee_type?: string | null; payee_name?: string | null } | null> | null;
  payee_line?: string | null;
}

const clean = (value: unknown): string | null => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s || null;
};
const linkedClaim = (check: ClientNameCheck) => (Array.isArray(check.claims) ? check.claims[0] : check.claims) ?? null;

/**
 * The client a check was for, by the check file's rule (CheckCommandCenter): the linked claim's
 * policyholder_name, else the check_payees row with payee_type "insured", else the insured parsed
 * from the payee line (extractInsuredName). Null when none of them gives a name.
 */
export function checkClientName(check: ClientNameCheck | null | undefined): string | null {
  if (!check) return null;
  return (
    clean(linkedClaim(check)?.policyholder_name ?? check.policyholder_name)
    || clean((check.check_payees ?? []).find((p) => p?.payee_type === "insured")?.payee_name)
    || clean(extractInsuredName(check.payee_line))
  );
}

/** The check's claim number: the linked claim's, else the one detected on the check. */
export function checkClaimNumber(check: ClientNameCheck | null | undefined): string | null {
  if (!check) return null;
  return clean(linkedClaim(check)?.claim_number ?? check.claim_number) || clean(check.detected_claim_number);
}

const referenceOf = (checkNumber: string | null, claimNumber: string | null): string | null =>
  [checkNumber ? `Ck #${checkNumber}` : null, claimNumber ? `Claim ${claimNumber}` : null].filter(Boolean).join(" · ") || null;

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
    const checkNumber = clean(send ? send.check?.check_number : r.reference);
    const claimNumber = send ? checkClaimNumber(send.check) : clean(r.claimNumber);
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
      reference: referenceOf(checkNumber, claimNumber),
      // Payroll has no check, so no client.
      clientName: method === "payroll" ? null : send ? checkClientName(send.check) : clean(r.clientName),
      checkNumber,
      claimNumber,
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
    const checkNumber = clean(p.check?.check_number);
    const claimNumber = checkClaimNumber(p.check);
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
      reference: referenceOf(checkNumber, claimNumber),
      // get_tenant_incoming_transfers returns policyholder_name and payee_line when the sender
      // shares the check (SQL 144); no check_payees, so the rule's middle step is skipped.
      clientName: checkClientName(p.check),
      checkNumber,
      claimNumber,
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

/**
 * Rows whose client name, check number or claim number contains the query (case-insensitive; a
 * leading "#" and "Ck"/"Claim" prefixes are ignored). An empty query keeps every row.
 */
export function searchTransactions(transactions: RecipientTransaction[], query: string | null | undefined): RecipientTransaction[] {
  const q = lower(query).replace(/^(ck|check|claim)\b\s*/, "").replace(/^#\s*/, "").replace(/\s+/g, " ");
  if (!q) return transactions;
  return transactions.filter((t) =>
    [t.clientName, t.checkNumber, t.claimNumber].some((value) => lower(value).replace(/\s+/g, " ").includes(q)));
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
