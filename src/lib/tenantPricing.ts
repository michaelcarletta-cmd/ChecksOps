import { supabase } from "@/integrations/supabase/client";
import { isAwsStaging } from "@/lib/awsStaging";

/**
 * What ChecksOps charges a tenant. Set by the platform owner only, from Tenant
 * Management; tenant members see these values read-only. On AWS the save goes
 * through tenant-billing-admin (is_platform_owner(), SQL 96 setter, audited);
 * the generic tenants update never carries pricing.
 */
export interface TenantPricingPatch {
  monthly_rate_cents?: number;
  referral_discount_cents?: number;
  is_founding_partner?: boolean;
  per_check_billing_enabled?: boolean;
  per_check_rate_cents?: number;
  next_day_rate_cents?: number;
  same_day_rate_cents?: number;
  mortgage_ops_initial_rate_cents?: number;
  mortgage_ops_additional_rate_cents?: number;
}

export const TENANT_PRICING_KEYS: ReadonlyArray<keyof TenantPricingPatch> = [
  "monthly_rate_cents",
  "referral_discount_cents",
  "is_founding_partner",
  "per_check_billing_enabled",
  "per_check_rate_cents",
  "next_day_rate_cents",
  "same_day_rate_cents",
  "mortgage_ops_initial_rate_cents",
  "mortgage_ops_additional_rate_cents",
];

export async function saveTenantPricing(tenantId: string, patch: TenantPricingPatch): Promise<void> {
  const pricing: Record<string, unknown> = {};
  for (const key of TENANT_PRICING_KEYS) {
    if (patch[key] !== undefined) pricing[key] = patch[key];
  }
  if (Object.keys(pricing).length === 0) return;
  if (isAwsStaging()) {
    const { data, error } = await supabase.functions.invoke("tenant-billing-admin", {
      body: { action: "update", tenant_id: tenantId, ...pricing },
    });
    if (error) throw error;
    const body = data as { ok?: boolean; error?: string; message?: string } | null;
    if (body && body.ok === false) throw new Error(body.message || body.error || "Pricing was not saved");
    return;
  }
  const { error } = await supabase.from("tenants").update(pricing as never).eq("id", tenantId);
  if (error) throw error;
}
