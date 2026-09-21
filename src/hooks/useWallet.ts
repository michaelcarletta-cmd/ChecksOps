import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { mergeWalletSnapshots, walletIsSynchronized } from "@/lib/payments/walletDisplay";
import { buildWalletActivityFeed, type WalletActivityItem } from "@/lib/payments/walletActivityFeed";
import {
  fundWallet,
  readWalletSnapshot,
  syncWallet,
  type WalletSnapshot,
  type WalletType,
} from "@/lib/payments/wallets";

/**
 * Live view of an organization's balance, its ledger and (for trust balances)
 * its per-matter sub-ledgers. Local environment-scoped rows are the display
 * source; provider sync is GET-only and never required to show a synchronized $0.00.
 */
export function useWallet(walletType: WalletType = "operating") {
  const { tenantId, enabled, environment } = usePaymentProviderEligibility();
  const qc = useQueryClient();
  const key = ["payment-wallet", tenantId, environment, walletType];

  const query = useQuery<WalletSnapshot & { setup_required?: boolean; transfers?: unknown[]; provider_activity?: unknown[]; activity?: WalletActivityItem[] }>({
    queryKey: key,
    enabled: !!tenantId && enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const local = await readWalletSnapshot(tenantId!, walletType);
      try {
        const synced = await syncWallet(tenantId!, walletType);
        const merged = mergeWalletSnapshots(local as any, synced as any);
        const transfers = (merged as any)?.transfers ?? local.transfers;
        const providerActivity = (merged as any)?.provider_activity ?? local.provider_activity ?? [];
        const activity = Array.isArray((merged as any)?.activity) && (merged as any).activity.length > 0
          ? (merged as any).activity
          : buildWalletActivityFeed({
            transfers: transfers ?? [],
            providerActivity,
            ledger: (merged as any)?.ledger ?? local.ledger,
            environment,
          });
        return {
          ...merged,
          wallet: (merged as any).wallet ?? local.wallet,
          transfers,
          provider_activity: providerActivity,
          activity,
          setup_required: false,
        };
      } catch (e) {
        const merged = mergeWalletSnapshots(local as any, null);
        if (walletIsSynchronized((merged as any).wallet) || (local.transfers?.length ?? 0) > 0 || (local.activity?.length ?? 0) > 0) {
          return { ...merged, setup_required: false } as WalletSnapshot & { setup_required: boolean };
        }
        // A balance that simply isn't provisioned yet is an empty state, not
        // an error — the organization just hasn't finished payment setup.
        if (isSetupError(e as Error)) {
          return {
            ...merged,
            wallet: (merged as any).wallet ?? null,
            ledger: local.ledger,
            sub_ledgers: local.sub_ledgers,
            transfers: local.transfers,
            provider_activity: local.provider_activity,
            activity: local.activity,
            setup_required: true,
          } as WalletSnapshot & { setup_required: boolean };
        }
        throw e;
      }
    },
  });

  const fund = useMutation({
    mutationFn: (input: { amountCents: number; description?: string; subLedgerId?: string | null }) =>
      fundWallet({
        tenantId: tenantId!,
        amountCents: input.amountCents,
        walletType,
        description: input.description,
        subLedgerId: input.subLedgerId ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
    },
  });

  return {
    tenantId,
    enabled,
    wallet: query.data?.wallet ?? null,
    ledger: query.data?.ledger ?? [],
    subLedgers: query.data?.sub_ledgers ?? [],
    /** Payment account isn't approved/provisioned yet — show a calm empty state. */
    setupRequired: !!query.data?.setup_required,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    fund,
    transfers: (query.data as any)?.transfers ?? [],
    providerActivity: (query.data as any)?.provider_activity ?? [],
    activity: (query.data as any)?.activity ?? [],
  };
}

const SETUP_HINTS = [
  "Sandbox Moov setup required",
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

function isSetupError(e: Error): boolean {
  const msg = (e?.message ?? "").toLowerCase();
  return SETUP_HINTS.some((hint) => msg.includes(hint));
}

