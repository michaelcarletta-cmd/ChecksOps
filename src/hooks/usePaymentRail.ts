import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";

export type PaymentRail = "moov";

/**
 * Per-tenant money-movement rail.
 *
 * Moov is the only supported rail. The legacy Actum/Authentecheck rail has
 * been removed and Plaid is not exposed, so this hook always reports Moov.
 * It is kept so existing call sites keep a single place to read rail state.
 */
export function usePaymentRail() {
  const { tenantId } = useTenantFilter();

  const { isLoading } = useQuery({
    queryKey: ["tenant-payment-rail", tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("payment_provider")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return (data as any)?.payment_provider ?? "moov";
    },
  });

  return {
    rail: "moov" as PaymentRail,
    /** Plaid is hidden globally. */
    isPlaid: false,
    isLoading,
  };
}
