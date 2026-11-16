import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { isMasterMerchant } from "@/lib/masterMerchant";
import {
  decideWorkspaceAccess,
  identityListsTenant,
  identityTenantsMissing,
  nextMembershipRead,
  type MembershipRead,
} from "@/lib/workspaceAccess";

type TenantRef = { id: string; slug?: string | null } | null | undefined;

/**
 * Workspace membership for the white-label app and custom domains (one implementation for both).
 * The server's organization list from /identity/me counts first, then the tenant_users read
 * (workspaceAccess.ts). A membership confirmed in this session survives a failed refetch, a
 * session stored by an older build is refreshed once to get the organization list, and Retry
 * refreshes the session before reading again.
 */
export function useWorkspaceMembership(tenant: TenantRef, user: User | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ["tenant-membership", tenant?.id, user?.id] as const;

  const identityTenants = user?.app_metadata?.tenant_memberships;
  const identityListsThisTenant = identityListsTenant(identityTenants, tenant?.id, tenant?.slug);

  const {
    data: membershipRead,
    isLoading: memberQueryLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: async (): Promise<MembershipRead> => {
      if (!tenant?.id || !user?.id) return { row: false, failed: false, reason: null };
      const { data, error } = await supabase
        .from("tenant_users")
        .select("id")
        .eq("tenant_id", tenant.id)
        .eq("user_id", user.id)
        .maybeSingle();
      const previous = queryClient.getQueryData<MembershipRead>(queryKey);
      return nextMembershipRead(previous, { found: !!data, error });
    },
    enabled: !!tenant?.id && !!user?.id,
  });

  // A session stored before the organization list existed: refresh it once.
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!user?.id || !identityTenantsMissing(user.app_metadata)) return;
    if (refreshedFor.current === user.id) return;
    refreshedFor.current = user.id;
    void supabase.auth.refreshSession();
  }, [user?.id, user?.app_metadata]);

  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await supabase.auth.refreshSession();
      await refetch();
    } finally {
      setRetrying(false);
    }
  }, [refetch]);

  const workspaceAccess = decideWorkspaceAccess({
    tenantId: tenant?.id,
    tenantSlug: tenant?.slug,
    identityTenants,
    tenantUsersRow: !!membershipRead?.row,
    tenantUsersError: !!membershipRead?.failed,
    isMasterMerchant: isMasterMerchant(user?.email, user?.id),
  });

  return {
    workspaceAccess,
    // The identity list already confirms membership: do not wait on the read.
    memberLoading: !identityListsThisTenant && memberQueryLoading,
    checking: isFetching || retrying,
    retry,
    failureReason: membershipRead?.failed ? membershipRead.reason : null,
  };
}
