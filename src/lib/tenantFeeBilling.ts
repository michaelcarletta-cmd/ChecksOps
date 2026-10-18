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
  pull?: {
    error?: string | null;
    reason?: string;
    simulated?: boolean;
    occurrence?: { status?: string } | null;
    invoice_email?: { status?: string; sent?: boolean } | null;
  };
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

/** Readable text for the server's billing readiness / refusal codes. */
export const REASON_TEXT: Record<string, string> = {
  tenant_inactive: "The organization is not active.",
  billing_paused: "Billing is paused for this organization.",
  missing_authorization: "No member of this organization has authorized ACH billing yet.",
  auto_debit_disabled: "The organization turned off billing debits.",
  missing_ach_authorization: "ACH authorization is missing.",
  missing_funding_source: "No authorized bank account.",
  invalid_amount: "Nothing to collect for this period.",
  invalid_amount_cents: "The amount due is not a valid charge.",
  destination_unresolved: "The ChecksOps fee destination is not set.",
  billing_destination_unresolved: "The ChecksOps fee destination is not set.",
  destination_not_configured: "No fee destination has been saved for this environment yet.",
  destination_ids_required: "Enter both the platform account id and the payment method id.",
  sandbox_destination_must_be_checksops_merchant: "On sandbox the destination must be the ChecksOps platform account.",
  production_destination_cannot_be_sandbox_merchant: "Production can't use the sandbox platform account.",
  moov_account_missing: "The organization has no payment account.",
  moov_account_inactive: "The organization's payment account is not active.",
  ach_capability_unavailable: "ACH debits are not available on the organization's account.",
  funding_source_not_found: "The authorized bank account was not found.",
  funding_source_account_mismatch: "The authorized bank account belongs to a different payment account.",
  bank_disconnected: "The authorized bank account is disconnected.",
  funding_source_cannot_debit: "The authorized bank account cannot be debited.",
  monthly_billing_disabled: "Fee collection is not enabled on this environment.",
};

export const reasonText = (reason: string) => REASON_TEXT[reason] ?? reason.replace(/_/g, " ");

export const OUTDATED_BILLING_SERVICE = "The billing service on this server is out of date.";

type FeeRefusal = {
  error?: string | null;
  message?: string | null;
  reason?: string | null;
  reasons?: unknown;
  readiness?: { reasons?: unknown } | null;
} | null | undefined;

const reasonList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((r): r is string => typeof r === "string" && r.length > 0) : [];

/** Every toast text: the server message, else mapped reasons, else the mapped code. */
export const feeErrorText = (result: FeeRefusal) => {
  if (result?.message) return result.message;
  const reasons = [...reasonList(result?.reasons), ...reasonList(result?.readiness?.reasons)];
  if (reasons.length) return [...new Set(reasons)].map(reasonText).join(" ");
  if (result?.reason) return reasonText(result.reason);
  if (result?.error) return reasonText(result.error);
  return "Request failed";
};

/** A preview reply this SPA can render (older servers lack summary / preview_hash). */
export const isUsableFeePreview = (preview: Partial<FeePreview> | null | undefined): preview is FeePreview =>
  !!preview
  && Array.isArray(preview.summary)
  && typeof preview.preview_hash === "string"
  && preview.preview_hash.length > 0
  && !!preview.readiness
  && Array.isArray(preview.readiness.reasons);

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

/** Platform owner resends a charged period's invoice email (server sends at most once per charge). */
export const resendTenantFeeInvoice = (tenantId: string, period: string) =>
  callBillingAdmin<{ invoice_email?: { status?: string; sent?: boolean } }>({
    action: "invoice-resend",
    tenant_id: tenantId,
    period,
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
