import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import {
  fundWallet,
  syncWallet,
  type WalletSnapshot,
  type WalletType,
} from "@/lib/payments/wallets";

/**
 * Live view of an organization's balance, its ledger and (for trust balances)
 * its per-matter sub-ledgers.
 */
export function useWallet(walletType: WalletType = "operating") {
  const { tenantId, enabled } = usePaymentProviderEligibility();
  const qc = useQueryClient();
  const key = ["payment-wallet", tenantId, walletType];

  const query = useQuery<WalletSnapshot & { setup_required?: boolean }>({
    queryKey: key,
    enabled: !!tenantId && enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      try {
        return await syncWallet(tenantId!, walletType);
      } catch (e) {
        // A balance that simply isn't provisioned yet is an empty state, not
        // an error — the organization just hasn't finished payment setup.
        if (isSetupError(e as Error)) {
          return {
            wallet: null as any,
            ledger: [],
            sub_ledgers: [],
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

  const refresh = useMutation({
    mutationFn: () => {
      if (!tenantId) throw new Error("Organization isn't loaded yet. Try again in a moment.");
      return syncWallet(tenantId, walletType, { force: true });
    },
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      qc.invalidateQueries({ queryKey: ["wallet-running-balance"] });
      qc.invalidateQueries({ queryKey: ["wallet-ops-transfers"] });
      qc.invalidateQueries({ queryKey: ["wallet-ops-readiness"] });
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
    refresh,
    fund,
  };
}

const SETUP_HINTS = [
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

function isSetupError(e: Error): boolean {
  const msg = (e?.message ?? "").toLowerCase();
  return SETUP_HINTS.some((hint) => msg.includes(hint));
}

