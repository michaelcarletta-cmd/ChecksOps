import { supabase } from "@/integrations/supabase/client";

/**
 * Tenant fee collection (platform owner only, Tenant Management).
 *
 * Owner decision (2026-10-17): fees are collected manually. The server
 * computes the amount from the tenant's Billing tab rates and recorded usage;
 * the browser never sends an amount. Flow: preview (server invoice + hash),
 * confirm dialog with the server total, then pull with the preview hash. The
 * server charges only if the invoice still matches the preview.
 */

export interface FeeSummaryLine {
  key: string;
  label: string;
  count: number;
  amount_cents: number;
}

export interface FeePreview {
  ok: boolean;
  tenant_id: string;
  period: string;
  environment: string;
  amount_cents: number;
  summary: FeeSummaryLine[];
  existing_charge: { id: string; status: string; amount_cents: number; provider_transfer_id: string | null } | null;
  already_charged: boolean;
  destination: { configured: boolean; source?: string; label?: string; error?: string; reason?: string };
  readiness: { ready: boolean; reasons: string[] };
  preview_hash: string;
}

export interface FeeChargeResult {
  ok: boolean;
  charged: boolean;
  duplicate?: boolean;
  amount_cents_posted?: number | null;
  provider_transfer_ids?: string[];
  error?: string;
  message?: string;
  pull?: { error?: string | null; reason?: string; simulated?: boolean; occurrence?: { status?: string } | null };
  verify?: { error?: string | null; simulated?: boolean; occurrence?: { status?: string } | null };
}

export interface FeeDestinationStatus {
  environment: string;
  configured: boolean;
  source: "env" | "table" | string | null;
  env_override: boolean;
  account_id: string | null;
  payment_method_id: string | null;
  label: string | null;
  error: string | null;
  reason: string | null;
  expected_sandbox_account_id: string | null;
}

type AdminBody = Record<string, unknown> & { action: string };

/** Calls tenant-billing-admin; returns the JSON body for 2xx and non-2xx answers alike. */
async function callBillingAdmin<T>(body: AdminBody): Promise<T & { ok: boolean; error?: string; message?: string }> {
  const { data, error } = await supabase.functions.invoke("tenant-billing-admin", { body });
  const payload = (data ?? (error as { context?: { body?: unknown } } | null)?.context?.body ?? null) as
    | (T & { ok: boolean; error?: string; message?: string })
    | null;
  if (payload && typeof payload === "object") return payload;
  let parsed: unknown = null;
  try {
    parsed = await (error as { context?: { json?: () => Promise<unknown> } } | null)?.context?.json?.();
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") return parsed as T & { ok: boolean };
  return { ok: false, error: error?.message ?? "request_failed" } as T & { ok: boolean; error?: string };
}

export const feeErrorText = (result: { error?: string | null; message?: string | null } | null | undefined) =>
  result?.message || result?.error || "Request failed";

export const previewTenantFees = (tenantId: string, period?: string) =>
  callBillingAdmin<FeePreview>({ action: "preview", tenant_id: tenantId, ...(period ? { period } : {}) });

/** Sends only the period and the server's preview hash: never an amount. */
export const pullTenantFees = (tenantId: string, period: string, previewHash: string) =>
  callBillingAdmin<FeeChargeResult>({
    action: "pull",
    tenant_id: tenantId,
    period,
    preview_hash: previewHash,
    confirm: true,
  });

/** $1.00 verification debit (server-fixed amount). One verification id per confirmed attempt. */
export const verifyTenantBillingDebit = (tenantId: string, verificationId: string) =>
  callBillingAdmin<FeeChargeResult>({
    action: "verify-debit",
    tenant_id: tenantId,
    verification_id: verificationId,
    confirm: true,
  });

export const getFeeDestination = () =>
  callBillingAdmin<{ destination: FeeDestinationStatus }>({ action: "destination-get" });

export const setFeeDestination = (input: { accountId: string; paymentMethodId: string; label?: string }) =>
  callBillingAdmin<{ destination: FeeDestinationStatus }>({
    action: "destination-set",
    moov_account_id: input.accountId.trim(),
    moov_payment_method_id: input.paymentMethodId.trim(),
    ...(input.label ? { label: input.label.trim() } : {}),
  });

export const usd = (cents: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);

/** UTC billing period key (YYYY-MM) for a calendar month (0-11). */
export const billingPeriodKey = (year: number, monthIndex: number) =>
  `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
