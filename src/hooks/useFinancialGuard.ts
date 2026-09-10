import { useCallback } from "react";
import { useStepUp } from "@/hooks/useStepUp";
import { buildFinancialStepUpRequest } from "@/lib/financialStepUp";

/**
 * Guard for money-movement actions.
 *
 * Call `await guardFinancialAction("<key>", { checkId })` as the FIRST
 * statement of any mutation that deposits, disburses, funds a wallet or
 * changes bank details. Deposit submit/approve fail closed without a check id.
 * Browser tenant and amount are ignored as authority.
 */
export function useFinancialGuard(tenantId?: string | null) {
  const { requireStepUp } = useStepUp();

  return useCallback(
    async (
      actionKey: string,
      extra?: {
        description?: string;
        checkId?: string | null;
        amount?: unknown;
        amount_cents?: unknown;
      },
    ) => {
      const built = buildFinancialStepUpRequest({
        actionKey,
        checkId: extra?.checkId,
        title: actionKey === "deposit.submit" ? "Deposit Verification" : undefined,
        description: extra?.description
          || (actionKey === "deposit.submit"
            ? "Enter the current 6-digit code from your authenticator app to authorize this deposit."
            : undefined),
        tenantId,
        amount: extra?.amount,
        amount_cents: extra?.amount_cents,
      });
      if (!built.ok) {
        throw new Error((built as { message?: string }).message ?? "Financial authorization failed");
      }
      const ok = await requireStepUp(built.request);
      if (!ok) {
        throw new Error("Two-factor verification is required before money can move.");
      }
    },
    [requireStepUp, tenantId],
  );
}
