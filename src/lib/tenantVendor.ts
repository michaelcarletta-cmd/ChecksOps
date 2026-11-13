import { supabase } from "@/integrations/supabase/client";
import { functionRefusalMessage } from "@/lib/tenantProfile";
import { TENANT_VENDOR_SET_ACTION, TENANT_VENDOR_STATUS_ACTION } from "@/lib/payments/vendorPayees";

/**
 * Per-tenant Vendor switch (platform owner only, Tenant Management → Company). When on, other
 * tenants can add this tenant as a vendor by its Partner Code and pay its ChecksOps wallet. Read
 * and saved through tenant-billing-admin (vendor-status / vendor-set), which the API allows for
 * the platform owner only and audits. Turning it off leaves existing vendor payees in place,
 * marked "No longer a vendor"; the server refuses new payments to them.
 */
export const VENDOR_SWITCH_HELP =
  "When on, other companies can add this company as a vendor by its Partner Code and pay its ChecksOps wallet. It creates no partnership and shares nothing.";

export async function fetchTenantVendorStatus(tenantId: string): Promise<boolean> {
  const { data, error } = await supabase.functions.invoke("tenant-billing-admin", {
    body: { action: TENANT_VENDOR_STATUS_ACTION, tenant_id: tenantId },
  });
  const refusal = functionRefusalMessage(data, error, "Vendor setting could not be read");
  if (refusal) throw new Error(refusal);
  return (data as { is_vendor?: unknown } | null)?.is_vendor === true;
}

export async function saveTenantVendor(tenantId: string, isVendor: boolean): Promise<boolean> {
  const { data, error } = await supabase.functions.invoke("tenant-billing-admin", {
    body: { action: TENANT_VENDOR_SET_ACTION, tenant_id: tenantId, is_vendor: isVendor },
  });
  const refusal = functionRefusalMessage(data, error, "Vendor setting was not saved");
  if (refusal) throw new Error(refusal);
  const saved = (data as { is_vendor?: unknown } | null)?.is_vendor;
  return typeof saved === "boolean" ? saved : isVendor;
}
