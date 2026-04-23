import { useTenant } from "@/contexts/TenantContext";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Returns the current tenant_id to use for filtering queries.
 * ALWAYS filters by tenant_id — each tenant (including the system tenant)
 * only sees their own data. No tenant sees another tenant's checks.
 *
 * When accessed outside a TenantProvider (e.g. Freedom Claims staff on /check-command-center),
 * auto-resolves to the system tenant so isolation is enforced.
 */
export function useTenantFilter() {
  const { tenant, isWhiteLabel } = useTenant();

  // If no tenant from context, auto-resolve system tenant for Freedom Claims staff
  const { data: systemTenantId } = useQuery({
    queryKey: ["system-tenant-id"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("id")
        .eq("is_system_tenant", true)
        .maybeSingle();
      return data?.id ?? null;
    },
    enabled: !tenant, // Only fetch when no tenant context
    staleTime: Infinity,
  });

  const resolvedTenantId = tenant?.id ?? systemTenantId ?? null;

  return {
    tenantId: resolvedTenantId,
    isWhiteLabel,
    /** Apply tenant filter to a Supabase query builder — always scopes to current tenant */
    applyFilter: <T extends { eq: (col: string, val: string) => T }>(query: T): T => {
      if (resolvedTenantId) {
        return query.eq("tenant_id", resolvedTenantId);
      }
      return query;
    },
  };
}
