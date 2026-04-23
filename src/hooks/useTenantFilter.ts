import { useTenant } from "@/contexts/TenantContext";

/**
 * Returns the current tenant_id to use for filtering queries.
 * ALWAYS filters by tenant_id — each tenant (including the system tenant)
 * only sees their own data. No tenant sees another tenant's checks.
 */
export function useTenantFilter() {
  const { tenant, isWhiteLabel } = useTenant();

  return {
    tenantId: tenant?.id ?? null,
    isWhiteLabel,
    /** Apply tenant filter to a Supabase query builder — always scopes to current tenant */
    applyFilter: <T extends { eq: (col: string, val: string) => T }>(query: T): T => {
      if (tenant?.id) {
        return query.eq("tenant_id", tenant.id);
      }
      return query;
    },
  };
}
