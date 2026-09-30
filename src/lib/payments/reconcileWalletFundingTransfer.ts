/**
 * Idempotent local representation of an EXISTING Moov wallet-funding transfer.
 * Does not POST/PATCH/PUT/DELETE the provider. Does not invent a new transfer.
 *
 * Canonical shape matches moov-wallet-fund:
 *   provider=moov, leg_role=wallet_funding, description default "Balance funding"
 * Source/destination Moov payment-method IDs live in provider_metadata when
 * they are not local payment_provider_methods.id values (same as V2 legs).
 */

export const WALLET_FUNDING_LEG_ROLE = "wallet_funding";

export function normalizeWalletFundingStatus(providerStatus: unknown): string {
  switch (String(providerStatus ?? "").toLowerCase()) {
    case "created":
    case "queued":
      return "submitted";
    case "pending":
      return "pending";
    case "reversed":
      return "returned";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "processing";
  }
}

export type WalletFundingRecoveryInput = {
  tenantId: string;
  environment: "production" | "sandbox";
  amountCents: number;
  providerTransferId: string;
  providerStatus: string;
  description?: string | null;
  sourceAccountId?: string | null;
  localSourcePaymentMethodId?: string | null;
  sourcePaymentMethodId?: string | null;
  destinationPaymentMethodId?: string | null;
  walletId?: string | null;
  createdBy?: string | null;
};

export type WalletFundingLocalRow = {
  tenant_id: string;
  provider: "moov";
  environment: "production" | "sandbox";
  status: string;
  provider_status: string;
  amount_cents: number;
  platform_fee_cents: number;
  net_amount_cents: number;
  speed: "standard";
  description: string;
  source_tenant_account_id: string | null;
  source_payment_method_id: string | null;
  destination_payment_method_id: string | null;
  wallet_id: string | null;
  leg_role: typeof WALLET_FUNDING_LEG_ROLE;
  provider_transfer_id: string;
  provider_metadata: Record<string, unknown>;
  created_by: string | null;
};

export function buildWalletFundingRecoveryRow(input: WalletFundingRecoveryInput): WalletFundingLocalRow {
  const amount = Math.max(0, Math.round(Number(input.amountCents || 0)));
  const status = normalizeWalletFundingStatus(input.providerStatus);
  return {
    tenant_id: input.tenantId,
    provider: "moov",
    environment: input.environment,
    status,
    provider_status: String(input.providerStatus || status),
    amount_cents: amount,
    platform_fee_cents: 0,
    net_amount_cents: amount,
    speed: "standard",
    description: String(input.description || "Balance funding"),
    source_tenant_account_id: input.sourceAccountId || null,
    source_payment_method_id: input.localSourcePaymentMethodId || null,
    destination_payment_method_id: null,
    wallet_id: input.walletId || null,
    leg_role: WALLET_FUNDING_LEG_ROLE,
    provider_transfer_id: input.providerTransferId,
    provider_metadata: {
      source_payment_method_id: input.sourcePaymentMethodId || null,
      destination_payment_method_id: input.destinationPaymentMethodId || null,
      checksops_kind: "wallet_funding",
    },
    created_by: input.createdBy || null,
  };
}

const STATUS_RECONCILE_FIELDS = [
  "status",
  "provider_status",
  "provider_metadata",
  "description",
  "amount_cents",
  "net_amount_cents",
] as const;

export type WalletFundingStoreRow = WalletFundingLocalRow & { id: string };

export type WalletFundingStore = {
  findByProviderTransferId: (providerTransferId: string) => WalletFundingStoreRow | null;
  insert: (row: WalletFundingLocalRow) => WalletFundingStoreRow;
  update: (id: string, patch: Partial<WalletFundingLocalRow>) => WalletFundingStoreRow;
};

/**
 * Find by provider_transfer_id. Insert once if absent. Second call updates
 * only canonical status/metadata fields. Never creates a second row.
 */
export function reconcileWalletFundingTransfer(
  store: WalletFundingStore,
  input: WalletFundingRecoveryInput,
): { action: "insert" | "update"; row: WalletFundingStoreRow } {
  const providerTransferId = String(input.providerTransferId || "").trim();
  if (!providerTransferId) throw new Error("provider_transfer_id is required");
  if (!input.tenantId) throw new Error("tenant_id is required");
  if (Number(input.amountCents) <= 0) throw new Error("amount_cents must be greater than zero");

  const next = buildWalletFundingRecoveryRow({ ...input, providerTransferId });
  const existing = store.findByProviderTransferId(providerTransferId);
  if (existing) {
    if (existing.tenant_id !== input.tenantId) {
      throw new Error("provider_transfer_id belongs to another organization");
    }
    const patch: Partial<WalletFundingLocalRow> = {};
    for (const field of STATUS_RECONCILE_FIELDS) {
      (patch as Record<string, unknown>)[field] = next[field];
    }
    return { action: "update", row: store.update(existing.id, patch) };
  }
  return { action: "insert", row: store.insert(next) };
}

export function createMemoryWalletFundingStore(seed: WalletFundingStoreRow[] = []): WalletFundingStore & {
  rows: WalletFundingStoreRow[];
} {
  const rows = [...seed];
  return {
    rows,
    findByProviderTransferId(providerTransferId: string) {
      return rows.find((row) => row.provider_transfer_id === providerTransferId) || null;
    },
    insert(row) {
      const saved = { ...row, id: `local-${rows.length + 1}` };
      rows.push(saved);
      return saved;
    },
    update(id, patch) {
      const idx = rows.findIndex((row) => row.id === id);
      if (idx < 0) throw new Error("missing row");
      rows[idx] = { ...rows[idx], ...patch };
      return rows[idx];
    },
  };
}
