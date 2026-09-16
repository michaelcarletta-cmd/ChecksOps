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

export interface TenantWalletStatus {
  wallet: {
    available_cents: number;
    pending_cents: number;
    status: string;
    last_synced_at: string | null;
    provider_wallet_id?: string | null;
  } | null;
  pending_in_cents: number;
  pending_out_cents: number;
  moov_pending_cents: number;
  sweep_config: {
    status: string;
    minimum_balance_cents: number;
    push_rail: string | null;
  } | null;
  settlement_method: {
    bank_name: string | null;
    last_four: string | null;
    connection_status: string | null;
  } | null;
  available_push_rails: string[];
  verification: {
    account_verified: boolean;
    identity: string | null;
    tos_accepted: boolean;
    capabilities: { capability: string; status: string }[];
    banks: { bankName?: string | null; lastFour?: string | null; status?: string | null }[];
    payment_methods: { type: string | null }[];
    what_is_verified: string[];
  } | null;
  payees?: {
    moov_account_id: string;
    verification_status: string;
    bank_verified: boolean;
    stakeholder_account_ids: string[];
  }[];
  readiness: WalletOpsReadiness | null;
  setup_required: boolean;
}

/** Live GET snapshot of this organization's Moov wallet. Does not move money. */
export function useTenantWalletStatus() {
  const { tenantId } = usePaymentProviderEligibility();

  return useQuery<TenantWalletStatus | null>({
    queryKey: ["tenant-wallet-status", tenantId],
    enabled: !!tenantId,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("moov-wallet-status", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const row = data as any;
      return {
        wallet: row.wallet ?? null,
        pending_in_cents: Number(row.pending_in_cents || 0),
        pending_out_cents: Number(row.pending_out_cents || 0),
        moov_pending_cents: Number(row.moov_pending_cents || 0),
        sweep_config: row.sweep_config ?? null,
        settlement_method: row.settlement_method ?? null,
        available_push_rails: row.available_push_rails ?? [],
        verification: row.verification ?? null,
        payees: row.payees ?? [],
        readiness: row.readiness
          ? {
              overall: row.readiness.overall,
              canMoveMoney: !!row.readiness.canMoveMoney,
              checks: (row.readiness.checks ?? []).map((c: any) => ({
                id: c.id,
                label: c.label,
                state: c.state,
                detail: c.detail,
              })),
            }
          : null,
        setup_required: !!row.setup_required,
      };
    },
  });
}

export interface WalletOpsReadiness {
  overall: WalletOpsReadinessState;
  canMoveMoney: boolean;
  checks: { id: string; label: string; state: WalletOpsReadinessState; detail?: string | null }[];
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
          detail: c.detail,
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
