import { useCallback } from "react";
import { useStepUp } from "@/hooks/useStepUp";
import {
  buildFinancialStepUpRequest,
  FinancialStepUpDeniedError,
  runFinancialActionWithStepUp,
} from "@/lib/financialStepUp";

type GuardExtra = {
  description?: string;
  checkId?: string | null;
  amount?: unknown;
  amount_cents?: unknown;
};

const buildGuardRequest = (
  actionKey: string,
  extra: GuardExtra | undefined,
  tenantId?: string | null,
) =>
  buildFinancialStepUpRequest({
    actionKey,
    checkId: extra?.checkId,
    title: actionKey === "deposit.submit"
      ? "Deposit Verification"
      : actionKey === "deposit.approve"
        ? "Approve deposit"
        : undefined,
    description: extra?.description
      || (actionKey === "deposit.submit"
        ? "Enter the current 6-digit code from your authenticator app to authorize this deposit."
        : actionKey === "deposit.approve"
          ? "Enter the current 6-digit code from your authenticator app to authorize this approval."
          : undefined),
    tenantId,
    amount: extra?.amount,
    amount_cents: extra?.amount_cents,
  });

/**
 * Guard for money-movement actions.
 *
 * Call `await guardFinancial("<key>", { checkId })` as the FIRST
 * statement of any mutation that deposits, disburses, funds a wallet or
 * changes bank details. Prefer `runAuthorized` when the ChecksOps action
 * can return `step_up_required` so an expired server grant re-challenges.
 * Browser tenant and amount are ignored as authority.
 */
export function useFinancialGuard(tenantId?: string | null) {
  const { requireStepUp, invalidateStepUp } = useStepUp();

  const guardFinancial = useCallback(
    async (actionKey: string, extra?: GuardExtra) => {
      const built = buildGuardRequest(actionKey, extra, tenantId);
      if (!built.ok) {
        throw new Error((built as { message?: string }).message ?? "Financial authorization failed");
      }
      const ok = await requireStepUp(built.request);
      if (!ok) {
        throw new FinancialStepUpDeniedError();
      }
    },
    [requireStepUp, tenantId],
  );

  const runAuthorized = useCallback(
    async <T,>(actionKey: string, extra: GuardExtra | undefined, action: () => Promise<T>) => {
      const built = buildGuardRequest(actionKey, extra, tenantId);
      if (!built.ok) {
        throw new Error((built as { message?: string }).message ?? "Financial authorization failed");
      }
      return runFinancialActionWithStepUp({
        requireStepUp,
        invalidateStepUp,
        request: built.request,
        action,
      });
    },
    [invalidateStepUp, requireStepUp, tenantId],
  );

  return { guardFinancial, runAuthorized };
}
