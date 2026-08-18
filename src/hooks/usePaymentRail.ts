import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";

export type PaymentRail = "actum" | "plaid";

/**
 * Per-tenant money-movement rail.
 *
 * "actum"  — Actum disbursement + Authentecheck bank verification (current).
 * "plaid"  — Plaid Transfer + Plaid Link (future).
 *
 * Flipping `tenants.payment_rail` to "plaid" hides every Actum/Authentecheck
 * surface for that tenant without removing any of the code, so a single row
 * update rolls the change forward or back with no deploy.
 *
 * Defaults to "actum" while loading so nothing flickers out of the UI for
 * tenants who are still live on Actum.
 */
export function usePaymentRail() {
  const { tenantId } = useTenantFilter();

  const { data, isLoading } = useQuery({
    queryKey: ["tenant-payment-rail", tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("payment_rail")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      const rail = (data as any)?.payment_rail ?? "actum";
      return (rail === "plaid" ? "actum" : rail) as PaymentRail;
    },
  });

  const rail: PaymentRail = "actum"; // Keep internal type but it's effectively legacy
  const isActum = false;

  return {
    rail,
    /** Actum is hidden globally. */
    isActum,
    /** Plaid is hidden globally. */
    isPlaid: false,
    isLoading,
  };
}
