import { supabase } from "@/integrations/supabase/client";
import type {
  BankConnectionStatus,
  PaymentAccount,
  PaymentAccountStatus,
  PaymentProviderId,
  VerificationStatus,
} from "../types";

/**
 * Shared helper: reads the provider-neutral payment account columns off the
 * tenant row. Every provider stores its state in the same shape, so the UI
 * never has to know which rail produced it.
 */
export async function readTenantPaymentAccount(
  tenantId: string,
  provider: PaymentProviderId,
): Promise<PaymentAccount> {
  const { data, error } = await supabase
    .from("tenants")
    .select(
      "id, payment_provider, moov_account_id, payment_status, bank_connection_status, bank_name, bank_last_four, verification_status, last_sync",
    )
    .eq("id", tenantId)
    .maybeSingle();

  if (error) throw error;
  const row = (data ?? {}) as Record<string, any>;

  return {
    tenantId,
    provider,
    externalAccountId: row.moov_account_id ?? null,
    status: (row.payment_status ?? "not_connected") as PaymentAccountStatus,
    verificationStatus: (row.verification_status ?? "not_started") as VerificationStatus,
    bankConnectionStatus: (row.bank_connection_status ?? "not_connected") as BankConnectionStatus,
    bankName: row.bank_name ?? null,
    bankLastFour: row.bank_last_four ?? null,
    lastSync: row.last_sync ?? null,
  };
}
