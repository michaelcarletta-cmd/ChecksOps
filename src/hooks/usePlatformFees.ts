import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import {
  cancelFeeSchedule,
  listFeeOccurrences,
  listFeeSchedules,
  listUnbilledFees,
  rollUpFees,
  saveFeeSchedule,
  type FeeAmountMode,
  type FeeCadence,
} from "@/lib/payments/feeSchedules";

/** Recurring platform fee billing for the current organization. */
export function usePlatformFees() {
  const { tenantId, enabled } = usePaymentProviderEligibility();
  const qc = useQueryClient();
  const key = ["platform-fees", tenantId];

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const query = useQuery({
    queryKey: key,
    enabled: !!tenantId && enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const [schedules, occurrences, unbilled] = await Promise.all([
        listFeeSchedules(tenantId!),
        listFeeOccurrences(tenantId!),
        listUnbilledFees(tenantId!),
      ]);
      return { schedules, occurrences, unbilled };
    },
  });

  const save = useMutation({
    mutationFn: (input: {
      name?: string;
      cadence?: FeeCadence;
      dayOfMonth?: number;
      amountCents?: number;
      amountMode?: FeeAmountMode;
    }) => saveFeeSchedule({ tenantId: tenantId!, ...input }),
    onSuccess: invalidate,
  });

  const cancel = useMutation({
    mutationFn: (scheduleId: string) => cancelFeeSchedule(tenantId!, scheduleId),
    onSuccess: invalidate,
  });

  const rollUp = useMutation({
    mutationFn: (input: { dryRun?: boolean } = {}) =>
      rollUpFees({ tenantId: tenantId!, dryRun: input.dryRun }),
    onSuccess: invalidate,
  });

  const unbilled = query.data?.unbilled ?? [];
  const unbilledTotalCents = unbilled.reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);

  return {
    tenantId,
    enabled,
    schedules: query.data?.schedules ?? [],
    occurrences: query.data?.occurrences ?? [],
    unbilled,
    unbilledTotalCents,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    save,
    cancel,
    rollUp,
  };
}
