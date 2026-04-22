import { useTenant } from "@/contexts/TenantContext";

/**
 * Returns the current tenant_id to use for filtering queries.
 * In white-label mode, returns the tenant's ID.
 * In system mode (Freedom Claims internal), returns null (no filter needed — system sees all).
 */
export function useTenantFilter() {
  const { tenant, isWhiteLabel } = useTenant();

  return {
    tenantId: tenant?.id ?? null,
    isWhiteLabel,
    /** Apply tenant filter to a Supabase query builder */
    applyFilter: <T extends { eq: (col: string, val: string) => T }>(query: T): T => {
      if (isWhiteLabel && tenant?.id) {
        return query.eq("tenant_id", tenant.id);
      }
      return query;
    },
  };
}
