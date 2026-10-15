import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { awsApiBaseUrl, isAwsStaging } from "@/lib/awsStaging";
import { canMoveTenantChecks } from "@/lib/tenantCheckUser";
import {
  canOperateCheckAltForTenant,
  canOperateCheckAltInAnyTenant,
  type TenantMembership,
} from "@/lib/checkAltOperatorAccess";
import { loadIdentityTenantMemberships, loadTenantCheckIdentity } from "@/lib/tenantCheckIdentity";
import { useAuth } from "./useAuth";
import { useTenantFilter } from "./useTenantFilter";

export function useIdentityTenantAccess() {
  const { user, userRole } = useAuth();
  const { tenantId } = useTenantFilter();
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
 * Every tenant_users membership (tenant id + role) of the signed-in user:
 * AWS GET /identity/me, or tenant_users on the legacy backend. isLoading
 * covers auth still loading; isError means the memberships could not be read.
 */
export function useTenantMemberships() {
  const { user, loading: authLoading } = useAuth();
  const aws = isAwsStaging();
  const enabled = !!user?.id;
  const query = useQuery({
    queryKey: ["identity-tenant-memberships", aws ? "aws" : "legacy", user?.id],
    enabled,
    queryFn: async (): Promise<TenantMembership[]> => {
      if (aws) return loadIdentityTenantMemberships({ apiBaseUrl: awsApiBaseUrl() });
      const { data, error } = await supabase
        .from("tenant_users")
        .select("tenant_id, role")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        tenant_id: String(row.tenant_id),
        role: row.role == null ? null : String(row.role),
      }));
    },
  });
  return {
    memberships: query.data ?? [],
    isLoading: authLoading || (enabled && query.isPending),
    isError: query.isError,
    refetch: query.refetch,
  };
}

/**
 * Check Alt submit, approve, reject and refresh-status gating. canOperateIn
 * answers for one tenant (a check's or a deposit row's tenant); canOperateInAny
 * is for tenant-wide Poll Now. False while loading or on error. UX only; the
 * server enforces the same rule.
 */
export function useCheckAltAccess() {
  const { memberships, isLoading, isError, refetch } = useTenantMemberships();
  return {
    memberships,
    isLoading,
    isError,
    retry: refetch,
    canOperateIn: (tenantId: string | null | undefined) =>
      canOperateCheckAltForTenant(memberships, tenantId),
    canOperateInAny: canOperateCheckAltInAnyTenant(memberships),
  };
}
