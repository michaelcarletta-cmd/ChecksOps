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

  return {
    provider: providerQuery.data ?? null,
    account: accountQuery.data ?? null,
    isLoading: providerQuery.isLoading || accountQuery.isLoading,
    error: (providerQuery.error ?? accountQuery.error) as Error | null,
    refetch: accountQuery.refetch,
  };
}
