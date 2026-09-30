import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useTenant } from "@/contexts/TenantContext";
import {
  summarizeWalletOps,
  type BillingActivity,
  type BillingOccurrenceRow,
  type PaymentMethodLabel,
  type WalletOpsTransferRow,
} from "@/lib/payments/walletRelativeTransfers";


export type WalletOpsReadinessState = "ready" | "pending" | "action_required" | "not_started";

export interface WalletOpsTransfer extends WalletOpsTransferRow {
  speed?: string | null;
  selected_rail?: string | null;
  created_at: string;
  status: string;
}

export type WalletOpsClassifiedTransfer = ReturnType<typeof summarizeWalletOps>["transfers"][number];

/**
 * Money currently in flight for THIS organization's wallet, split by
 * wallet-relative direction. Bank → ChecksOps billing is not Pending Out.
 */
export function useWalletOpsTransfers(limit = 25) {
  const { tenantId, enabled } = usePaymentProviderEligibility();
  const { tenant } = useTenant();

  return useQuery({
    queryKey: ["wallet-ops-transfers", tenantId, tenant?.name, limit],
    enabled: !!tenantId && enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const [transfersRes, walletRes, methodsRes, billingRes] = await Promise.all([
        supabase
          .from("payment_transfers")
          .select(
            "id, tenant_id, amount_cents, status, provider_status, speed, selected_rail, description, created_at, completed_at, leg_role, is_facilitator_fee, source_payment_method_id, destination_payment_method_id, provider_metadata, provider_transfer_id, idempotency_key, wallet_id",
          )
          .eq("tenant_id", tenantId!)
          .order("created_at", { ascending: false })
          .limit(limit),
        supabase
          .from("payment_wallets")
          .select("id, tenant_id, provider_payment_method_id, provider_wallet_id, provider_metadata")
          .eq("tenant_id", tenantId!)
          .eq("wallet_type", "operating")
          .maybeSingle(),
        supabase
          .from("payment_provider_methods")
          .select("id, tenant_id, provider_payment_method_id, last_four, bank_name, rail_payment_method_ids, is_default, connection_status")
          .eq("tenant_id", tenantId!),
        supabase
          .from("tenant_maintenance_payments")
          .select("id, tenant_id, amount_cents, status, notes, created_at, period_start, period_end, submitted_at")
          .eq("tenant_id", tenantId!)
          .order("created_at", { ascending: false })
          .limit(12),
      ]);

      if (transfersRes.error) throw transfersRes.error;
      if (walletRes.error) throw walletRes.error;

      const rows = (transfersRes.data ?? []) as WalletOpsTransfer[];
      const wallet = walletRes.data as {
        provider_payment_method_id?: string | null;
        provider_metadata?: Record<string, unknown> | null;
      } | null;
      const methods = ((methodsRes.error ? [] : methodsRes.data ?? []) as PaymentMethodLabel[]).filter(
        (row) => !row.tenant_id || row.tenant_id === tenantId,
      );
      const walletMeta = (wallet?.provider_metadata || {}) as Record<string, unknown>;
      const tenantWalletPaymentMethodId = String(wallet?.provider_payment_method_id || "").trim() || null;
      const extraWalletIds = [
        walletMeta.wallet_payment_method_id,
        walletMeta.payment_method_id,
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean);

      const occurrences: BillingOccurrenceRow[] = ((billingRes.error ? [] : billingRes.data ?? []) as Array<{
        id: string;
        tenant_id: string;
        amount_cents: number;
        status?: string | null;
        notes?: string | null;
        created_at?: string | null;
        period_start?: string | null;
      }>)
        .filter((row) => row.tenant_id === tenantId)
        .map((row) => ({
          id: row.id,
          tenant_id: row.tenant_id,
          amount_cents: row.amount_cents,
          status: row.status,
          notes: row.notes,
          created_at: row.created_at,
          occurrence_kind: "monthly_subscription",
          billing_period: String(row.period_start || "").slice(0, 7) || null,
        }));

      const summary = summarizeWalletOps({
        tenantId: tenantId!,
        tenantWalletPaymentMethodId,
        tenantWalletPaymentMethodIds: extraWalletIds,
        transfers: rows.filter((row) => !row.tenant_id || row.tenant_id === tenantId),
        methods,
        occurrences,
        tenantName: tenant?.name || "Organization",
      });

      return {
        transfers: rows,
        classified: summary.transfers,
        billing: summary.billing as BillingActivity[],
        pendingOutCents: summary.pendingOutCents,
        pendingInCents: summary.pendingInCents,
        tenantWalletPaymentMethodId,
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
      if (!tenantId) throw new Error("Organization isn't loaded yet. Try again in a moment.");
      const { data, error } = await supabase.functions.invoke("moov-transfer-status", {
        body: { tenant_id: tenantId },
      });
      if (error) throw new Error(await invokeErrorMessage(error, data, "Could not check status"));
      if ((data as any)?.success === false) {
        throw new Error((data as any)?.error ?? "Could not check status");
      }
      return data as { checked: number; updated: number; results: any[] };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wallet-ops-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["wallet-running-balance"] });
      queryClient.invalidateQueries({ queryKey: ["payment-wallet"] });
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

async function invokeErrorMessage(
  error: { message?: string; context?: { json?: () => Promise<any> } },
  data: unknown,
  fallback: string,
): Promise<string> {
  const payload = data && typeof data === "object" ? (data as { error?: string; message?: string }) : null;
  if (payload?.error) return payload.error;
  if (payload?.message) return payload.message;
  try {
    const parsed = await error?.context?.json?.();
    if (parsed?.error) return String(parsed.error);
    if (parsed?.message) return String(parsed.message);
  } catch {
    /* keep the original message */
  }
  const msg = error?.message ?? fallback;
  if (/non-2xx|edge function/i.test(msg)) return fallback;
  return msg;
}
