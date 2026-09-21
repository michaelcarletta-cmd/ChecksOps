/**
 * WalletOps display rules for environment-scoped wallet snapshots.
 * A synchronized zero is a real balance. Only a missing or never-synced
 * wallet stays on "Pending sync".
 */

export const PENDING_SYNC_LABEL = "Pending sync";
export const PENDING_SETUP_LABEL = "Pending setup";
export const BALANCE_UNAVAILABLE_LABEL = "Balance unavailable";

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
