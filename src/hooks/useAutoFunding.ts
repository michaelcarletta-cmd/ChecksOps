import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";

/**
 * Automatic wallet funding: settings, recent funding transfers, and the
 * calculation that tells a payment whether a bank pull is needed.
 */

export type FundingStrategy = "payment_shortage" | "target_balance" | "manual";

export interface AutoFundingSettings {
  id: string;
  tenant_id: string;
  auto_funding_enabled: boolean;
  funding_bank_account_id: string | null;
  funding_strategy: FundingStrategy;
  target_wallet_balance_cents: number;
  maximum_single_pull_cents: number;
  maximum_daily_pull_cents: number;
  require_payment_approval: boolean;
  authorization_accepted_at: string | null;
  authorization_version: string | null;
}

export interface FundingRequest {
  id: string;
  status: string;
  requested_amount_cents: number;
  payment_amount_cents: number;
  shortage_amount_cents: number;
  failure_reason: string | null;
  related_payment_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface FundingCalculation {
  fundingRequired: boolean;
  paymentCents: number;
  availableCents: number;
  pendingCents: number;
  reservedCents: number;
  spendableCents: number;
  shortageCents: number;
  suggested_pull_cents: number;
  auto_funding_enabled: boolean;
  authorization_on_file: boolean;
  funding_strategy: FundingStrategy;
  maximum_single_pull_cents: number;
  maximum_daily_pull_cents: number;
  funding_bank: { id: string; bank_name: string | null; last_four: string | null } | null;
  can_ach_debit: boolean;
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message ?? `${fn} failed`;
    try {
      const parsed = await (error as any).context?.json?.();
      if (parsed?.error) message = parsed.error;
    } catch {
      /* keep original */
    }
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export const AUTHORIZATION_VERSION = "2026-01-ach-debit-v1";

export function useAutoFunding() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id ?? null;
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: ["auto-funding-settings", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_wallet_funding_settings")
        .select("*")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as AutoFundingSettings) ?? null;
    },
  });

  const requests = useQuery({
    queryKey: ["wallet-funding-requests", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wallet_funding_requests")
        .select(
          "id, status, requested_amount_cents, payment_amount_cents, shortage_amount_cents, failure_reason, related_payment_id, created_at, completed_at",
        )
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as FundingRequest[];
    },
  });

  const banks = useQuery({
    queryKey: ["auto-funding-banks", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_methods")
        .select("id, bank_name, last_four, verification_status, connection_status, is_default")
        .eq("tenant_id", tenantId!)
        .eq("provider", "moov")
        .eq("connection_status", "connected")
        .order("is_default", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const saveSettings = useMutation({
    mutationFn: async (patch: Partial<AutoFundingSettings>) => {
      if (!tenantId) throw new Error("No organization selected.");
      const { data, error } = await supabase
        .from("tenant_wallet_funding_settings")
        .upsert({ tenant_id: tenantId, ...patch } as any, { onConflict: "tenant_id" })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auto-funding-settings", tenantId] }),
  });

  const fundManually = useMutation({
    mutationFn: async (amountCents: number) => {
      if (!tenantId) throw new Error("No organization selected.");
      return invoke("initiate-wallet-funding", {
        tenant_id: tenantId,
        manual: true,
        amount_cents: amountCents,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wallet-funding-requests", tenantId] });
      qc.invalidateQueries({ queryKey: ["wallet"] });
    },
  });

  const cancelFunding = useMutation({
    mutationFn: async (fundingRequestId: string) => {
      if (!tenantId) throw new Error("No organization selected.");
      return invoke("cancel-wallet-funding", {
        tenant_id: tenantId,
        funding_request_id: fundingRequestId,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallet-funding-requests", tenantId] }),
  });

  return { tenantId, settings, requests, banks, saveSettings, fundManually, cancelFunding };
}

/** Checks one approved payment against the wallet before anything is sent. */
export function usePaymentFunding(paymentId: string | null) {
  const { tenant } = useTenant();
  const tenantId = tenant?.id ?? null;

  return useQuery({
    queryKey: ["payment-funding", tenantId, paymentId],
    enabled: !!tenantId && !!paymentId,
    queryFn: () =>
      invoke<FundingCalculation>("calculate-payment-funding", {
        tenant_id: tenantId,
        payment_id: paymentId,
      }),
  });
}

/** Starts the bank pull for an approved payment and holds it until funded. */
export function useInitiatePaymentFunding() {
  const { tenant } = useTenant();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (paymentId: string) => {
      if (!tenant?.id) throw new Error("No organization selected.");
      return invoke("initiate-wallet-funding", {
        tenant_id: tenant.id,
        payment_id: paymentId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wallet-funding-requests", tenant?.id] });
      qc.invalidateQueries({ queryKey: ["payment-funding"] });
    },
  });
}
