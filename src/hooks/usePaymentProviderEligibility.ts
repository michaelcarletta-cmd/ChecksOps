import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { PAYMENT_FLAGS, isMoovAllowedForTenant } from "@/lib/payments/featureFlags";

/**
 * Whether the platform payment provider may be used by the current
 * organization. Moov is generally available; money movement is still gated
 * by identity/KYB, ToS, bank verification, wallet, and capability checks.
 */
export function usePaymentProviderEligibility() {
  const { tenantId } = useTenantFilter();

  const { data, isLoading } = useQuery({
    queryKey: ["payment-provider-eligibility", tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("moov_environment")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return {
        environment: ((data as any)?.moov_environment ?? "production") as string,
      };
    },
  });

  return {
    tenantId,
    allowlisted: true,
    environment: data?.environment ?? "production",
    tenantMoovEnvironment: data?.environment ?? null,
    environmentReady: !isLoading,
    globallyEnabled: PAYMENT_FLAGS.USE_MOOV,
    /** True when Moov is on and this session has an organization. */
    enabled: isMoovAllowedForTenant() && !!tenantId,
    isLoading,
  };
}
