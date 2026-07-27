import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { PAYMENT_FLAGS, isMoovAllowedForTenant } from "@/lib/payments/featureFlags";

/**
 * Whether the platform payment provider (sandbox) may be used by the current
 * organization. Requires both the global internal-test flag and the
 * per-organization allowlist — the backend enforces the same rules.
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
        .select("moov_allowlisted, moov_environment")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return {
        allowlisted: !!(data as any)?.moov_allowlisted,
        environment: ((data as any)?.moov_environment ?? "sandbox") as string,
      };
    },
  });

  return {
    tenantId,
    allowlisted: data?.allowlisted ?? false,
    environment: data?.environment ?? "sandbox",
    globallyEnabled: PAYMENT_FLAGS.USE_MOOV,
    /** True only when the platform rail may actually be exercised. */
    enabled: isMoovAllowedForTenant(data?.allowlisted),
    isLoading,
  };
}
