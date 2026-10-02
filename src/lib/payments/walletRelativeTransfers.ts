/**
 * WalletOps wallet-relative read model.
 * Does not create transfers, change V2 collection, or POST to a provider.
 *
 * Pending In / Pending Out count only money that actually enters or leaves
 * THIS tenant's wallet payment method.
 */

export const WALLET_PENDING_STATUSES = new Set([
  "pending",
  "processing",
  "submitted",
  "queued",
  "created",
  "originated",
  "originating",
]);

export const CHECKSOPS_WALLET_PAYMENT_METHOD_IDS = new Set([
  "c70a90f2-9bcc-4084-8263-d5a0fb5d806c",
  "3c3133e7-5489-4af8-9d9a-4b0cf6bad362",
]);

export type WalletRelativeKind = "pending_in" | "pending_out" | "neither";

export type WalletOpsTransferRow = {
  id: string;
  tenant_id?: string | null;
  amount_cents: number;
  status?: string | null;
  provider_status?: string | null;
  description?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  leg_role?: string | null;
  is_facilitator_fee?: boolean | null;
  source_payment_method_id?: string | null;
  destination_payment_method_id?: string | null;
  provider_metadata?: Record<string, unknown> | null;
  provider_transfer_id?: string | null;
  idempotency_key?: string | null;
  wallet_id?: string | null;
};

export type PaymentMethodLabel = {
  id?: string | null;
  tenant_id?: string | null;
  provider_payment_method_id?: string | null;
  last_four?: string | null;
  bank_name?: string | null;
  rail_payment_method_ids?: Record<string, string> | null;
};

export type BillingOccurrenceRow = {
  id: string;
  tenant_id: string;
  amount_cents: number;
  status?: string | null;
  billing_period?: string | null;
  occurrence_kind?: string | null;
  notes?: string | null;
  provider_transfer_id?: string | null;
  created_at?: string | null;
};

const asCents = (value: unknown) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

const statusOf = (row: WalletOpsTransferRow) =>
  String(row.provider_status || row.status || "").toLowerCase();

export const isWalletPendingStatus = (status: string | null | undefined) =>
  WALLET_PENDING_STATUSES.has(String(status || "").toLowerCase());

export function methodIdMap(methods: PaymentMethodLabel[] = []) {
  const map = new Map<string, string>();
  for (const method of methods) {
    const providerId = String(method.provider_payment_method_id || "").trim();
    const localId = String(method.id || "").trim();
    if (providerId) {
      map.set(providerId, providerId);
      if (localId) map.set(localId, providerId);
    }
    const rails = method.rail_payment_method_ids || {};
    for (const railId of Object.values(rails)) {
      if (railId) map.set(String(railId), String(railId));
    }
  }
  return map;
}

function firstId(...values: unknown[]) {
  for (const value of values) {
    const id = String(value || "").trim();
    if (id) return id;
  }
  return "";
}

export function resolveTransferPaymentMethodIds(
  transfer: WalletOpsTransferRow,
  methods: PaymentMethodLabel[] = [],
) {
  const map = methodIdMap(methods);
  const meta = (transfer.provider_metadata || {}) as Record<string, unknown>;
  const rawSource = firstId(
    transfer.source_payment_method_id,
    meta.source_payment_method_id,
    meta.checksops_source_payment_method_id,
  );
  const rawDest = firstId(
    transfer.destination_payment_method_id,
    meta.destination_payment_method_id,
    meta.checksops_destination_payment_method_id,
  );
  return {
    sourcePaymentMethodId: map.get(rawSource) || rawSource,
    destinationPaymentMethodId: map.get(rawDest) || rawDest,
  };
}

export function classifyWalletRelativeTransfer({
  transfer,
  tenantWalletPaymentMethodId,
  tenantWalletPaymentMethodIds = [],
  methods = [],
}: {
  transfer: WalletOpsTransferRow;
  tenantWalletPaymentMethodId?: string | null;
  tenantWalletPaymentMethodIds?: string[];
  methods?: PaymentMethodLabel[];
}) {
  const walletIds = new Set(
    [tenantWalletPaymentMethodId, ...tenantWalletPaymentMethodIds]
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const { sourcePaymentMethodId, destinationPaymentMethodId } =
    resolveTransferPaymentMethodIds(transfer, methods);
  const isWalletSource = walletIds.has(sourcePaymentMethodId);
  const isWalletDestination = walletIds.has(destinationPaymentMethodId);
  const pending = isWalletPendingStatus(statusOf(transfer));
  const amountCents = asCents(transfer.amount_cents);

  let kind: WalletRelativeKind = "neither";
  if (pending && isWalletDestination && !isWalletSource) kind = "pending_in";
  else if (pending && isWalletSource && !isWalletDestination) kind = "pending_out";

  return {
    kind,
    pending,
    isWalletSource,
    isWalletDestination,
    sourcePaymentMethodId,
    destinationPaymentMethodId,
    amountCents,
    pendingInCents: kind === "pending_in" ? amountCents : 0,
    pendingOutCents: kind === "pending_out" ? amountCents : 0,
  };
}

export function dedupeTransfers(transfers: WalletOpsTransferRow[] = []) {
  const seen = new Set<string>();
  const out: WalletOpsTransferRow[] = [];
  for (const row of transfers) {
    const providerId = String(row.provider_transfer_id || "").trim();
    const key = providerId || `local:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function isChecksOpsBillingTransfer(transfer: WalletOpsTransferRow) {
  const meta = (transfer.provider_metadata || {}) as Record<string, unknown>;
  const key = String(transfer.idempotency_key || "");
  const desc = String(transfer.description || "");
  return (
    meta.collection_contract === "tenant-collection-v2"
    || meta.checksops_kind === "monthly_subscription"
    || /^billing-\d{4}-\d{2}-[0-9a-f-]{36}-(wallet|bank)$/i.test(key)
    || /checksops subscription/i.test(desc)
  );
}

export function billingPeriodOf(transfer: WalletOpsTransferRow, occurrence?: BillingOccurrenceRow | null) {
  const meta = (transfer.provider_metadata || {}) as Record<string, unknown>;
  const fromMeta = String(meta.checksops_period || occurrence?.billing_period || "").trim();
  if (fromMeta) return fromMeta;
  const key = String(transfer.idempotency_key || "");
  const match = key.match(/^billing-(\d{4}-\d{2})-/);
  return match?.[1] || null;
}

export function formatPeriodLabel(period: string | null | undefined) {
  const match = String(period || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return period || "ChecksOps billing";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function labelPaymentMethod({
  paymentMethodId,
  tenantWalletPaymentMethodId,
  tenantWalletPaymentMethodIds = [],
  tenantName,
  methods = [],
}: {
  paymentMethodId?: string | null;
  tenantWalletPaymentMethodId?: string | null;
  tenantWalletPaymentMethodIds?: string[];
  tenantName?: string | null;
  methods?: PaymentMethodLabel[];
}) {
  const id = String(paymentMethodId || "").trim();
  if (!id) return "Unknown";
  const walletIds = new Set(
    [tenantWalletPaymentMethodId, ...tenantWalletPaymentMethodIds]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  if (walletIds.has(id)) {
    return `${tenantName || "Organization"} Wallet`;
  }
  if (CHECKSOPS_WALLET_PAYMENT_METHOD_IDS.has(id)) return "ChecksOps";
  const method = methods.find((row) => {
    const ids = [
      row.provider_payment_method_id,
      row.id,
      ...Object.values(row.rail_payment_method_ids || {}),
    ].map((value) => String(value || ""));
    return ids.includes(id);
  });
  if (method?.last_four) {
    const bank = method.bank_name ? String(method.bank_name).replace(/\s+BANK.*$/i, "").trim() : "Bank";
    return `${bank} ••••${method.last_four}`;
  }
  return "Connected account";
}

export function purposeOfTransfer(transfer: WalletOpsTransferRow, classified: { isWalletSource: boolean; isWalletDestination: boolean }) {
  if (isChecksOpsBillingTransfer(transfer)) return "ChecksOps Billing";
  if (classified.isWalletDestination && !classified.isWalletSource) return "Wallet Funding";
  if (classified.isWalletSource && !classified.isWalletDestination) {
    const dest = resolveTransferPaymentMethodIds(transfer).destinationPaymentMethodId;
    if (CHECKSOPS_WALLET_PAYMENT_METHOD_IDS.has(dest)) return "ChecksOps Billing";
    if (/^sweepID:/i.test(String(transfer.description || ""))) return "Automatic payout";
    return "Bank Withdrawal";
  }
  return transfer.description || "Transfer";
}

export type BillingActivity = {
  id: string;
  tenant_id: string;
  period: string | null;
  period_label: string;
  amount_cents: number;
  wallet_cents: number;
  bank_cents: number;
  status: string;
  pending: boolean;
  transfer_ids: string[];
};

export function buildBillingActivity({
  tenantId,
  transfers = [],
  occurrences = [],
  tenantWalletPaymentMethodId,
  methods = [],
}: {
  tenantId: string;
  transfers?: WalletOpsTransferRow[];
  occurrences?: BillingOccurrenceRow[];
  tenantWalletPaymentMethodId?: string | null;
  methods?: PaymentMethodLabel[];
}) {
  const mine = dedupeTransfers(transfers.filter((row) => !row.tenant_id || row.tenant_id === tenantId));
  const groups = new Map<string, BillingActivity>();

  const upsert = (key: string, patch: Partial<BillingActivity> & { id: string; tenant_id: string }) => {
    const current = groups.get(key) || {
      id: patch.id,
      tenant_id: patch.tenant_id,
      period: patch.period ?? null,
      period_label: formatPeriodLabel(patch.period),
      amount_cents: 0,
      wallet_cents: 0,
      bank_cents: 0,
      status: patch.status || "pending",
      pending: false,
      transfer_ids: [],
    };
    groups.set(key, {
      ...current,
      ...patch,
      period_label: formatPeriodLabel(patch.period ?? current.period),
      amount_cents: Math.max(current.amount_cents, patch.amount_cents ?? 0),
      wallet_cents: current.wallet_cents + (patch.wallet_cents ?? 0),
      bank_cents: current.bank_cents + (patch.bank_cents ?? 0),
      pending: current.pending || !!patch.pending,
      transfer_ids: [...new Set([...current.transfer_ids, ...(patch.transfer_ids || [])])],
    });
  };

  for (const occurrence of occurrences) {
    if (occurrence.tenant_id !== tenantId) continue;
    if (occurrence.occurrence_kind && occurrence.occurrence_kind !== "monthly_subscription") continue;
    const period = occurrence.billing_period || null;
    upsert(occurrence.id, {
      id: occurrence.id,
      tenant_id: tenantId,
      period,
      amount_cents: asCents(occurrence.amount_cents),
      status: occurrence.status || "due",
      pending: isWalletPendingStatus(occurrence.status) || ["due", "submitted"].includes(String(occurrence.status || "")),
    });
  }

  for (const transfer of mine) {
    if (!isChecksOpsBillingTransfer(transfer)) continue;
    const classified = classifyWalletRelativeTransfer({
      transfer,
      tenantWalletPaymentMethodId,
      methods,
    });
    const meta = (transfer.provider_metadata || {}) as Record<string, unknown>;
    const obligationId = String(meta.checksops_payment_id || meta.obligation_id || "").trim();
    const period = billingPeriodOf(transfer);
    const key = obligationId || `period:${period || transfer.id}`;
    const walletLeg = classified.isWalletSource || String(meta.checksops_leg || transfer.leg_role || "") === "wallet";
    upsert(key, {
      id: obligationId || transfer.id,
      tenant_id: tenantId,
      period,
      amount_cents: 0,
      wallet_cents: walletLeg ? classified.amountCents : 0,
      bank_cents: walletLeg ? 0 : classified.amountCents,
      status: statusOf(transfer) || "pending",
      pending: classified.pending,
      transfer_ids: [transfer.provider_transfer_id || transfer.id],
    });
  }

  return [...groups.values()].map((row) => {
    const splitTotal = row.wallet_cents + row.bank_cents;
    return {
      ...row,
      amount_cents: row.amount_cents > 0 ? row.amount_cents : splitTotal,
    };
  });
}

export function summarizeWalletOps({
  tenantId,
  tenantWalletPaymentMethodId,
  tenantWalletPaymentMethodIds = [],
  transfers = [],
  methods = [],
  occurrences = [],
  tenantName = "Organization",
}: {
  tenantId: string;
  tenantWalletPaymentMethodId?: string | null;
  tenantWalletPaymentMethodIds?: string[];
  transfers?: WalletOpsTransferRow[];
  methods?: PaymentMethodLabel[];
  occurrences?: BillingOccurrenceRow[];
  tenantName?: string;
}) {
  const scoped = transfers.filter((row) => !row.tenant_id || row.tenant_id === tenantId);
  const unique = dedupeTransfers(scoped);
  const classified = unique.map((transfer) => {
    const relative = classifyWalletRelativeTransfer({
      transfer,
      tenantWalletPaymentMethodId,
      tenantWalletPaymentMethodIds,
      methods,
    });
    return {
      transfer,
      ...relative,
      purpose: purposeOfTransfer(transfer, relative),
      from_label: labelPaymentMethod({
        paymentMethodId: relative.sourcePaymentMethodId,
        tenantWalletPaymentMethodId,
        tenantWalletPaymentMethodIds,
        tenantName,
        methods,
      }),
      to_label: labelPaymentMethod({
        paymentMethodId: relative.destinationPaymentMethodId,
        tenantWalletPaymentMethodId,
        tenantWalletPaymentMethodIds,
        tenantName,
        methods,
      }),
      billing: isChecksOpsBillingTransfer(transfer),
    };
  });

  return {
    pendingInCents: classified.reduce((sum, row) => sum + row.pendingInCents, 0),
    pendingOutCents: classified.reduce((sum, row) => sum + row.pendingOutCents, 0),
    transfers: classified,
    billing: buildBillingActivity({
      tenantId,
      transfers: unique,
      occurrences: occurrences.filter((row) => row.tenant_id === tenantId),
      tenantWalletPaymentMethodId,
      methods,
    }),
  };
}
