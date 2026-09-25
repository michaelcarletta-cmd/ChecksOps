import { supabase } from "@/integrations/supabase/client";

export type BillingOccurrence = {
  id: string;
  tenant_id: string;
  amount_cents: number;
  monthly_rate_cents?: number | null;
  discount_cents?: number | null;
  maintenance_net_cents?: number | null;
  check_usage_cents?: number | null;
  next_day_usage_cents?: number | null;
  same_day_usage_cents?: number | null;
  mortgage_ops_initial_count?: number | null;
  mortgage_ops_initial_amount_cents?: number | null;
  mortgage_ops_additional_count?: number | null;
  mortgage_ops_additional_amount_cents?: number | null;
  usage_total_cents?: number | null;
  check_count?: number | null;
  next_day_count?: number | null;
  same_day_count?: number | null;
  billing_period?: string | null;
  occurrence_kind?: string | null;
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

export type BillingAllocation = {
  id?: string;
  invoice_id?: string | null;
  source_kind: string;
  source_id: string;
  fee_type: string;
  unit_price_cents: number;
  amount_cents: number;
  billed_at?: string | null;
};

export type ConsolidatedInvoice = {
  billing_period: string;
  maintenance_rate_cents: number;
  discount_cents: number;
  maintenance_net_cents: number;
  check_count: number;
  check_usage_cents: number;
  next_day_count: number;
  next_day_usage_cents: number;
  same_day_count: number;
  same_day_usage_cents: number;
  mortgage_ops_initial_count?: number;
  mortgage_ops_initial_amount_cents?: number;
  mortgage_ops_additional_count?: number;
  mortgage_ops_additional_amount_cents?: number;
  mortgage_ops_usage_cents?: number;
  usage_total_cents: number;
  amount_cents: number;
  allocations?: BillingAllocation[];
  lines?: {
    checks?: unknown[];
    next_day?: unknown[];
    same_day?: unknown[];
    mortgage_ops_initial?: Array<{ unit_price_cents?: number }>;
    mortgage_ops_additional?: Array<{ unit_price_cents?: number }>;
  };
  excluded_voided_checks?: unknown[];
};

export type TenantBillingSnapshot = {
  ok?: boolean;
  error?: string;
  message?: string;
  monthly_rate_cents: number;
  referral_discount_cents: number;
  net_fee_cents: number;
  per_check_rate_cents?: number;
  next_day_rate_cents?: number;
  same_day_rate_cents?: number;
  mortgage_ops_initial_rate_cents?: number;
  mortgage_ops_additional_rate_cents?: number;
  instant_rate_cents?: number | null;
  instant_enabled?: boolean;
  billing_enabled: boolean;
  billing_day_of_month: number;
  next_billing_date: string | null;
  next_period_start?: string | null;
  current_period?: string;
  collection_period?: string;
  pull_period?: string;
  invoice?: ConsolidatedInvoice | null;
  pull_preview?: ConsolidatedInvoice | null;
  current_amount_due_cents?: number;
  funding_source_last4?: string | null;
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
  settled_charges?: BillingOccurrence[];
  failed_charges?: BillingOccurrence[];
  returned_charges?: BillingOccurrence[];
  verification_charges?: BillingOccurrence[];
  verification_post_enabled?: boolean;
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
  const payload = (data || {}) as TenantBillingSnapshot & { authorization?: unknown };
  if (error || payload.ok === false) {
    return { ok: false as const, error: await fnError(error, payload), data: payload };
  }
  return { ok: true as const, data: payload };
}

export async function invokeTenantBillingSnapshot(tenantId: string) {
  return invokeTenantBillingAuthorize({ action: "snapshot", tenant_id: tenantId });
}

export const money = (cents: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);

export const billingPeriodLabel = (period?: string | null) => {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return period || "—";
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

export const occurrenceKindLabel = (row?: { occurrence_kind?: string | null; billing_period?: string | null }) => {
  const kind = String(row?.occurrence_kind || "");
  if (kind === "billing_verification") return "Billing Verification";
  if (kind === "legacy") return "Legacy";
  if (row?.billing_period) return billingPeriodLabel(row.billing_period);
  if (kind === "monthly_subscription") return "Monthly subscription";
  return "Legacy";
};

export const snapshottedRateLabel = (
  lines: Array<{ unit_price_cents?: number }> | undefined,
  fallbackCents: number,
) => {
  const rates = [...new Set((lines || []).map((line) => Number(line.unit_price_cents ?? 0)))];
  if (rates.length === 0) return money(fallbackCents);
  if (rates.length === 1) return `${lines!.length} × ${money(rates[0])}`;
  return rates
    .map((rate) => {
      const count = (lines || []).filter((line) => Number(line.unit_price_cents ?? 0) === rate).length;
      return `${count} × ${money(rate)}`;
    })
    .join(" + ");
};

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
