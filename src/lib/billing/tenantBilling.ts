import { supabase } from "@/integrations/supabase/client";

export type BillingOccurrence = {
  id: string;
  tenant_id: string;
  amount_cents: number;
  monthly_rate_cents?: number | null;
  discount_cents?: number | null;
  billing_period?: string | null;
  status: string;
  provider_transfer_id?: string | null;
  funding_source_method_id?: string | null;
  destination_account_id?: string | null;
  destination_payment_method_id?: string | null;
  idempotence_key?: string | null;
  submitted_at?: string | null;
  settled_at?: string | null;
  returned_at?: string | null;
  failure_reason?: string | null;
  return_reason?: string | null;
  created_at?: string | null;
};

export type TenantBillingSnapshot = {
  ok?: boolean;
  error?: string;
  message?: string;
  monthly_rate_cents: number;
  referral_discount_cents: number;
  net_fee_cents: number;
  billing_enabled: boolean;
  billing_day_of_month: number;
  next_billing_date: string | null;
  next_period_start?: string | null;
  current_period?: string;
  authorization: {
    provider_payment_method_id?: string | null;
    account_number_last4?: string | null;
    nickname?: string | null;
    auto_debit_enabled?: boolean;
    ach_authorized_at?: string | null;
    verification_status?: string | null;
  } | null;
  destination?: {
    accountId?: string;
    paymentMethodId?: string;
    label?: string;
    environment?: string;
    source?: string;
    firstWalletFallback?: boolean;
    error?: string;
    reason?: string;
  };
  readiness: { ready: boolean; reasons: string[] };
  last_charge: BillingOccurrence | null;
  pending_charge: BillingOccurrence | null;
  history: BillingOccurrence[];
  methods?: Array<{
    provider_payment_method_id: string;
    holder_name?: string | null;
    last_four?: string | null;
    nickname?: string | null;
    connection_status?: string;
    can_send?: boolean;
  }>;
  pull?: Record<string, unknown>;
};

const fnError = async (error: any, data?: any): Promise<string> => {
  if (data?.error || data?.message) return String(data.message || data.error);
  try {
    const parsed = await error?.context?.json?.();
    if (parsed?.error || parsed?.message) return String(parsed.message || parsed.error);
  } catch {
    /* fall through */
  }
  return error?.message || "Request failed";
};

export async function invokeTenantBillingAdmin(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("tenant-billing-admin", { body });
  const payload = (data || {}) as TenantBillingSnapshot;
  if (error || payload.ok === false) {
    return { ok: false as const, error: await fnError(error, payload), data: payload };
  }
  return { ok: true as const, data: payload };
}

export async function invokeTenantBillingAuthorize(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("tenant-billing-authorize", { body });
  const payload = (data || {}) as { ok?: boolean; error?: string; message?: string; authorization?: unknown };
  if (error || payload.ok === false) {
    return { ok: false as const, error: await fnError(error, payload), data: payload };
  }
  return { ok: true as const, data: payload };
}

export const money = (cents: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);

export const billingStatusLabel = (status?: string | null) => {
  switch (String(status || "").toLowerCase()) {
    case "due": return "Due";
    case "submitted": return "Pending ACH";
    case "settled": return "Settled";
    case "failed": return "Failed";
    case "returned": return "Returned";
    default: return status || "—";
  }
};
