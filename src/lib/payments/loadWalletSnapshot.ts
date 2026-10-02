/**
 * WalletOps hero/status loader.
 *
 * Provider sync is preferred. If moov-wallet-sync fails with a setup/transport
 * hint, an already-provisioned environment-aware wallet is still shown.
 * Freedom Adjustment already has a production Moov wallet and transfers —
 * a 409/502 must not relabel that as "Pending setup".
 */

export type WalletSnapshotLoaderWallet = {
  id: string;
  tenant_id: string;
  wallet_type: string;
  name?: string;
  currency?: string;
  available_cents: number;
  pending_cents: number;
  status: string;
  last_synced_at?: string | null;
};

export type WalletSnapshotLoaderResult = {
  wallet: WalletSnapshotLoaderWallet | null;
  ledger: unknown[];
  sub_ledgers: unknown[];
  setup_required?: boolean;
};

export const SETUP_HINTS = [
  "set up your payment account",
  "not active yet",
  "not ready to receive funds",
  "not enabled for this payment provider",
  "payment provider is not enabled",
  "credentials are not configured",
  "balance account",
  "status 409",
  "status 502",
  "returned a non-2xx",
  "edge function returned",
];

export function isSetupError(error: Error): boolean {
  const msg = (error?.message ?? "").toLowerCase();
  return SETUP_HINTS.some((hint) => msg.includes(hint));
}

export async function loadWalletSnapshot(input: {
  tenantId: string;
  walletType?: string;
  tenantMoovEnvironment?: string | null;
  syncWallet: (
    tenantId: string,
    walletType?: string,
    opts?: { force?: boolean },
  ) => Promise<{ wallet: WalletSnapshotLoaderWallet; ledger?: unknown[]; sub_ledgers?: unknown[] }>;
  readWallet: (
    tenantId: string,
    walletType?: string,
    environment?: string | null,
  ) => Promise<WalletSnapshotLoaderWallet | null>;
}): Promise<WalletSnapshotLoaderResult> {
  const walletType = input.walletType ?? "operating";

  try {
    const snapshot = await input.syncWallet(input.tenantId, walletType);
    return {
      wallet: snapshot.wallet,
      ledger: snapshot.ledger ?? [],
      sub_ledgers: snapshot.sub_ledgers ?? [],
      setup_required: false,
    };
  } catch (error) {
    let existing: WalletSnapshotLoaderWallet | null = null;
    try {
      existing = await input.readWallet(input.tenantId, walletType, input.tenantMoovEnvironment);
    } catch {
      existing = null;
    }

    if (existing) {
      return {
        wallet: existing,
        ledger: [],
        sub_ledgers: [],
        setup_required: false,
      };
    }

    if (isSetupError(error as Error)) {
      return {
        wallet: null,
        ledger: [],
        sub_ledgers: [],
        setup_required: true,
      };
    }

    throw error;
  }
}
