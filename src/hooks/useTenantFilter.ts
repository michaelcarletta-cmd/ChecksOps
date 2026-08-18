import { useTenant } from "@/contexts/TenantContext";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useLocation } from "react-router-dom";
import { isCheckOpsHost } from "@/lib/checkopsHost";

const KNOWN_APP_DOMAINS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "freedomclaims.work",
  "www.freedomclaims.work",
  "freedomclaims.lovable.app",
];

function isKnownAppDomain(hostname: string) {
  if (KNOWN_APP_DOMAINS.includes(hostname)) return true;
  if (hostname.endsWith(".lovable.app")) return true;
  return false;
}

/**
 * Returns the current tenant_id to use for filtering queries.
 * ALWAYS filters by tenant_id — each tenant (including the system tenant)
 * only sees their own data. No tenant sees another tenant's checks.
 *
 * When accessed outside a TenantProvider (e.g. Freedom Claims staff on /check-command-center),
 * auto-resolves to the system tenant so isolation is enforced.
 */
export function useTenantFilter() {
  const { tenant, isWhiteLabel, loading } = useTenant();
  const location = useLocation();
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const isWhiteLabelRoute = location.pathname.startsWith("/wl/");
  const isCustomTenantDomain = hostname !== "" && !isKnownAppDomain(hostname) && !isCheckOpsHost(hostname);
  const onCheckOpsHost = isCheckOpsHost(hostname);
  // On checkops.com, any /{slug}/... route is a tenant route (not the system tenant)
  const isCheckOpsTenantRoute = onCheckOpsHost && /^\/[^/]+\/(checks|settings|login|payments|cash-jobs|wallet-ops)/.test(location.pathname);
  const isResolvingWhiteLabelTenant =
    (isWhiteLabelRoute || isCustomTenantDomain || isCheckOpsTenantRoute) && !tenant;
  const shouldResolveSystemTenant = !tenant && !loading && !isResolvingWhiteLabelTenant && !onCheckOpsHost;

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
    enabled: shouldResolveSystemTenant,
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
