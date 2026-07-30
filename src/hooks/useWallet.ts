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

  const query = useQuery<WalletSnapshot>({
    queryKey: key,
    enabled: !!tenantId && enabled,
    staleTime: 30_000,
    queryFn: () => syncWallet(tenantId!, walletType),
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
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    fund,
  };
}
