import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { functionRefusalMessage } from "@/lib/tenantProfile";

/**
 * Per-tenant deposits switch (tenants.deposits_enabled, SQL 98). Only the
 * ChecksOps platform owner changes it, from Tenant Management. When it is off
 * the tenant cannot submit or record check deposits: the server refuses every
 * deposit path with deposits_disabled; the SPA shows a notice and disables the
 * deposit actions. A missing or unreadable value shows as on here (the server
 * still decides).
 */
export const DEPOSITS_DISABLED_MESSAGE = "Deposits are turned off for this account. Contact ChecksOps.";
export const DEPOSITS_SWITCH_HELP = "When off, this tenant cannot submit or record check deposits.";

export const depositsEnabledValue = (value: unknown): boolean => value !== false;

/** True when a server answer is the deposits switch refusal. */
export const isDepositsDisabledError = (error: unknown): boolean => {
  const text = typeof error === "string" ? error : (error as { message?: string; error?: string } | null)?.error
    ?? (error as { message?: string } | null)?.message ?? "";
  return /deposits_disabled|Deposits are turned off/i.test(String(text));
};

export async function fetchTenantsDepositsEnabled(tenantIds: string[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(tenantIds.filter(Boolean))];
  const out = new Map<string, boolean>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("tenants")
    .select("id, deposits_enabled" as never)
    .in("id", ids);
  if (error) return out;
  // deposits_enabled (SQL 98) is not in the generated Supabase types; read the rows untyped.
  for (const row of (data ?? []) as unknown as Array<{ id: string; deposits_enabled?: boolean | null }>) {
    out.set(row.id, depositsEnabledValue(row.deposits_enabled));
  }
  return out;
}

/** The tenant's own deposits switch (true until read, and when absent). */
export function useTenantDepositsEnabled(tenantId: string | null | undefined) {
  const query = useQuery({
    queryKey: ["tenant-deposits-enabled", tenantId],
    queryFn: async () => (await fetchTenantsDepositsEnabled([tenantId as string])).get(tenantId as string) ?? true,
    enabled: !!tenantId,
    staleTime: 30_000,
  });
  return { depositsEnabled: query.data ?? true, isLoading: query.isLoading };
}

/** The switch for several tenants (rows of a multi-tenant queue). */
export function useTenantsDepositsEnabled(tenantIds: string[]) {
  const key = [...new Set(tenantIds.filter(Boolean))].sort();
  const query = useQuery({
    queryKey: ["tenants-deposits-enabled", key],
    queryFn: () => fetchTenantsDepositsEnabled(key),
    enabled: key.length > 0,
    staleTime: 30_000,
  });
  return (tenantId: string | null | undefined) => (tenantId ? query.data?.get(tenantId) ?? true : true);
}

/** Platform owner only: tenant-billing-admin update (SQL 98 setter, audited). */
export async function saveTenantDepositsEnabled(tenantId: string, enabled: boolean): Promise<void> {
  const { data, error } = await supabase.functions.invoke("tenant-billing-admin", {
    body: { action: "update", tenant_id: tenantId, deposits_enabled: enabled },
  });
  const refusal = functionRefusalMessage(data, error, "Deposits setting was not saved");
  if (refusal) throw new Error(refusal);
}
