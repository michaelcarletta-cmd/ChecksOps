/**
 * Sends between organizations in the finance views (owner 2026-11-06: "include partner payments as
 * income not tax. Payment being sent to partners or anyone is an expense for that company and any
 * money coming in is income").
 *
 * A send from the Funds tab (aws/functions/api/providers/production/moov-send.mjs) writes
 * payment_transfers legs (leg_role send_wallet / send_bank) under the SENDER's tenant_id, one leg
 * per funding source (balance, then bank for any shortfall) per recipient. It writes no
 * disbursement_splits row, so Payments & Financials (which reads splits and payroll_runs) counted
 * neither the sender's expense nor the recipient's income. A payroll send writes the same legs
 * (provider_metadata.purpose 'payroll') and a payroll_runs row; payroll is already counted from
 * payroll_runs, so its legs are left out here.
 *
 * Sender: its own legs (RLS lets it read them). A leg counts once Moov accepted it: status
 * submitted, pending, processing or completed (moov-send.mjs ACCEPTED). ready, submitting, unknown,
 * failed, canceled and returned legs are not money paid. Legs of one recipient in one send
 * (provider_metadata request_hash + recipient_index) are one payment.
 *
 * Recipient: the rows get_tenant_incoming_transfers (SQL 144) returns, legs another organization
 * addressed to it. The same accepted statuses are income; returned legs are shown as returned and
 * never counted. Legs of one send share sender, check and created_at (one transaction). Incoming
 * partner payments are income, never 1099 / tax payments.
 *
 * Pure: no data access.
 */

import type { RevenueExpenseRow } from "./revenueExpenseRows.ts";

export const SEND_LEG_ROLES = ["send_wallet", "send_bank"] as const;
/** Statuses Moov accepted: the money left the sender (moov-send.mjs ACCEPTED). */
export const ACCEPTED_SEND_STATUSES = new Set(["submitted", "pending", "processing", "completed"]);
export const SEND_SOURCE_LABEL = "Payment sent";
export const INCOMING_SOURCE_LABEL = "Partner payment";

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
const cents = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const time = (at: string | null | undefined): number => {
  if (!at) return 0;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : 0;
};
const latest = (a: string | null, b: string | null | undefined): string | null => (time(b) > time(a) ? (b as string) : a);

// ---------------------------------------------------------------- sender

export interface SendLeg {
  id: string;
  check_id?: string | null;
  leg_role?: string | null;
  status?: string | null;
  amount_cents?: number | string | null;
  created_at?: string | null;
  submitted_at?: string | null;
  completed_at?: string | null;
  destination_tenant_id?: string | null;
  provider_metadata?: {
    purpose?: string | null;
    request_hash?: string | null;
    recipient_index?: number | string | null;
    recipient_kind?: string | null;
    recipient_id?: string | null;
    recipient_name?: string | null;
  } | null;
  /** The sent check's number and carrier, attached by the reader (not a payment_transfers column). */
  check?: { check_number?: string | null; carrier_name?: string | null } | null;
}

/** The columns a finance view selects for the sender's own send legs. */
export const SEND_LEG_COLUMNS =
  "id, check_id, leg_role, status, amount_cents, created_at, submitted_at, completed_at, destination_tenant_id, provider_metadata";

export const isSendLeg = (leg: Pick<SendLeg, "leg_role"> | null | undefined): boolean =>
  !!leg && (SEND_LEG_ROLES as readonly string[]).includes(String(leg.leg_role ?? ""));

/** A send leg that is money paid out: accepted by Moov, not payroll (payroll_runs counts that). */
export const isPaidSendLeg = (leg: SendLeg | null | undefined): boolean =>
  !!leg && isSendLeg(leg) && ACCEPTED_SEND_STATUSES.has(lower(leg.status)) && lower(leg.provider_metadata?.purpose) !== "payroll";

export interface SentPayment {
  key: string;
  at: string | null;
  checkId: string | null;
  check: { check_number?: string | null; carrier_name?: string | null } | null;
  recipientName: string;
  recipientKind: "partner" | "stakeholder" | "recipient";
  partnerTenantId: string | null;
  amountCents: number;
  /** Every leg completed: settled; otherwise accepted and on its way. */
  completed: boolean;
  sources: Array<"balance" | "bank">;
}

/** The sender's paid sends, one per recipient per send, newest first. */
export function sentPayments(legs: SendLeg[] | null | undefined): SentPayment[] {
  const groups = new Map<string, SentPayment>();
  for (const leg of legs ?? []) {
    if (!isPaidSendLeg(leg)) continue;
    const meta = leg.provider_metadata ?? {};
    const key = meta.request_hash
      ? `${meta.request_hash}|${meta.recipient_index ?? meta.recipient_id ?? ""}`
      : `leg|${leg.id}`;
    const kind = leg.destination_tenant_id || lower(meta.recipient_kind) === "partner"
      ? "partner"
      : lower(meta.recipient_kind) === "stakeholder" ? "stakeholder" : "recipient";
    const at = leg.completed_at || leg.submitted_at || leg.created_at || null;
    const g = groups.get(key) ?? {
      key: `send-${key}`,
      at: null,
      checkId: leg.check_id ?? null,
      check: leg.check ?? null,
      recipientName: String(meta.recipient_name || "").trim() || (kind === "partner" ? "Partner" : "Recipient"),
      recipientKind: kind,
      partnerTenantId: leg.destination_tenant_id ?? (kind === "partner" ? meta.recipient_id ?? null : null),
      amountCents: 0,
      completed: true,
      sources: [],
    };
    g.amountCents += cents(leg.amount_cents);
    g.at = latest(g.at, at);
    g.completed = g.completed && lower(leg.status) === "completed";
    const source = leg.leg_role === "send_bank" ? "bank" : "balance";
    if (!g.sources.includes(source)) g.sources.push(source);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => time(b.at) - time(a.at));
}

/** Revenue & Profit: paid sends are an expense (dollars, counted in cents). */
export function sendExpenseTotal(legs: SendLeg[] | null | undefined): { total: number; count: number } {
  const payments = sentPayments(legs);
  return { total: payments.reduce((sum, p) => sum + p.amountCents, 0) / 100, count: payments.length };
}

const sourceLabel = (p: SentPayment) => (p.sources.length === 2 ? "balance and bank" : p.sources[0] === "bank" ? "bank" : "balance");

/** Revenue & Profit "Expenses" rows for the paid sends, in that list's row shape. */
export function sendExpenseRows(legs: SendLeg[] | null | undefined): RevenueExpenseRow[] {
  return sentPayments(legs).map((p) => {
    const checkNumber = p.check?.check_number ?? null;
    return {
      key: p.key,
      kind: "send" as const,
      at: p.at,
      title: p.recipientName,
      subtitle: `${SEND_SOURCE_LABEL}${p.recipientKind === "partner" ? " to partner" : ""} · from ${sourceLabel(p)}`,
      reference: checkNumber ? `Ck #${checkNumber}` : SEND_SOURCE_LABEL,
      amount: p.amountCents / 100,
      status: p.completed ? "Settled" : "Sent",
    };
  });
}

/** Payment History rows (the split vocabulary the ledger shows): "settled" counts like payroll. */
export interface SendLedgerRow {
  id: string;
  source: "send";
  amount: number;
  status: "settled";
  send_status: "completed" | "in_transit";
  created_at: string;
  settled_at: string | null;
  return_code: null;
  method: "send";
  recipient_name: string;
  recipient_type: string;
  external_check_number: null;
  stakeholder_accounts: null;
  disbursement_batches: { check_intake_items: Record<string, unknown> | null } | null;
}

export function sendLedgerRows(legs: SendLeg[] | null | undefined): SendLedgerRow[] {
  return sentPayments(legs)
    .filter((p) => !!p.at)
    .map((p) => ({
      id: `send:${p.key}`,
      source: "send" as const,
      amount: p.amountCents / 100,
      status: "settled" as const,
      send_status: p.completed ? ("completed" as const) : ("in_transit" as const),
      created_at: p.at as string,
      settled_at: p.completed ? p.at : null,
      return_code: null,
      method: "send" as const,
      recipient_name: p.recipientName,
      recipient_type: p.recipientKind === "partner" ? "partner" : "other",
      external_check_number: null,
      stakeholder_accounts: null,
      disbursement_batches: p.checkId ? { check_intake_items: { id: p.checkId, ...(p.check ?? {}) } } : null,
    }));
}

/** By Recipient rows for the paid sends (same shape as the split and payroll rows there). */
export function sendRecipientReportRows(legs: SendLeg[] | null | undefined) {
  return sentPayments(legs)
    .filter((p) => !!p.at)
    .map((p) => ({
      id: `send:${p.key}`,
      date: p.at as string,
      name: p.recipientName,
      type: p.recipientKind === "partner" ? "partner" : "other",
      acct4: p.recipientKind === "partner" ? "Partner wallet" : "—",
      amount: p.amountCents / 100,
      status: "settled" as const,
      method: "send",
    }));
}

// ---------------------------------------------------------------- recipient

/** One row of get_tenant_incoming_transfers (SQL 144). */
export interface IncomingTransferRow {
  id: string;
  amount_cents?: number | string | null;
  status?: string | null;
  speed?: string | null;
  environment?: string | null;
  leg_role?: string | null;
  created_at?: string | null;
  submitted_at?: string | null;
  completed_at?: string | null;
  check_id?: string | null;
  sender_tenant_id?: string | null;
  sender_name?: string | null;
  check_number?: string | null;
  carrier_name?: string | null;
  property_address?: string | null;
  funds_type?: string | null;
  check_amount?: number | string | null;
  claim_id?: string | null;
  detected_claim_number?: string | null;
  payee_line?: string | null;
  claim_number?: string | null;
  policyholder_name?: string | null;
}

export const INCOMING_TRANSFERS_RPC = "get_tenant_incoming_transfers";

/**
 * Payments other organizations sent into this organization's wallet (SQL 144's
 * get_tenant_incoming_transfers through /data/rpc). Until SQL 144 and the API change are live the
 * call fails: the views then show what they showed before (no rows), never an error.
 */
export async function fetchIncomingTransfers(client: unknown, tenantId: string): Promise<IncomingTransferRow[]> {
  try {
    const { data, error } = await (client as { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> })
      .rpc(INCOMING_TRANSFERS_RPC, { _tenant_id: tenantId });
    if (error || !Array.isArray(data)) return [];
    return data as IncomingTransferRow[];
  } catch {
    return [];
  }
}

export type IncomingStatus = "completed" | "in_transit" | "returned";

export interface IncomingPayment {
  key: string;
  at: string | null;
  createdAt: string | null;
  senderTenantId: string | null;
  senderName: string;
  checkId: string | null;
  check: IncomingTransferRow | null;
  amountCents: number;
  status: IncomingStatus;
  /** Income: accepted and not returned. */
  counted: boolean;
  environment: string | null;
}

/** The recipient's incoming payments, one per sender, check and send (returned legs apart), newest first. */
export function incomingPayments(rows: IncomingTransferRow[] | null | undefined): IncomingPayment[] {
  const groups = new Map<string, IncomingPayment>();
  for (const row of rows ?? []) {
    if (!row?.id) continue;
    const status = lower(row.status);
    const returned = status === "returned";
    if (!returned && !ACCEPTED_SEND_STATUSES.has(status)) continue;
    const key = `${row.sender_tenant_id ?? ""}|${row.check_id ?? ""}|${row.created_at ?? row.id}|${returned ? "returned" : "paid"}`;
    const at = row.completed_at || row.submitted_at || row.created_at || null;
    const g = groups.get(key) ?? {
      key: `incoming-${key}`,
      at: null,
      createdAt: row.created_at ?? null,
      senderTenantId: row.sender_tenant_id ?? null,
      senderName: String(row.sender_name || "").trim() || "Partner",
      checkId: row.check_id ?? null,
      check: row.check_number || row.carrier_name ? row : null,
      amountCents: 0,
      status: returned ? "returned" : "completed",
      counted: !returned,
      environment: row.environment ?? null,
    };
    g.amountCents += cents(row.amount_cents);
    g.at = latest(g.at, at);
    if (!returned && status !== "completed") g.status = "in_transit";
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => time(b.at) - time(a.at));
}

/** Ids of the checks this organization was paid from by a send that was not returned. */
export function receivedCheckIds(rows: IncomingTransferRow[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const p of incomingPayments(rows)) if (p.counted && p.checkId) out.add(p.checkId);
  return out;
}

/** Revenue & Profit: incoming partner payments are income (returned ones are not). */
export function incomingRevenueTotal(rows: IncomingTransferRow[] | null | undefined): { total: number; count: number } {
  const counted = incomingPayments(rows).filter((p) => p.counted);
  return { total: counted.reduce((sum, p) => sum + p.amountCents, 0) / 100, count: counted.length };
}

/** Revenue & Profit "Revenue Sources" rows for incoming partner payments. */
export function incomingRevenueRows(rows: IncomingTransferRow[] | null | undefined) {
  return incomingPayments(rows)
    .filter((p) => p.counted)
    .map((p) => ({
      key: p.key,
      at: p.at,
      title: p.senderName,
      subtitle: p.check?.carrier_name ? `${INCOMING_SOURCE_LABEL} · ${p.check.carrier_name}` : INCOMING_SOURCE_LABEL,
      reference: p.check?.check_number || "—",
      amount: p.amountCents / 100,
      status: p.status === "completed" ? "Received" : "In transit",
    }));
}

export interface IncomingWalletActivityRow {
  key: string;
  at: string;
  title: string;
  subtitle: string;
  status: "completed" | "pending" | "returned";
  amountCents: number;
}

/** Recent Wallet Activity credits: "From <sender>", pending until completed, returned as returned. */
export function incomingWalletActivity(
  rows: IncomingTransferRow[] | null | undefined,
  { environment }: { environment?: string | null } = {},
): IncomingWalletActivityRow[] {
  const out: IncomingWalletActivityRow[] = [];
  for (const p of incomingPayments(rows)) {
    if (environment && p.environment && p.environment !== environment) continue;
    const at = p.at ?? p.createdAt;
    if (!at) continue;
    const check = p.check?.check_number ? ` · Check ${p.check.check_number}` : "";
    out.push({
      key: p.key,
      at,
      title: `From ${p.senderName}`,
      subtitle: `${INCOMING_SOURCE_LABEL}${check}`,
      status: p.status === "completed" ? "completed" : p.status === "returned" ? "returned" : "pending",
      amountCents: p.amountCents,
    });
  }
  return out;
}

/** Funds Received lane rows (the split shape the lane renders), one per incoming payment. */
export function incomingFundsReceivedRows(rows: IncomingTransferRow[] | null | undefined) {
  return incomingPayments(rows).map((p) => ({
    id: p.key,
    amount: p.amountCents / 100,
    settled_at: p.status === "completed" ? p.at : null,
    created_at: p.createdAt,
    recipient_name: null,
    method: "send",
    external_check_number: null,
    tenant_id: p.senderTenantId,
    sender: { name: p.senderName },
    _incomingStatus: p.status,
    // The check opens only when its context came back (the sender shares it with this organization).
    disbursement_batches: {
      check_intake_item_id: p.check ? p.checkId : null,
      check_intake_items: {
        id: p.check ? p.checkId : null,
        check_number: p.check?.check_number ?? null,
        carrier_name: p.check?.carrier_name ?? null,
        property_address: p.check?.property_address ?? null,
        funds_type: p.check?.funds_type ?? null,
        amount: p.check?.check_amount ?? null,
        claim_id: p.check?.claim_id ?? null,
        detected_claim_number: p.check?.detected_claim_number ?? null,
        payee_line: p.check?.payee_line ?? null,
        claims: { claim_number: p.check?.claim_number ?? null, policyholder_name: p.check?.policyholder_name ?? null },
      },
    },
  }));
}

/** Payment History / By Recipient "Received" rows for the recipient. */
export function incomingLedgerRows(rows: IncomingTransferRow[] | null | undefined) {
  return incomingPayments(rows)
    .filter((p) => !!p.at)
    .map((p) => ({
      id: p.key,
      at: p.at as string,
      senderName: p.senderName,
      checkNumber: p.check?.check_number ?? null,
      carrier: p.check?.carrier_name ?? null,
      amount: p.amountCents / 100,
      status: p.status,
      counted: p.counted,
    }));
}

/** Received from, per sender: counted (not returned) payments only, optionally only those `keep` accepts. */
export function incomingBySender(
  rows: IncomingTransferRow[] | null | undefined,
  keep: (payment: IncomingPayment) => boolean = () => true,
) {
  const acc = new Map<string, { name: string; total: number; count: number; last: string | null }>();
  for (const p of incomingPayments(rows)) {
    if (!p.counted || !keep(p)) continue;
    const k = p.senderTenantId ?? p.senderName;
    const v = acc.get(k) ?? { name: p.senderName, total: 0, count: 0, last: null };
    v.total = (Math.round(v.total * 100) + p.amountCents) / 100;
    v.count += 1;
    v.last = latest(v.last, p.at);
    acc.set(k, v);
  }
  return [...acc.values()].sort((a, b) => b.total - a.total);
}
