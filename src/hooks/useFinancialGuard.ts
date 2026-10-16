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
        /** Ask again even if this browser thinks the login is verified. */
        force?: boolean;
      },
    ) => {
      const built = buildFinancialStepUpRequest({
        actionKey,
        checkId: extra?.checkId,
        title: actionKey === "deposit.submit"
          ? "Deposit Verification"
          : actionKey === "deposit.approve"
            ? "Approval Verification"
            : undefined,
        description: extra?.description
          || (actionKey === "deposit.submit"
            ? "Enter the 6-digit code from your authenticator app. You'll only be asked once until you sign out."
            : actionKey === "deposit.approve"
              ? "Enter the 6-digit code from your authenticator app. You'll only be asked once until you sign out."
              : undefined),
        tenantId,
        amount: extra?.amount,
        amount_cents: extra?.amount_cents,
      });
      if (!built.ok) {
        throw new Error((built as { message?: string }).message ?? "Financial authorization failed");
      }
      const ok = await requireStepUp(built.request, extra?.force ? { force: true } : undefined);
      if (!ok) {
        throw new Error("Two-factor verification is required before money can move.");
      }
    },
    [requireStepUp, tenantId],
  );
}
