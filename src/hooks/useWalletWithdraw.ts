import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useStepUp } from "@/hooks/useStepUp";
import { resolveWalletOpsEnvironment } from "@/lib/payments/selectPaymentWallet";
import {
  readWithdrawLimits,
  saveWithdrawLimits,
  WalletWithdrawError,
  withdrawToBank,
} from "@/lib/payments/wallets";
import {
  transferBankOptions,
  WALLET_WITHDRAW_TOTP_ACTION,
  withdrawErrorMessage,
  type SettlementBankRow,
  type WithdrawLimits,
} from "@/lib/payments/walletWithdraw";

/**
 * Transfer to bank: the organization's banks, settlement bank first (the same rows and rule as the
 * Settlement bank tile; the server checks the picked bank again), its own limits, and the two calls
 * that need the same wallet.fund two-factor step-up as Add funds (useWallet's fund).
 */
export function useWalletWithdraw() {
  const { tenantId, enabled, tenantMoovEnvironment, environmentReady } = usePaymentProviderEligibility();
  const qc = useQueryClient();
  const { requireStepUp } = useStepUp();
  const hostname = typeof window === "undefined" ? "" : window.location.hostname;
  const walletEnvironment = resolveWalletOpsEnvironment({
    hostname,
    tenantMoovEnvironment,
    appUrl: import.meta.env.VITE_APP_URL,
  });
  const ready = !!tenantId && enabled && environmentReady;

  // The tenant's own banks (never a recipient's), with the tile's filter and order: default first, then newest.
  // Every bank is listed; those that cannot receive a transfer are shown disabled with the reason.
  const banks = useQuery({
    queryKey: ["wallet-withdraw-banks", tenantId, walletEnvironment],
    enabled: ready,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_methods")
        .select("id, bank_name, last_four, is_default, connection_status, verification_status, external_recipient_id")
        .eq("tenant_id", tenantId!)
        .eq("provider", "moov")
        .eq("environment", walletEnvironment)
        .is("external_recipient_id", null)
        .order("is_default", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return transferBankOptions((data ?? []) as SettlementBankRow[]);
    },
  });

  const limitsKey = ["wallet-withdraw-limits", tenantId];
  const limits = useQuery<WithdrawLimits>({
    queryKey: limitsKey,
    enabled: ready,
    staleTime: 30_000,
    retry: false,
    queryFn: () => readWithdrawLimits(tenantId!),
  });

  /** Runs a call; when the server answers totp_required, asks for the code once and retries the same call. */
  async function withStepUp<T>(send: () => Promise<T>, title: string): Promise<T> {
    try {
      return await send();
    } catch (error) {
      // The server decides whether this login has confirmed two-factor; ask only when it says so.
      if (!(error instanceof WalletWithdrawError) || error.code !== "totp_required") throw error;
      const passed = await requireStepUp(
        {
          actionKey: WALLET_WITHDRAW_TOTP_ACTION,
          checkId: null,
          tenantId,
          title,
          description: "Enter the 6-digit code from your authenticator app. You'll only be asked once until you sign out.",
        },
        { force: true },
      );
      if (!passed) {
        throw new WalletWithdrawError(withdrawErrorMessage("step_up_cancelled"), "step_up_cancelled");
      }
      return send();
    }
  }

  const withdraw = useMutation({
    mutationFn: (input: { amountCents: number; idempotencyKey: string; bankId: string }) => {
      if (!tenantId) throw new Error("Organization isn't loaded yet. Try again in a moment.");
      // The key belongs to this confirmation (amount and bank): the two-factor retry reuses it, so it never sends twice.
      return withStepUp(
        () => withdrawToBank({ tenantId, amountCents: input.amountCents, idempotencyKey: input.idempotencyKey, bankId: input.bankId }),
        "Confirm transfer to bank",
      );
    },
    onSettled: () => {
      // Whatever happened, show the balance and the transfer list as the server now has them.
      qc.invalidateQueries({ queryKey: ["payment-wallet", tenantId] });
      qc.invalidateQueries({ queryKey: ["wallet-ops-transfers"] });
      qc.invalidateQueries({ queryKey: ["wallet-running-balance"] });
    },
  });

  const saveLimits = useMutation({
    mutationFn: (next: WithdrawLimits) => {
      if (!tenantId) throw new Error("Organization isn't loaded yet. Try again in a moment.");
      return withStepUp(() => saveWithdrawLimits(tenantId, next), "Confirm transfer limits");
    },
    onSuccess: (saved) => {
      qc.setQueryData(limitsKey, saved);
    },
  });

  return { tenantId, banks, limits, withdraw, saveLimits };
}
