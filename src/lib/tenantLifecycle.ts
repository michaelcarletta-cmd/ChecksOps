import { supabase } from "@/integrations/supabase/client";
import { functionRefusalMessage } from "@/lib/tenantProfile";

/**
 * Tenant Management item 8 (owner, 2026-10-26), SQL 117 through tenant-billing-admin:
 * any company can be deactivated (hidden, its users lose access, every record kept,
 * reversible); a company with no checks or money movement can be permanently deleted.
 */
export interface DeactivatedTenant {
  tenant_id: string;
  deactivated_at: string;
  reason: string | null;
  previous_subscription_status: string | null;
  suspended_memberships: number;
}

export interface TenantActivity {
  empty: boolean;
  total: number;
  counts: Record<string, number>;
}

type AdminReply = { ok?: boolean; error?: string; message?: string; result?: Record<string, unknown>; deactivated?: DeactivatedTenant[] } | null;

async function lifecycle(body: Record<string, unknown>, fallback: string): Promise<AdminReply> {
  const { data, error } = await supabase.functions.invoke("tenant-billing-admin", { body });
  const refusal = functionRefusalMessage(data, error, fallback);
  if (refusal) throw new Error(refusal);
  return (data ?? null) as AdminReply;
}

export async function listDeactivatedTenants(): Promise<DeactivatedTenant[]> {
  const reply = await lifecycle({ action: "tenants-deactivated" }, "Deactivated companies could not be loaded");
  return reply?.deactivated ?? [];
}

export async function deactivateTenant(tenantId: string, reason: string): Promise<number> {
  const reply = await lifecycle(
    { action: "tenant-deactivate", tenant_id: tenantId, reason: reason.trim() || null },
    "The company was not deactivated",
  );
  return Number(reply?.result?.suspended ?? 0);
}

export async function reactivateTenant(tenantId: string): Promise<number> {
  const reply = await lifecycle({ action: "tenant-reactivate", tenant_id: tenantId }, "The company was not reactivated");
  return Number(reply?.result?.restored ?? 0);
}

export async function tenantActivity(tenantId: string): Promise<TenantActivity> {
  const reply = await lifecycle({ action: "tenant-activity", tenant_id: tenantId }, "The company's records could not be checked");
  const result = (reply?.result ?? {}) as Partial<TenantActivity>;
  return { empty: result.empty === true, total: Number(result.total ?? 0), counts: result.counts ?? {} };
}

export async function deleteEmptyTenant(tenantId: string, confirmSlug: string): Promise<void> {
  await lifecycle(
    { action: "tenant-delete", tenant_id: tenantId, confirm_slug: confirmSlug.trim() },
    "The company was not deleted",
  );
}

/** "check_intake_items" -> "checks"; the rest read as words. */
const ACTIVITY_LABELS: Record<string, string> = {
  check_intake_items: "checks",
  deposit_items: "deposits",
  checkalt_deposits: "Check Alt deposits",
  check_billing_events: "billing events",
  payment_provider_accounts: "payment accounts",
  payment_transfers: "payment transfers",
  payment_wallet_ledger: "wallet ledger entries",
  disbursement_batches: "disbursements",
  external_payment_recipients: "payees",
  moov_invoices: "invoices",
  platform_fee_occurrences: "platform fees",
  tenant_maintenance_payments: "maintenance payments",
  cash_job_payments: "cash job payments",
  homeowner_deductible_payments: "deductible payments",
  claim_check_payments: "claim payments",
  wallet_funding_requests: "wallet funding requests",
};

/** The non-zero counts as "12 checks, 3 payment transfers". */
export function describeTenantActivity(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => Number(n) > 0)
    .map(([table, n]) => `${n} ${ACTIVITY_LABELS[table] ?? table.replace(/_/g, " ")}`)
    .join(", ");
}
