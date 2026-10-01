import { useQuery } from "@tanstack/react-query";
import { awsApiBaseUrl } from "@/lib/awsStaging";
import { canMoveTenantChecks } from "@/lib/tenantCheckUser";
import { loadTenantCheckIdentity } from "@/lib/tenantCheckIdentity";
import { useAuth } from "./useAuth";
import { useTenantFilter } from "./useTenantFilter";

export function useIdentityTenantAccess() {
  const { user } = useAuth();
  const { tenantId } = useTenantFilter();

  const { data } = useQuery({
    queryKey: ["identity-me-tenant-access", tenantId, user?.id],
    enabled: !!user?.id,
    queryFn: async () => loadTenantCheckIdentity({ tenantId, apiBaseUrl: awsApiBaseUrl() }),
  });

  return {
    roles: data?.roles ?? [],
    isTenantMember: !!data?.isTenantMember,
    tenantRole: data?.tenantRole ?? null,
    isAdmin: (data?.roles ?? []).some((role) => String(role).toLowerCase() === "admin"),
  };
}

/** True for a tenant company user (or platform admin). Used for check movement UI. */
export function useCanMoveChecks(): boolean {
  const { roles, isTenantMember } = useIdentityTenantAccess();
  return canMoveTenantChecks({
    systemRoles: roles,
    isTenantMember,
  });
}
