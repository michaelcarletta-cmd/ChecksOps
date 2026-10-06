/**
 * Tenant Payments & Financials accuracy — read/classify/dedupe only.
 *
 * Does not insert transactions, mark splits settled, backfill, or move money.
 * Existing screens keep their layout; this module only classifies existing rows.
 *
 * Profit remains: Received − settled Paid (claim-check cash retained).
 */

type FundsReceivedRpcRow = {
  id?: string | null;
  amount?: number | string | null;
  settled_at?: string | null;
  created_at?: string | null;
  recipient_name?: string | null;
  method?: string | null;
  external_check_number?: string | null;
  sender_name?: string | null;
  check_intake_item_id?: string | null;
  tenant_id?: string | null;
  check_number?: string | null;
  carrier_name?: string | null;
  check_amount?: number | string | null;
  claim_id?: string | null;
};

function asFundsReceivedRows(data: unknown): FundsReceivedRpcRow[] {
  return Array.isArray(data) ? (data as FundsReceivedRpcRow[]) : [];
}

export const EXCLUDED_TRANSFER_LEG_ROLES = new Set([
  "wallet_funding",
  "wallet",
  "facilitator_fee",
  "platform_fee",
]);

const INCOMPLETE_STATUSES = new Set([
  "pending",
  "processing",
  "submitted",
  "queued",
  "created",
  "originated",
  "originating",
  "in_transit",
]);

const SETTLED_STATUSES = new Set([
  "settled",
  "completed",
  "succeeded",
  "success",
]);

const FAILED_OR_VOID_STATUSES = new Set([
  "failed",
  "returned",
  "return",
  "voided",
  "void",
  "cancelled",
  "canceled",
  "reversed",
  "refunded",
  "declined",
]);

export type PaymentDirection = "outgoing" | "incoming";
export type PaymentSource = "disbursement_split" | "funds_received" | "payment_transfer";

export type StakeholderAccountRef = {
  id?: string | null;
  nickname?: string | null;
  custname?: string | null;
  account_type?: string | null;
  chk_acct?: string | null;
  tenant_id?: string | null;
};

export type LedgerPaymentRow = {
  id: string;
  amount: number;
  status: string;
  submitted_at?: string | null;
  settled_at?: string | null;
  completed_at?: string | null;
  returned_at?: string | null;
  return_code?: string | null;
  return_desc?: string | null;
  actum_order_id?: string | null;
  created_at: string;
  method?: string | null;
  recipient_name?: string | null;
  recipient_type?: string | null;
  recipient_tenant_id?: string | null;
  destination_tenant_id?: string | null;
  payer_tenant_id?: string | null;
  external_check_number?: string | null;
  moov_transfer_id?: string | null;
  plaid_transfer_id?: string | null;
  provider_transfer_id?: string | null;
  direction: PaymentDirection;
  source: PaymentSource;
  stakeholder_accounts?: StakeholderAccountRef | null;
  disbursement_batches?: {
    id?: string | null;
    check_amount?: number | null;
    check_intake_item_id?: string | null;
    check_intake_items?: {
      check_number?: string | null;
      carrier_name?: string | null;
      amount?: number | null;
      claim_id?: string | null;
    } | null;
  } | null;
};

export type DateRangeBounds = { from: Date; to: Date } | null;

export type TenantPaymentSources = {
  outgoingSplits?: unknown;
  incomingReceived?: unknown;
  payerTransfers?: unknown;
};

export function normalizeStatus(status: string | null | undefined): string {
  return String(status ?? "").trim().toLowerCase();
}

export function isIncompleteStatus(status: string | null | undefined): boolean {
  return INCOMPLETE_STATUSES.has(normalizeStatus(status));
}

export function isSettledMoneyStatus(status: string | null | undefined): boolean {
  return SETTLED_STATUSES.has(normalizeStatus(status));
}

export function isFailedOrVoidStatus(status: string | null | undefined): boolean {
  return FAILED_OR_VOID_STATUSES.has(normalizeStatus(status));
}

export function normalizeProviderTransferId(value: unknown): string | null {
  const id = String(value ?? "").trim();
  return id.length > 0 ? id : null;
}

export function resolveRecipientTenantId(input: {
  recipient_tenant_id?: string | null;
  destination_tenant_id?: string | null;
  payer_tenant_id?: string | null;
  stakeholder_tenant_id?: string | null;
}): string | null {
  const payer = String(input.payer_tenant_id ?? "").trim();
  const candidates = [
    input.destination_tenant_id,
    input.recipient_tenant_id,
  ];
  for (const raw of candidates) {
    const id = String(raw ?? "").trim();
    if (id && id !== payer) return id;
  }
  const stakeholder = String(input.stakeholder_tenant_id ?? "").trim();
  if (stakeholder && stakeholder !== payer) return stakeholder;
  return null;
}

export function isWalletFunding(row: {
  leg_role?: string | null;
  method?: string | null;
}): boolean {
  const role = normalizeStatus(row.leg_role);
  if (EXCLUDED_TRANSFER_LEG_ROLES.has(role)) return true;
  return normalizeStatus(row.method) === "wallet_funding";
}

export function isSelfDestination(
  tenantId: string,
  row: {
    payer_tenant_id?: string | null;
    destination_tenant_id?: string | null;
    recipient_tenant_id?: string | null;
  },
): boolean {
  const payer = String(row.payer_tenant_id ?? tenantId).trim();
  if (!payer) return false;
  for (const raw of [row.recipient_tenant_id, row.destination_tenant_id]) {
    const dest = String(raw ?? "").trim();
    if (dest && dest === tenantId && dest === payer) return true;
  }
  return false;
}

export function settlementDateIso(row: {
  status?: string | null;
  settled_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  submitted_at?: string | null;
}): string | null {
  if (isSettledMoneyStatus(row.status)) {
    return row.settled_at || row.completed_at || row.created_at || null;
  }
  return row.created_at || row.submitted_at || null;
}

export function inDateRange(iso: string | null | undefined, range: DateRangeBounds): boolean {
  if (!range) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= range.from.getTime() && t <= range.to.getTime();
}

export function filterRowsBySettlementDate<T extends {
  status?: string | null;
  settled_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
}>(rows: T[], range: DateRangeBounds): T[] {
  if (!range) return rows;
  return rows.filter((row) => inDateRange(settlementDateIso(row), range));
}

export function movementDedupeKey(row: {
  id?: string | null;
  source?: string | null;
  moov_transfer_id?: string | null;
  plaid_transfer_id?: string | null;
  provider_transfer_id?: string | null;
}): string {
  const provider =
    normalizeProviderTransferId(row.provider_transfer_id) ||
    normalizeProviderTransferId(row.moov_transfer_id) ||
    normalizeProviderTransferId(row.plaid_transfer_id);
  if (provider) return `provider:${provider}`;
  return `row:${row.source ?? "unknown"}:${row.id ?? ""}`;
}

function sourceRank(source: PaymentSource | string | null | undefined): number {
  if (source === "disbursement_split" || source === "funds_received") return 0;
  return 1;
}

export function preferCanonicalMovement(a: LedgerPaymentRow, b: LedgerPaymentRow): LedgerPaymentRow {
  const rank = sourceRank(a.source) - sourceRank(b.source);
  if (rank !== 0) return rank < 0 ? a : b;
  if (a.source === "funds_received" && b.source === "disbursement_split") return a;
  if (b.source === "funds_received" && a.source === "disbursement_split") return b;
  return a;
}

function movementAliasKeys(row: LedgerPaymentRow): string[] {
  const keys = [movementDedupeKey(row)];
  if (row.id && (row.source === "disbursement_split" || row.source === "funds_received")) {
    keys.push(`split:${row.id}`);
  }
  return keys;
}

export function dedupeFinancialMovements(rows: LedgerPaymentRow[]): LedgerPaymentRow[] {
  const byKey = new Map<string, LedgerPaymentRow>();
  for (const row of rows) {
    const keys = movementAliasKeys(row);
    let current: LedgerPaymentRow | undefined;
    for (const key of keys) current = current ?? byKey.get(key);
    const winner = current ? preferCanonicalMovement(current, row) : row;
    const winnerKeys = new Set([...keys, ...movementAliasKeys(winner)]);
    if (current) {
      for (const [existingKey, existingRow] of byKey) {
        if (existingRow === current) winnerKeys.add(existingKey);
      }
    }
    for (const key of winnerKeys) byKey.set(key, winner);
  }
  return [...new Set(byKey.values())];
}

export function shouldExcludeMovement(tenantId: string, row: LedgerPaymentRow & { leg_role?: string | null; is_facilitator_fee?: boolean | null }): boolean {
  if (isWalletFunding(row)) return true;
  if (row.is_facilitator_fee) return true;
  if (isSelfDestination(tenantId, row)) return true;
  return false;
}

export function computeRetainedProfit(received: number, settledPaid: number): {
  totalIncoming: number;
  totalOutgoing: number;
  profit: number;
} {
  const totalIncoming = Number(received) || 0;
  const totalOutgoing = Number(settledPaid) || 0;
  return {
    totalIncoming,
    totalOutgoing,
    profit: totalIncoming - totalOutgoing,
  };
}

export function sumSettledAmount(rows: Array<{ status?: string | null; amount?: number | string | null }>): number {
  return rows.reduce((sum, row) => {
    if (!isSettledMoneyStatus(row.status)) return sum;
    return sum + Number(row.amount || 0);
  }, 0);
}

export function recipientAggregateKey(row: {
  recipient_tenant_id?: string | null;
  destination_tenant_id?: string | null;
  payer_tenant_id?: string | null;
  stakeholder_accounts?: StakeholderAccountRef | null;
  recipient_name?: string | null;
  recipient_type?: string | null;
}): string {
  const tenantKey = resolveRecipientTenantId({
    recipient_tenant_id: row.recipient_tenant_id,
    destination_tenant_id: row.destination_tenant_id,
    payer_tenant_id: row.payer_tenant_id,
    stakeholder_tenant_id: row.stakeholder_accounts?.tenant_id,
  });
  if (tenantKey) return `tenant:${tenantKey}`;
  const acctId = row.stakeholder_accounts?.id;
  if (acctId) return `acct:${acctId}`;
  const type = row.recipient_type ?? row.stakeholder_accounts?.account_type ?? "other";
  const name = String(row.recipient_name ?? "").trim().toLowerCase();
  if (name) return `ext:${type}|${name}`;
  return `row:${type}|unknown`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function amountOf(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function transferLedgerStatus(status: string | null | undefined): string {
  const normalized = normalizeStatus(status);
  if (SETTLED_STATUSES.has(normalized)) return "settled";
  if (normalized === "returned" || normalized === "return" || normalized === "reversed" || normalized === "refunded") {
    return "returned";
  }
  if (FAILED_OR_VOID_STATUSES.has(normalized)) return "failed";
  if (INCOMPLETE_STATUSES.has(normalized)) return normalized === "pending" ? "pending" : "submitted";
  return normalized || "submitted";
}

export function mapOutgoingSplit(row: unknown, tenantId: string): LedgerPaymentRow | null {
  const r = asRecord(row);
  const id = String(r.id ?? "").trim();
  if (!id) return null;
  const status = String(r.status ?? "");
  if (normalizeStatus(status) === "pending") return null;
  if (isSelfDestination(tenantId, {
    payer_tenant_id: tenantId,
    recipient_tenant_id: r.recipient_tenant_id as string | null,
    destination_tenant_id: r.destination_tenant_id as string | null,
  })) return null;
  const stakeholder = (r.stakeholder_accounts ?? null) as StakeholderAccountRef | null;
  const recipientTenantId = resolveRecipientTenantId({
    recipient_tenant_id: r.recipient_tenant_id as string | null,
    destination_tenant_id: r.destination_tenant_id as string | null,
    payer_tenant_id: tenantId,
    stakeholder_tenant_id: stakeholder?.tenant_id,
  });
  return {
    id,
    amount: amountOf(r.amount),
    status,
    submitted_at: (r.submitted_at as string | null) ?? null,
    settled_at: (r.settled_at as string | null) ?? null,
    returned_at: (r.returned_at as string | null) ?? null,
    return_code: (r.return_code as string | null) ?? null,
    return_desc: (r.return_desc as string | null) ?? null,
    actum_order_id: (r.actum_order_id as string | null) ?? null,
    created_at: String(r.created_at ?? ""),
    method: (r.method as string | null) ?? null,
    recipient_name: (r.recipient_name as string | null) ?? null,
    recipient_type: (r.recipient_type as string | null) ?? null,
    recipient_tenant_id: recipientTenantId,
    payer_tenant_id: tenantId,
    external_check_number: (r.external_check_number as string | null) ?? null,
    moov_transfer_id: normalizeProviderTransferId(r.moov_transfer_id),
    plaid_transfer_id: normalizeProviderTransferId(r.plaid_transfer_id),
    provider_transfer_id:
      normalizeProviderTransferId(r.moov_transfer_id) ||
      normalizeProviderTransferId(r.plaid_transfer_id),
    direction: "outgoing",
    source: "disbursement_split",
    stakeholder_accounts: stakeholder,
    disbursement_batches: (r.disbursement_batches as LedgerPaymentRow["disbursement_batches"]) ?? null,
  };
}

export function mapFundsReceivedRow(row: FundsReceivedRpcRow, tenantId: string): LedgerPaymentRow | null {
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    amount: amountOf(row.amount),
    status: "settled",
    settled_at: row.settled_at ?? null,
    created_at: String(row.created_at ?? row.settled_at ?? ""),
    method: row.method ?? null,
    recipient_name: row.sender_name ?? row.recipient_name ?? null,
    recipient_type: null,
    recipient_tenant_id: tenantId,
    payer_tenant_id: row.tenant_id ?? null,
    external_check_number: row.external_check_number ?? null,
    direction: "incoming",
    source: "funds_received",
    stakeholder_accounts: null,
    disbursement_batches: {
      check_intake_item_id: row.check_intake_item_id ?? null,
      check_intake_items: {
        check_number: row.check_number ?? null,
        carrier_name: row.carrier_name ?? row.sender_name ?? null,
        amount: row.check_amount ?? null,
        claim_id: row.claim_id ?? null,
      },
    },
  };
}

export function mapPayerTransfer(row: unknown, tenantId: string): LedgerPaymentRow | null {
  const r = asRecord(row);
  const id = String(r.id ?? "").trim();
  if (!id) return null;
  const dest = String(r.destination_tenant_id ?? "").trim() || null;
  const mapped: LedgerPaymentRow & { leg_role?: string | null; is_facilitator_fee?: boolean | null } = {
    id,
    amount: Number(r.amount_cents ?? 0) / 100,
    status: transferLedgerStatus(String(r.status ?? r.provider_status ?? "")),
    submitted_at: (r.submitted_at as string | null) ?? null,
    settled_at: (r.completed_at as string | null) ?? null,
    completed_at: (r.completed_at as string | null) ?? null,
    created_at: String(r.created_at ?? ""),
    method: (r.selected_rail as string | null) ?? (r.provider as string | null) ?? null,
    recipient_name: (r.description as string | null) ?? null,
    recipient_type: null,
    recipient_tenant_id: dest && dest !== tenantId ? dest : null,
    destination_tenant_id: dest,
    payer_tenant_id: String(r.tenant_id ?? tenantId),
    provider_transfer_id: normalizeProviderTransferId(r.provider_transfer_id),
    moov_transfer_id: normalizeProviderTransferId(r.provider_transfer_id),
    direction: dest && dest === tenantId && dest !== String(r.tenant_id ?? tenantId) ? "incoming" : "outgoing",
    source: "payment_transfer",
    stakeholder_accounts: null,
    disbursement_batches: r.check_id ? {
      check_intake_item_id: r.check_id as string,
      check_intake_items: {
        claim_id: (r.claim_id as string | null) ?? null,
      },
    } : null,
    leg_role: (r.leg_role as string | null) ?? null,
    is_facilitator_fee: Boolean(r.is_facilitator_fee),
  };
  if (shouldExcludeMovement(tenantId, mapped)) return null;
  if (normalizeStatus(mapped.status) === "pending") return null;
  return mapped;
}

export function buildTenantPaymentLedgerRows(
  sources: TenantPaymentSources,
  tenantId: string,
): LedgerPaymentRow[] {
  const outgoing = (Array.isArray(sources.outgoingSplits) ? sources.outgoingSplits : [])
    .map((row) => mapOutgoingSplit(row, tenantId))
    .filter((row): row is LedgerPaymentRow => !!row);
  const outgoingIds = new Set(outgoing.map((row) => row.id));
  const incoming = asFundsReceivedRows(sources.incomingReceived)
    .map((row) => mapFundsReceivedRow(row, tenantId))
    .filter((row): row is LedgerPaymentRow => !!row && !outgoingIds.has(row.id));
  const transfers = (Array.isArray(sources.payerTransfers) ? sources.payerTransfers : [])
    .map((row) => mapPayerTransfer(row, tenantId))
    .filter((row): row is LedgerPaymentRow => !!row);
  return dedupeFinancialMovements([...outgoing, ...incoming, ...transfers]);
}

export function outgoingSettledRows(rows: LedgerPaymentRow[]): LedgerPaymentRow[] {
  return rows.filter((row) => row.direction === "outgoing" && isSettledMoneyStatus(row.status));
}

export function incomingSettledRows(rows: LedgerPaymentRow[]): LedgerPaymentRow[] {
  return rows.filter((row) => row.direction === "incoming" && isSettledMoneyStatus(row.status));
}

export function ownCheckReceivedTotal(
  checks: Array<{ amount?: number | string | null; status?: string | null }>,
): number {
  return checks.reduce((sum, check) => {
    const status = normalizeStatus(check.status);
    if (status !== "deposited" && status !== "funds_released") return sum;
    return sum + Number(check.amount || 0);
  }, 0);
}

export function revenueTotals(input: {
  ownChecks?: Array<{ amount?: number | string | null; status?: string | null }>;
  movements?: LedgerPaymentRow[];
}): { totalIncoming: number; totalOutgoing: number; profit: number } {
  const received =
    ownCheckReceivedTotal(input.ownChecks ?? []) +
    sumSettledAmount(incomingSettledRows(input.movements ?? []));
  const paid = sumSettledAmount(outgoingSettledRows(input.movements ?? []));
  return computeRetainedProfit(received, paid);
}
