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
  defaultSettlementBank,
  WALLET_WITHDRAW_TOTP_ACTION,
  withdrawErrorMessage,
  type SettlementBankRow,
  type WithdrawLimits,
} from "@/lib/payments/walletWithdraw";

/**
 * Transfer to bank: the organization's default bank (read only; the server picks it again and
 * never takes a bank from the browser), its own limits, and the two calls that need the same
 * wallet.fund two-factor step-up as Add funds (useWallet's fund).
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

  // The tenant's own connected banks (never a recipient's). Only the one marked default is used.
  const defaultBank = useQuery({
    queryKey: ["wallet-withdraw-default-bank", tenantId, walletEnvironment],
    enabled: ready,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_methods")
        .select("id, bank_name, last_four, is_default, connection_status, external_recipient_id")
        .eq("tenant_id", tenantId!)
        .eq("provider", "moov")
        .eq("environment", walletEnvironment)
        .eq("connection_status", "connected");
      if (error) throw error;
      return defaultSettlementBank((data ?? []) as SettlementBankRow[]);
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
    mutationFn: (input: { amountCents: number; idempotencyKey: string }) => {
      if (!tenantId) throw new Error("Organization isn't loaded yet. Try again in a moment.");
      // The key belongs to this confirmation: the two-factor retry reuses it, so it never sends twice.
      return withStepUp(
        () => withdrawToBank({ tenantId, amountCents: input.amountCents, idempotencyKey: input.idempotencyKey }),
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

  return { tenantId, defaultBank, limits, withdraw, saveLimits };
}
