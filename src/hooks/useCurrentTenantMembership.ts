import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "./useAuth";

/**
 * Whether the signed-in user is a member of the current tenant.
 *
 * Owner policy: every member of the tenant is a user with the same rights;
 * partners and other tenants do not act. Any tenant_users row counts (the role
 * column is ignored) and platform roles give no shortcut. UX only: the API and
 * RLS enforce the same rule.
 */
export function useCurrentTenantMembership() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { data: isMember = false, isLoading } = useQuery({
    queryKey: ["tenant-user-membership", tenant?.id, user?.id],
    enabled: !!tenant?.id && !!user?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("tenant_users")
        .select("user_id")
        .eq("tenant_id", tenant!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      return Boolean(data);
    },
  });
  return { isMember, isLoading };
}
