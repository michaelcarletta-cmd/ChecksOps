import { supabase } from "@/integrations/supabase/client";
import { resolveProvider } from "./featureFlags";
import { getProvider } from "./providers";
import type {
  ConnectBankInput,
  ConnectBankResult,
  CreateTenantAccountInput,
  PaymentAccount,
  PaymentHistoryQuery,
  PaymentProviderId,
  PaymentResult,
  SendPaymentInput,
} from "./types";

/**
 * Provider-agnostic payment service.
 *
 * Business logic and UI call these functions only. Which rail actually runs —
 * Actum, Plaid, or Moov — is resolved per tenant from the tenant row plus the
 * payment feature flags, and never leaks upward.
 */

export async function resolveTenantProvider(tenantId: string): Promise<PaymentProviderId> {
  const { data, error } = await supabase
    .from("tenants")
    .select("payment_provider, payment_rail")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw error;
  return resolveProvider((data as any)?.payment_provider, (data as any)?.payment_rail);
}

async function providerFor(tenantId: string) {
  return getProvider(await resolveTenantProvider(tenantId));
}

export async function createTenantPaymentAccount(
  input: CreateTenantAccountInput,
): Promise<PaymentAccount> {
  return (await providerFor(input.tenantId)).createTenantAccount(input);
}

export async function connectBank(input: ConnectBankInput): Promise<ConnectBankResult> {
  return (await providerFor(input.tenantId)).connectBank(input);
}

export async function verifyPaymentAccount(tenantId: string): Promise<PaymentAccount> {
  return (await providerFor(tenantId)).verifyAccount(tenantId);
}

export async function getPaymentAccount(tenantId: string): Promise<PaymentAccount> {
  return (await providerFor(tenantId)).getAccount(tenantId);
}

export async function sendPayment(input: SendPaymentInput): Promise<PaymentResult> {
  return (await providerFor(input.tenantId)).sendPayment(input);
}

export async function receivePayment(input: SendPaymentInput): Promise<PaymentResult> {
  return (await providerFor(input.tenantId)).receivePayment(input);
}

export async function listPayments(query: PaymentHistoryQuery): Promise<PaymentResult[]> {
  return (await providerFor(query.tenantId)).listPayments(query);
}

export const paymentService = {
  resolveTenantProvider,
  createTenantPaymentAccount,
  connectBank,
  verifyPaymentAccount,
  getPaymentAccount,
  sendPayment,
  receivePayment,
  listPayments,
};
