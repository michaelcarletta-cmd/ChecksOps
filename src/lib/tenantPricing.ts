import { supabase } from "@/integrations/supabase/client";
import { isAwsStaging } from "@/lib/awsStaging";
import { functionRefusalMessage } from "@/lib/tenantProfile";

/**
 * What ChecksOps charges a tenant. Set by the platform owner only, from Tenant
 * Management; tenant members see these values read-only. On AWS the save goes
 * through tenant-billing-admin (is_platform_owner(), SQL 96 setter, audited);
 * the generic tenants update never carries pricing. A `null` rate clears the
 * tenant's override so the default rate applies.
 */
export interface TenantPricingPatch {
  monthly_rate_cents?: number;
  referral_discount_cents?: number;
  is_founding_partner?: boolean;
  per_check_billing_enabled?: boolean;
  per_check_rate_cents?: number | null;
  next_day_rate_cents?: number | null;
  same_day_rate_cents?: number | null;
  mortgage_ops_initial_rate_cents?: number | null;
  mortgage_ops_additional_rate_cents?: number | null;
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

/**
 * Saves the patch and returns the pricing the server saved, when the reply
 * carries it (`pricing`); null means the caller keeps its patch.
 */
export async function saveTenantPricing(tenantId: string, patch: TenantPricingPatch): Promise<TenantPricingPatch | null> {
  const pricing: Record<string, unknown> = {};
  for (const key of TENANT_PRICING_KEYS) {
    if (patch[key] !== undefined) pricing[key] = patch[key];
  }
  if (Object.keys(pricing).length === 0) return null;
  if (isAwsStaging()) {
    const { data, error } = await supabase.functions.invoke("tenant-billing-admin", {
      body: { action: "update", tenant_id: tenantId, ...pricing },
    });
    const refusal = functionRefusalMessage(data, error, "Pricing was not saved");
    if (refusal) throw new Error(refusal);
    return savedPricingFromReply(data);
  }
  const { error } = await supabase.from("tenants").update(pricing as never).eq("id", tenantId);
  if (error) throw error;
  return null;
}

function savedPricingFromReply(data: unknown): TenantPricingPatch | null {
  const saved = (data as { pricing?: unknown } | null)?.pricing;
  if (!saved || typeof saved !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const key of TENANT_PRICING_KEYS) {
    if (key in (saved as Record<string, unknown>)) out[key] = (saved as Record<string, unknown>)[key];
  }
  return Object.keys(out).length ? (out as TenantPricingPatch) : null;
}
