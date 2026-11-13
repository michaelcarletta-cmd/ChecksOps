import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";
import {
  VENDOR_PAYEE_ADD_RPC,
  VENDOR_PAYEE_REMOVE_RPC,
  VENDOR_PAYEES_LIST_RPC,
  vendorPayeeErrorMessage,
  vendorPayeeRows,
  type VendorPayee,
} from "@/lib/payments/vendorPayees";

type RpcError = { message?: string; code?: string } | null;
type RpcCall = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError }>;
// The vendor payee functions are AWS-only (/data/rpc), so they are not in the generated Supabase types.
const rpc = (name: string, args?: Record<string, unknown>) => (supabase.rpc as unknown as RpcCall).call(supabase, name, args);

type VendorReply = { ok?: boolean; error?: unknown; message?: unknown } & Record<string, unknown>;

const refusal = (data: unknown, error: RpcError, fallback: string): Error | null => {
  if (error) return new Error(vendorPayeeErrorMessage(error.message ?? null, null, fallback));
  const reply = (data && typeof data === "object" ? data : null) as VendorReply | null;
  if (reply?.ok === false) {
    const code = typeof reply.error === "string" ? reply.error : null;
    return new Error(vendorPayeeErrorMessage(code, typeof reply.message === "string" ? reply.message : null, fallback));
  }
  return null;
};

export const VENDOR_PAYEES_QUERY_KEY = "vendor-payees";

export async function listVendorPayees(tenantId: string): Promise<VendorPayee[]> {
  const { data, error } = await rpc(VENDOR_PAYEES_LIST_RPC, { tenant_id: tenantId });
  const failed = refusal(data, error, "Vendors could not be loaded");
  if (failed) throw failed;
  return vendorPayeeRows(data);
}

export async function addVendorPayee(tenantId: string, partnerCode: string): Promise<{ vendor_tenant_id: string; vendor_name: string | null; replayed: boolean }> {
  const { data, error } = await rpc(VENDOR_PAYEE_ADD_RPC, { tenant_id: tenantId, partner_code: partnerCode });
  const failed = refusal(data, error, "The vendor was not added");
  if (failed) throw failed;
  const reply = (data ?? {}) as VendorReply;
  return {
    vendor_tenant_id: String(reply.vendor_tenant_id ?? ""),
    vendor_name: typeof reply.vendor_name === "string" ? reply.vendor_name : null,
    replayed: reply.replayed === true,
  };
}

export async function removeVendorPayee(tenantId: string, vendorTenantId: string): Promise<void> {
  const { data, error } = await rpc(VENDOR_PAYEE_REMOVE_RPC, { tenant_id: tenantId, vendor_tenant_id: vendorTenantId });
  const failed = refusal(data, error, "The vendor was not removed");
  if (failed) throw failed;
}

/** This tenant's vendor payees (empty while the flag is off). */
export function useVendorPayees(tenantId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: [VENDOR_PAYEES_QUERY_KEY, tenantId],
    queryFn: () => listVendorPayees(tenantId as string),
    enabled: PAYMENT_FLAGS.SHOW_VENDOR_PAYMENTS && !!tenantId && enabled,
    staleTime: 30_000,
  });
}
