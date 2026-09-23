import { supabase } from "@/integrations/aws/client";
import {
  type ConnectBankInput,
  type ConnectBankResult,
  type CreateTenantAccountInput,
  type PaymentAccount,
  type PaymentHistoryQuery,
  type PaymentProvider,
  type PaymentResult,
  type PaymentStatus,
  type SendPaymentInput,
} from "../types";
import { readTenantPaymentAccount } from "./tenantAccount";

/**
 * Moov adapter.
 *
 * ChecksOps runs as the platform: every tenant gets its own connected account,
 * its own bank connection, its own capabilities, and its own payment history.
 * Funds never sit with ChecksOps — they stay in the tenant's own bank account
 * until that tenant initiates a payment.
 *
 * Every provider call goes through a secure backend function. No provider
 * credentials, tokens, or bank numbers ever exist in client code.
 */

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message ?? `${fn} failed`;
    try {
      const parsed = await (error as any).context?.json?.();
      if (parsed?.message) message = parsed.message;
      else if (parsed?.error) message = parsed.error;
    } catch {
      /* keep the original message */
    }
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export const moovProvider: PaymentProvider = {
  id: "moov",
  label: "Moov",

  async createTenantAccount(input: CreateTenantAccountInput): Promise<PaymentAccount> {
    await invoke("moov-account-create", { tenant_id: input.tenantId });
    return moovProvider.verifyAccount(input.tenantId);
  },

  async connectBank(input: ConnectBankInput): Promise<ConnectBankResult> {
    const res = await invoke<{ token: string; account_id: string }>("moov-bank-link-token", {
      tenant_id: input.tenantId,
    });
    return { token: res.token, url: null, status: "pending" };
  },

  async verifyAccount(tenantId: string): Promise<PaymentAccount> {
    // Server-side sync: pulls the live account, capabilities and bank list.
    await invoke("moov-sync", { tenant_id: tenantId });
    return readTenantPaymentAccount(tenantId, "moov");
  },

  async getAccount(tenantId: string): Promise<PaymentAccount> {
    return readTenantPaymentAccount(tenantId, "moov");
  },

  async sendPayment(input: SendPaymentInput): Promise<PaymentResult> {
    const recipientTenantId =
      input.recipient.kind === "business" ? input.recipient.tenantId ?? null : null;

    const res = await invoke<{ transfer: Record<string, any>; duplicate: boolean }>(
      "moov-transfer-create",
      {
        tenant_id: input.tenantId,
        amount_cents: input.amountCents,
        speed: input.speed,
        description: input.description ?? null,
        claim_id: input.claimId ?? null,
        check_id: input.checkId ?? null,
        recipient_tenant_id: recipientTenantId,
        external_recipient_id: recipientTenantId ? null : input.recipient.id,
        idempotency_key: input.idempotencyKey,
      },
    );

    const t = res.transfer ?? {};
    return {
      id: t.id,
      provider: "moov",
      status: (t.status ?? "submitted") as PaymentStatus,
      amountCents: Number(t.amount_cents ?? input.amountCents),
      speed: input.speed,
      externalId: t.provider_transfer_id ?? null,
      error: t.failure_reason ?? null,
    };
  },

  async receivePayment(_input: SendPaymentInput): Promise<PaymentResult> {
    // Inbound collection is not part of the sandbox scope: checks are deposited
    // through the existing CheckAlt rail, which is untouched.
    throw new Error("Inbound collection is handled by the existing deposit rail.");
  },

  async listPayments(query: PaymentHistoryQuery): Promise<PaymentResult[]> {
    let q = supabase
      .from("payment_transfers")
      .select("id, status, amount_cents, speed, provider_transfer_id, failure_reason, created_at")
      .eq("tenant_id", query.tenantId)
      .eq("provider", "moov")
      .order("created_at", { ascending: false })
      .limit(query.limit ?? 50);
    if (query.since) q = q.gte("created_at", query.since);

    const { data, error } = await q;
    if (error) throw error;

    return (data ?? []).map((row: any) => ({
      id: row.id,
      provider: "moov" as const,
      status: row.status as PaymentStatus,
      amountCents: Number(row.amount_cents),
      speed: row.speed,
      externalId: row.provider_transfer_id,
      error: row.failure_reason,
    }));
  },
};
