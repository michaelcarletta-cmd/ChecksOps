import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import {
  createSweep,
  disableSweep,
  getSweepSnapshot,
  listRecentSweeps,
  updateSweep,
  type SweepSnapshot,
  type SweepWriteInput,
} from "@/lib/payments/sweeps";

/**
 * Treasury sweep configuration for the organization's balance.
 * Reads are safe for any member; writes are rejected server-side for
 * non-administrators.
 */
export function useSweepConfig(walletType: string = "operating") {
  const { tenantId, enabled } = usePaymentProviderEligibility();
  const qc = useQueryClient();
  const key = ["payment-sweep-config", tenantId, walletType];

  const query = useQuery<SweepSnapshot>({
    queryKey: key,
    enabled: !!tenantId && enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: () => getSweepSnapshot(tenantId!, walletType),
  });

  const sweeps = useQuery({
    queryKey: [...key, "history"],
    enabled: !!tenantId && enabled && query.data?.sweep_config?.status === "enabled",
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => listRecentSweeps(tenantId!, walletType),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: (input: Omit<SweepWriteInput, "tenantId" | "walletType">) => {
      const payload = { ...input, tenantId: tenantId!, walletType };
      return query.data?.sweep_config?.provider_sweep_config_id
        ? updateSweep(payload)
        : createSweep(payload);
    },
    onSuccess: invalidate,
  });

  const disable = useMutation({
    mutationFn: () => disableSweep(tenantId!, walletType),
    onSuccess: invalidate,
  });

  return {
    tenantId,
    enabled,
    snapshot: query.data ?? null,
    config: query.data?.sweep_config ?? null,
    wallet: query.data?.wallet ?? null,
    settlementMethod: query.data?.settlement_method ?? null,
    pushRails: query.data?.available_push_rails ?? [],
    pullAvailable: !!query.data?.pull_available,
    stale: !!query.data?.stale,
    history: sweeps.data?.sweeps ?? [],
    historyUnavailable: sweeps.isError || (!sweeps.isLoading && (sweeps.data?.sweeps?.length ?? 0) === 0),
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    save,
    disable,
  };
}
