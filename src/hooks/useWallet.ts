import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useStepUp } from "@/hooks/useStepUp";
import { loadWalletSnapshot } from "@/lib/payments/loadWalletSnapshot";
import { resolveWalletOpsEnvironment } from "@/lib/payments/selectPaymentWallet";
import {
  fundWallet,
  readWallet,
  WalletFundError,
  syncWallet,
  type WalletSnapshot,
  type WalletType,
} from "@/lib/payments/wallets";

/**
 * Live view of an organization's balance, its ledger and (for trust balances)
 * its per-matter sub-ledgers.
 */
export function useWallet(walletType: WalletType = "operating") {
  const { tenantId, enabled, tenantMoovEnvironment, environmentReady } = usePaymentProviderEligibility();
  const qc = useQueryClient();
  const { requireStepUp } = useStepUp();
  const hostname = typeof window === "undefined" ? "" : window.location.hostname;
  const walletEnvironment = resolveWalletOpsEnvironment({
    hostname,
    tenantMoovEnvironment,
    appUrl: import.meta.env.VITE_APP_URL,
  });
  const key = ["payment-wallet", tenantId, walletType, walletEnvironment];

  const query = useQuery<WalletSnapshot & { setup_required?: boolean }>({
    queryKey: key,
    enabled: !!tenantId && enabled && environmentReady,
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      loadWalletSnapshot({
        tenantId: tenantId!,
        walletType,
        tenantMoovEnvironment: walletEnvironment,
        syncWallet,
        readWallet,
      }) as Promise<WalletSnapshot & { setup_required?: boolean }>,
  });

  const fund = useMutation({
    mutationFn: async (input: { amountCents: number; description?: string; subLedgerId?: string | null }) => {
      if (!tenantId) throw new Error("Organization isn't loaded yet. Try again in a moment.");
      // One key per click: a retry below, or a resubmitted request, never funds twice.
      const idempotencyKey = crypto.randomUUID();
      const stepUp = {
        actionKey: "wallet.fund",
        checkId: null,
        tenantId,
        title: "Confirm funding",
        description: "Enter the 6-digit code from your authenticator app. You'll only be asked once until you sign out.",
      };
      const send = () =>
        fundWallet({
          tenantId,
          amountCents: input.amountCents,
          idempotencyKey,
          walletType,
          description: input.description,
          subLedgerId: input.subLedgerId ?? null,
        });
      try {
        return await send();
      } catch (error) {
        // The server decides whether this login has confirmed two-factor; ask only when it says so.
        if (!(error instanceof WalletFundError) || error.code !== "totp_required") throw error;
        if (!(await requireStepUp(stepUp, { force: true }))) {
          throw new Error("Funding was cancelled. Two-factor confirmation is required.");
        }
        return send();
      }
    },
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
      qc.invalidateQueries({ queryKey: ["wallet-ops-readiness"] });
      qc.invalidateQueries({ queryKey: ["wallet-ops-transfers"] });
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
