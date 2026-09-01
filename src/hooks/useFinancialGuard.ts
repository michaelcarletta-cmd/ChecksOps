import { useCallback } from "react";
import { useStepUp } from "@/hooks/useStepUp";

/**
 * Guard for money-movement actions.
 *
 * Call `await guardFinancialAction("<key>")` as the FIRST statement of any
 * mutation that deposits, disburses, funds a wallet or changes bank details.
 * It throws when the user declines or fails two-factor, which aborts the
 * mutation and surfaces the message through the existing onError toast.
 */
export function useFinancialGuard(tenantId?: string | null) {
  const { requireStepUp } = useStepUp();

  return useCallback(
    async (actionKey: string, description?: string) => {
      const ok = await requireStepUp({ actionKey, description, tenantId });
      if (!ok) {
        throw new Error("Two-factor verification is required before money can move.");
      }
    },
    [requireStepUp, tenantId],
  );
}
