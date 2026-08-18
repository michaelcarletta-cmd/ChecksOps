import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";

export type WalletOpsReadinessState = "ready" | "pending" | "action_required" | "not_started";

export interface WalletOpsTransfer {
  id: string;
  amount_cents: number;
  status: string;
  speed: string | null;
  selected_rail: string | null;
  description: string | null;
  created_at: string;
  completed_at: string | null;
  leg_role: string | null;
  is_facilitator_fee: boolean | null;
}

const IN_FLIGHT = ["pending", "processing", "submitted", "queued", "created"];

/**
 * Money currently in flight for the organization, split by direction.
 * Sourced from `payment_transfers` — nothing is estimated or synthesised.
 */
export function useWalletOpsTransfers(limit = 25) {
  const { tenantId, enabled } = usePaymentProviderEligibility();

  return useQuery({
    queryKey: ["wallet-ops-transfers", tenantId, limit],
    enabled: !!tenantId && enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_transfers")
        .select(
          "id, amount_cents, status, speed, selected_rail, description, created_at, completed_at, leg_role, is_facilitator_fee",
        )
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;

      const rows = (data ?? []) as WalletOpsTransfer[];
      const inFlight = rows.filter((r) => IN_FLIGHT.includes((r.status ?? "").toLowerCase()));

      return {
        transfers: rows,
        pendingOutCents: inFlight
          .filter((r) => r.leg_role !== "funding")
          .reduce((sum, r) => sum + Number(r.amount_cents || 0), 0),
        pendingInCents: inFlight
          .filter((r) => r.leg_role === "funding")
          .reduce((sum, r) => sum + Number(r.amount_cents || 0), 0),
      };
    },
  });
}

export interface WalletOpsReadiness {
  overall: WalletOpsReadinessState;
  canMoveMoney: boolean;
  checks: { id: string; label: string; state: WalletOpsReadinessState }[];
}

/** Compact readiness summary for the WalletOps shortcut card. */
export function useWalletOpsReadiness() {
  const { tenantId, enabled } = usePaymentProviderEligibility();

  return useQuery<WalletOpsReadiness | null>({
    queryKey: ["wallet-ops-readiness", tenantId],
    enabled: !!tenantId && enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("moov-readiness", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      const readiness = (data as any)?.readiness;
      if (!readiness) return null;
      return {
        overall: readiness.overall as WalletOpsReadinessState,
        canMoveMoney: !!readiness.canMoveMoney,
        checks: (readiness.checks ?? []).map((c: any) => ({
          id: c.id,
          label: c.label,
          state: c.state as WalletOpsReadinessState,
        })),
      };
    },
  });
}
