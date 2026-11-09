/**
 * The "Available operating balance" shown on WalletOps and, for white-label
 * tenants, under the ChecksOps heading on the Checks page. One formatter and
 * one rule, so both places show the same number the same way.
 *
 * Read-only: no provider or API call is made here; callers pass what
 * useWallet("operating") already loaded.
 */

export type OperatingBalanceWallet = {
  available_cents: number;
  status: string;
};

/** WalletOps money format: US dollars, always two decimals ($12,480.35). */
export const formatWalletMoney = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** The WalletOps hero value: the balance, or the reason there is none. */
export function operatingBalanceLabel(input: {
  wallet: OperatingBalanceWallet | null | undefined;
  setupRequired: boolean;
}): string {
  const { wallet, setupRequired } = input;
  if (wallet?.status === "sync_failed") return "Balance unavailable";
  if (wallet) return formatWalletMoney(wallet.available_cents);
  return setupRequired ? "Pending setup" : "Pending sync";
}

/**
 * The Checks page header balance, or null when the header keeps its subtitle.
 * Shown only when WalletOps would show a number: payments are enabled for the
 * tenant (the same gate WalletOps and useWallet use), the wallet has loaded
 * without error, and its last sync did not fail. Loading, errors, no wallet
 * and "Pending ..." states all return null, so no placeholder or wrong value
 * is ever shown in the header.
 */
export function checksHeaderOperatingBalance(input: {
  enabled: boolean;
  isLoading: boolean;
  error: unknown;
  wallet: OperatingBalanceWallet | null | undefined;
}): string | null {
  const { enabled, isLoading, error, wallet } = input;
  if (!enabled || isLoading || error || !wallet) return null;
  if (wallet.status === "sync_failed") return null;
  return formatWalletMoney(wallet.available_cents);
}

export type ChecksHeaderBalanceView =
  | { kind: "pending" }
  | { kind: "amount"; amount: string }
  | { kind: "subtitle" };

/**
 * What the white-label Checks header shows on a page load:
 * - "pending" while the balance can still arrive (the organization, its
 *   provider environment or the wallet itself is still loading), so the old
 *   subtitle never flashes before the amount;
 * - "amount" once WalletOps would show a number;
 * - "subtitle" only when no balance can be shown (payments not enabled for the
 *   tenant, an error, no wallet, or a failed sync).
 */
export function checksHeaderBalanceView(input: {
  tenantId: string | null | undefined;
  enabled: boolean;
  isPending: boolean;
  error: unknown;
  wallet: OperatingBalanceWallet | null | undefined;
}): ChecksHeaderBalanceView {
  const { tenantId, enabled, isPending, error, wallet } = input;
  if (!enabled) return tenantId ? { kind: "subtitle" } : { kind: "pending" };
  if (error) return { kind: "subtitle" };
  const amount = checksHeaderOperatingBalance({ enabled, isLoading: false, error, wallet });
  if (amount) return { kind: "amount", amount };
  return isPending ? { kind: "pending" } : { kind: "subtitle" };
}
