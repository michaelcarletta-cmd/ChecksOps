import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import {
  getPaymentAccount,
  resolveTenantProvider,
  verifyPaymentAccount,
} from "@/lib/payments/paymentService";
import type { PaymentAccount, PaymentProviderId } from "@/lib/payments/types";

/**
 * Provider-neutral view of the current organization's payment account.
 * Components render status/bank info without knowing which rail supplies it.
 */
export function usePaymentAccount() {
  const { tenantId } = useTenantFilter();

  const providerQuery = useQuery<PaymentProviderId>({
    queryKey: ["payment-provider", tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => resolveTenantProvider(tenantId!),
  });

  const accountQuery = useQuery<PaymentAccount>({
    queryKey: ["payment-account", tenantId, providerQuery.data],
    enabled: !!tenantId && !!providerQuery.data,
    staleTime: 60 * 1000,
    queryFn: () => getPaymentAccount(tenantId!),
  });

  /**
   * Self-heal: when an account exists but has never been mirrored locally
   * (for example right after it was re-pointed at the correct provider
   * account), pull the live state once so the UI never shows a stale
   * "no bank connected" for an account the provider already verified.
   */
  const qc = useQueryClient();
  const healed = useRef<string | null>(null);
  const account = accountQuery.data ?? null;

  useEffect(() => {
    if (!tenantId || !account?.externalAccountId || account.lastSync) return;
    if (healed.current === account.externalAccountId) return;
    healed.current = account.externalAccountId;
    verifyPaymentAccount(tenantId)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["payment-account"] });
        qc.invalidateQueries({ queryKey: ["payment-readiness"] });
      })
      .catch(() => { /* surfaced by the manual refresh action */ });
  }, [tenantId, account?.externalAccountId, account?.lastSync, qc]);

  return {
    provider: providerQuery.data ?? null,
    account,
    isLoading: providerQuery.isLoading || accountQuery.isLoading,
    error: (providerQuery.error ?? accountQuery.error) as Error | null,
    refetch: accountQuery.refetch,
  };
}
