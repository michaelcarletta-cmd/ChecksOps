import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import {
  ACCEPTED_SEND_STATUSES,
  fetchIncomingTransfers,
  fetchSharedCheckSourceSends,
  SEND_LEG_COLUMNS,
  SEND_LEG_ROLES,
  type SendLeg,
} from "@/lib/payments/transferFinanceRows";

/** Query-key prefix for the finance views' transfer reads; invalidate it after a send. */
export const TRANSFER_FINANCE_QUERY_KEY = "transfer-finance";

export function useIncomingTransfers(tenantIdOverride?: string | null) {
  const { tenant } = useTenant();
  const tenantId = tenantIdOverride ?? tenant?.id ?? null;
  return useQuery({
    queryKey: [TRANSFER_FINANCE_QUERY_KEY, "incoming", tenantId],
    enabled: !!tenantId,
    staleTime: 30_000,
    retry: false,
    queryFn: () => fetchIncomingTransfers(supabase, tenantId!),
  });
}

/**
 * Checks shared with this organization that the sharing organization paid from by a send to someone
 * else (SQL 162). Empty until the API change is live.
 */
export function useSharedCheckSourceSends(tenantIdOverride?: string | null) {
  const { tenant } = useTenant();
  const tenantId = tenantIdOverride ?? tenant?.id ?? null;
  return useQuery({
    queryKey: [TRANSFER_FINANCE_QUERY_KEY, "shared-source-sends", tenantId],
    enabled: !!tenantId,
    staleTime: 30_000,
    retry: false,
    queryFn: () => fetchSharedCheckSourceSends(supabase, tenantId!),
  });
}

/** This organization's own send legs Moov accepted (the sender reads its own rows under RLS). */
export function useSentPaymentLegs() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id ?? null;
  return useQuery({
    queryKey: [TRANSFER_FINANCE_QUERY_KEY, "sent", tenantId],
    enabled: !!tenantId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_transfers")
        .select(SEND_LEG_COLUMNS)
        .eq("tenant_id", tenantId!)
        .in("leg_role", [...SEND_LEG_ROLES])
        .in("status", [...ACCEPTED_SEND_STATUSES])
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      const legs = (data ?? []) as unknown as SendLeg[];
      // The sent checks' number and carrier, for the rows (best effort: a failed read leaves them blank).
      const ids = [...new Set(legs.map((leg) => leg.check_id).filter(Boolean))] as string[];
      if (!ids.length) return legs;
      const { data: checks } = await supabase
        .from("check_intake_items")
        .select("id, check_number, carrier_name")
        .eq("tenant_id", tenantId!)
        .in("id", ids);
      const byId = new Map(((checks ?? []) as Array<{ id: string; check_number: string | null; carrier_name: string | null }>).map((c) => [c.id, c]));
      return legs.map((leg) => ({ ...leg, check: leg.check_id ? byId.get(leg.check_id) ?? null : null }));
    },
  });
}

/** Rows whose date falls inside [from, to] (the finance views' date range), or all rows. */
export function inRange<T>(rows: T[], at: (row: T) => string | null | undefined, range: { from: Date; to: Date } | null): T[] {
  if (!range) return rows;
  const from = range.from.getTime();
  const to = range.to.getTime();
  return rows.filter((row) => {
    const value = at(row);
    const t = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(t) && t >= from && t <= to;
  });
}
