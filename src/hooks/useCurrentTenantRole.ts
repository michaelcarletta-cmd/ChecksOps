import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "./useAuth";
import { canActInTenant, canManageTenantTeam } from "@/lib/tenantRoleAccess";

/**
 * The signed-in user's own tenant_users role for the current tenant, and the
 * owner-policy gates derived from it. Platform roles are ignored. UX only:
 * the API and RLS enforce the same rules.
 */
export function useCurrentTenantRole() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { data: role = null, isLoading } = useQuery({
    queryKey: ["tenant-user-role", tenant?.id, user?.id],
    enabled: !!tenant?.id && !!user?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenant!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      return (data?.role ?? null) as string | null;
    },
  });
  return {
    role,
    isLoading,
    canAct: canActInTenant(role),
    canManageTeam: canManageTenantTeam(role),
  };
}
