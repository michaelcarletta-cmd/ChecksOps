import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { canMoveTenantChecks } from "@/lib/tenantCheckUser";
import { useAuth } from "./useAuth";
import { usePermissions } from "./usePermissions";
import { useTenantFilter } from "./useTenantFilter";

/** True for a tenant company user (or platform admin). Used for check movement UI. */
export function useCanMoveChecks(): boolean {
  const { user } = useAuth();
  const { isAdmin, isStaff } = usePermissions();
  const { tenantId } = useTenantFilter();

  const { data: isTenantMember } = useQuery({
    queryKey: ["tenant-check-user-membership", tenantId, user?.id],
    enabled: !!user?.id && !!tenantId && !isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select("user_id")
        .eq("tenant_id", tenantId!)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return !!data;
    },
  });

  return canMoveTenantChecks({
    systemRoles: [isAdmin ? "admin" : null, isStaff ? "staff" : null],
    isTenantMember: isAdmin || isStaff || !!isTenantMember,
  });
}
