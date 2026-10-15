import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { awsApiBaseUrl, isAwsStaging } from "@/lib/awsStaging";
import { canMoveTenantChecks } from "@/lib/tenantCheckUser";
import { canOperateCheckAlt } from "@/lib/checkAltOperatorAccess";
import { loadTenantCheckIdentity } from "@/lib/tenantCheckIdentity";
import { useAuth } from "./useAuth";
import { useTenantFilter } from "./useTenantFilter";

/**
 * The signed-in user's membership of a tenant. Defaults to the current tenant
 * (useTenantFilter); pass a tenant id to ask about a specific tenant.
 */
export function useIdentityTenantAccess(tenantIdOverride?: string | null) {
  const { user, userRole } = useAuth();
  const { tenantId: currentTenantId } = useTenantFilter();
  const tenantId = tenantIdOverride !== undefined ? tenantIdOverride : currentTenantId;
  const aws = isAwsStaging();

  const { data: identity } = useQuery({
    queryKey: ["identity-me-tenant-access", tenantId, user?.id],
    enabled: aws && !!user?.id,
    queryFn: async () => loadTenantCheckIdentity({ tenantId, apiBaseUrl: awsApiBaseUrl() }),
  });

  const { data: membership } = useQuery({
    queryKey: ["tenant-check-user-membership", tenantId, user?.id],
    enabled: !aws && !!user?.id && !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select("user_id, role")
        .eq("tenant_id", tenantId!)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  if (aws) {
    return {
      roles: identity?.roles ?? [],
      isTenantMember: !!identity?.isTenantMember,
      tenantRole: identity?.tenantRole ?? null,
      isAdmin: (identity?.roles ?? []).some((role) => String(role).toLowerCase() === "admin"),
    };
  }

  const isAdmin = userRole === "admin";
  return {
    roles: isAdmin ? ["admin"] : userRole ? [userRole] : [],
    isTenantMember: !!membership,
    tenantRole: membership?.role ?? null,
    isAdmin,
  };
}

/** True for any company user on this tenant (or platform admin). */
export function useCanMoveChecks(): boolean {
  const { roles, isTenantMember } = useIdentityTenantAccess();
  return canMoveTenantChecks({
    systemRoles: roles,
    isTenantMember,
  });
}

/**
 * True when the user's tenant role for this tenant (default: the current
 * tenant) is owner, admin, manager or operator. Hides Check Alt submit,
 * approve, reject and refresh-status controls from viewers and non-members.
 * False while loading. UX only; the server enforces the same rule.
 */
export function useCanOperateCheckAlt(tenantIdOverride?: string | null): boolean {
  const { isTenantMember, tenantRole } = useIdentityTenantAccess(tenantIdOverride);
  return canOperateCheckAlt({ isTenantMember, tenantRole });
}
