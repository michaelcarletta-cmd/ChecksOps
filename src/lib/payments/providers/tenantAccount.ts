import { supabase } from "@/integrations/supabase/client";
import type {
  AccountCapabilities,
  AccountOnboardingStatus,
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
 *
 * For providers that keep a live capability snapshot (`payment_provider_accounts`),
 * the onboarding status and capabilities come from that row so the UI is never
 * driven by a stale local `payment_status`.
 */
export async function readTenantPaymentAccount(
  tenantId: string,
  provider: PaymentProviderId,
): Promise<PaymentAccount> {
  const { data, error } = await supabase
    .from("tenants")
    .select(
      "id, payment_provider, moov_account_id, moov_environment, payment_status, bank_connection_status, bank_name, bank_last_four, verification_status, last_sync",
    )
    .eq("id", tenantId)
    .maybeSingle();

  if (error) throw error;
  const row = (data ?? {}) as Record<string, any>;

  const base: PaymentAccount = {
    tenantId,
    provider,
    externalAccountId: row.moov_account_id ?? null,
    status: (row.payment_status ?? "not_connected") as PaymentAccountStatus,
    verificationStatus: (row.verification_status ?? "not_started") as VerificationStatus,
    bankConnectionStatus: (row.bank_connection_status ?? "not_connected") as BankConnectionStatus,
    bankName: row.bank_name ?? null,
    bankLastFour: row.bank_last_four ?? null,
    lastSync: row.last_sync ?? null,
    onboardingStatus: "not_started",
    capabilities: null,
  };

  const environment = String(row.moov_environment || "sandbox").toLowerCase() === "production"
    ? "production"
    : "sandbox";

  const { data: providerRow } = await supabase
    .from("payment_provider_accounts")
    .select(
      "provider_account_id, onboarding_status, verification_status, can_receive_payments, can_send_payments, can_ach_debit, can_ach_credit, requirements, restricted, disabled, last_synced_at, environment",
    )
    .eq("tenant_id", tenantId)
    .eq("provider", provider)
    .eq("environment", environment)
    .maybeSingle();

  if (!providerRow) return base;

  const p = providerRow as Record<string, any>;
  const capabilities: AccountCapabilities = {
    canReceivePayments: !!p.can_receive_payments,
    canSendPayments: !!p.can_send_payments,
    canAchDebit: !!p.can_ach_debit,
    canAchCredit: !!p.can_ach_credit,
    verificationPending: p.onboarding_status === "verification_pending",
    informationRequired: Array.isArray(p.requirements) ? p.requirements : [],
    restricted: !!p.restricted,
    disabled: !!p.disabled,
  };

  return {
    ...base,
    externalAccountId: p.provider_account_id ?? base.externalAccountId,
    onboardingStatus: (p.onboarding_status ?? "not_started") as AccountOnboardingStatus,
    capabilities,
    lastSync: p.last_synced_at ?? base.lastSync,
  };
}
