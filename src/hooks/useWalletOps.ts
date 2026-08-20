import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

/**
 * Asks the provider for the live status of every in-flight transfer and
 * refreshes the local view with the answer.
 */
export function useRefreshTransferStatuses() {
  const { tenantId } = usePaymentProviderEligibility();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("moov-transfer-status", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      if ((data as any)?.success === false) throw new Error((data as any)?.error ?? "Status check failed");
      return data as { checked: number; updated: number; results: any[] };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wallet-ops-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["wallet-running-balance"] });
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

export interface RunningBalancePoint {
  id: string;
  created_at: string;
  label: string;
  direction: "credit" | "debit";
  amount_cents: number;
  balance_cents: number;
}

/**
 * Chronological running balance for the current organization's wallet,
 * straight from `payment_wallet_ledger` (balance_after_cents is authoritative).
 */
export function useWalletRunningBalance(walletType: "operating" | "trust" = "operating", limit = 60) {
  const { tenantId, enabled } = usePaymentProviderEligibility();

  return useQuery({
    queryKey: ["wallet-running-balance", tenantId, walletType, limit],
    enabled: !!tenantId && enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const { data: wallet } = await supabase
        .from("payment_wallets")
        .select("id")
        .eq("tenant_id", tenantId!)
        .eq("wallet_type", walletType)
        .maybeSingle();
      if (!wallet?.id) return { points: [] as RunningBalancePoint[] };

      const { data, error } = await supabase
        .from("payment_wallet_ledger")
        .select("id, created_at, entry_type, direction, amount_cents, balance_after_cents, memo")
        .eq("wallet_id", wallet.id)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;

      const points: RunningBalancePoint[] = (data ?? [])
        .slice()
        .reverse()
        .map((r: any) => ({
          id: r.id,
          created_at: r.created_at,
          label: r.memo || r.entry_type,
          direction: r.direction,
          amount_cents: Number(r.amount_cents || 0),
          balance_cents: Number(r.balance_after_cents || 0),
        }));

      return { points };
    },
  });
}

export interface TenantWalletBalance {
  tenant_id: string;
  tenant_name: string;
  available_cents: number;
  pending_cents: number;
  status: string;
  last_synced_at: string | null;
}

/** Admin-only: running balance per organization. */
export function useAllTenantWalletBalances(isAdmin: boolean, walletType: "operating" | "trust" = "operating") {
  return useQuery<TenantWalletBalance[]>({
    queryKey: ["wallet-balances-all-tenants", walletType],
    enabled: isAdmin,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_wallets")
        .select("tenant_id, available_cents, pending_cents, status, last_synced_at")
        .eq("wallet_type", walletType)
        .order("available_cents", { ascending: false });
      if (error) throw error;

      const tenantIds = Array.from(new Set((data ?? []).map((r: any) => r.tenant_id).filter(Boolean)));
      const nameById = new Map<string, string>();
      if (tenantIds.length) {
        const { data: tenants } = await supabase
          .from("tenants")
          .select("id, name")
          .in("id", tenantIds);
        (tenants ?? []).forEach((t: any) => nameById.set(t.id, t.name));
      }

      return (data ?? []).map((r: any) => ({
        tenant_id: r.tenant_id,
        tenant_name: nameById.get(r.tenant_id) ?? "Organization",
        available_cents: Number(r.available_cents || 0),
        pending_cents: Number(r.pending_cents || 0),
        status: r.status,
        last_synced_at: r.last_synced_at,
      }));
    },

  });
}
