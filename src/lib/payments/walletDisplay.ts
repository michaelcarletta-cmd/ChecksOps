/**
 * WalletOps display rules for environment-scoped wallet snapshots.
 * A synchronized zero is a real balance. Only a missing or never-synced
 * wallet stays on "Pending sync".
 */

export const PENDING_SYNC_LABEL = "Pending sync";
export const PENDING_SETUP_LABEL = "Pending setup";
export const BALANCE_UNAVAILABLE_LABEL = "Balance unavailable";
export const WALLET_ACTIVE_LABEL = "Balance active";
export const WALLET_NOT_SET_UP_LABEL = "Not set up";

export const WALLET_IN_FLIGHT_STATUSES = [
  "pending",
  "processing",
  "submitted",
  "queued",
  "created",
  "originated",
] as const;

export const formatWalletCents = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const walletIsSynchronized = (wallet: {
  last_synced_at?: string | null;
  synchronized?: boolean | null;
  status?: string | null;
  provider_wallet_id?: string | null;
} | null | undefined) => Boolean(
  wallet
  && (
    wallet.synchronized === true
    || Boolean(wallet.last_synced_at)
    || (wallet.status === "active" && Boolean(wallet.provider_wallet_id))
  ),
);

export const walletIsLinked = (wallet: {
  provider_wallet_id?: string | null;
  last_synced_at?: string | null;
  synchronized?: boolean | null;
  status?: string | null;
} | null | undefined) => Boolean(
  walletIsSynchronized(wallet) || Boolean(wallet?.provider_wallet_id),
);

export const walletBalanceLabel = (
  wallet: {
    available_cents?: number | null;
    status?: string | null;
    last_synced_at?: string | null;
    synchronized?: boolean | null;
    provider_wallet_id?: string | null;
  } | null | undefined,
  {
    loading = false,
    setupRequired = false,
  }: { loading?: boolean; setupRequired?: boolean } = {},
) => {
  if (loading) return "…";
  if (walletIsSynchronized(wallet)) {
    return formatWalletCents(Number(wallet?.available_cents || 0));
  }
  if (wallet?.status === "sync_failed") return BALANCE_UNAVAILABLE_LABEL;
  if (setupRequired) return PENDING_SETUP_LABEL;
  return PENDING_SYNC_LABEL;
};

export const walletOpsHeaderStatus = (
  wallet: {
    status?: string | null;
    last_synced_at?: string | null;
    synchronized?: boolean | null;
    provider_wallet_id?: string | null;
  } | null | undefined,
  {
    setupRequired = false,
    syncFailed = false,
  }: { setupRequired?: boolean; syncFailed?: boolean } = {},
) => {
  if (walletIsLinked(wallet)) return WALLET_ACTIVE_LABEL;
  if (syncFailed) return PENDING_SYNC_LABEL;
  if (setupRequired) return "Setup in progress";
  if (wallet?.status) return wallet.status;
  return WALLET_NOT_SET_UP_LABEL;
};

/**
 * Optional GET-only sync must never blank a valid local wallet.
 * synced.wallet ?? local.wallet
 */
export const mergeWalletSnapshots = <T extends Record<string, unknown>>(
  local: T | null | undefined,
  synced: T | null | undefined,
) => {
  const localWallet = (local as { wallet?: unknown } | null)?.wallet ?? null;
  const syncedWallet = (synced as { wallet?: unknown } | null)?.wallet ?? null;
  const wallet = syncedWallet ?? localWallet;
  if (!synced) {
    return {
      ...(local || {}),
      wallet,
      setup_required: false,
    } as T & { wallet: unknown; setup_required: boolean };
  }
  const localTransfers = (local as { transfers?: unknown[] } | null)?.transfers;
  const syncedTransfers = (synced as { transfers?: unknown[] } | null)?.transfers;
  const localActivity = (local as { activity?: unknown[]; provider_activity?: unknown[] } | null);
  const syncedActivity = (synced as { activity?: unknown[]; provider_activity?: unknown[] } | null);
  const transfers = syncedTransfers ?? localTransfers ?? [];
  const providerActivity = syncedActivity?.provider_activity ?? localActivity?.provider_activity ?? [];
  const activity = Array.isArray(syncedActivity?.activity) && syncedActivity.activity.length > 0
    ? syncedActivity.activity
    : (localActivity?.activity ?? []);
  return {
    ...(local || {}),
    ...synced,
    wallet,
    transfers,
    provider_activity: providerActivity,
    activity,
    setup_required: false,
  } as T & { wallet: unknown; setup_required: boolean };
};

export const walletTransferIsInFlight = (row: {
  status?: string | null;
  provider_status?: string | null;
} = {}) => {
  const status = String(row.status || "").toLowerCase();
  const provider = String(row.provider_status || "").toLowerCase();
  return (WALLET_IN_FLIGHT_STATUSES as readonly string[]).includes(status)
    || (WALLET_IN_FLIGHT_STATUSES as readonly string[]).includes(provider)
    || provider.includes("originated");
};

export const walletOpsPendingCents = (
  transfers: Array<{
    amount_cents?: number | null;
    status?: string | null;
    provider_status?: string | null;
    leg_role?: string | null;
  }> = [],
) => {
  const inFlight = (transfers || []).filter(walletTransferIsInFlight);
  return {
    pendingOutCents: inFlight
      .filter((row) => row.leg_role !== "funding" && row.leg_role !== "wallet_funding")
      .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0),
    pendingInCents: inFlight
      .filter((row) => row.leg_role === "funding" || row.leg_role === "wallet_funding")
      .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0),
  };
};

export const walletActivityTitle = (row: {
  leg_role?: string | null;
  is_facilitator_fee?: boolean | null;
  description?: string | null;
} = {}) => {
  if (row.is_facilitator_fee) return "Processing fee";
  const role = String(row.leg_role || "").toLowerCase();
  if (role === "wallet_funding" || role === "funding") return "Money In";
  if (role === "wallet_disbursement" || role === "payout" || role === "disbursement") {
    return "Money Out";
  }
  return row.description || "Wallet transfer";
};

export const walletOpsDisplayStatus = (row: {
  status?: string | null;
  provider_status?: string | null;
} = {}) => {
  const provider = String(row.provider_status || "");
  if (provider.toLowerCase().includes("originated")) return "originated";
  return row.status || provider || "unknown";
};
