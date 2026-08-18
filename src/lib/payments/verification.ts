import { supabase } from "@/integrations/supabase/client";

/**
 * Bank ownership verification for recipients who will not use an instant bank
 * login: a $0.01 micro-deposit lands in their account containing a 4-digit
 * verification code (MV####).
 */

export interface BankVerification {
  id: string;
  tenant_id: string;
  payment_method_id: string | null;
  method: "micro_deposit" | "instant";
  status: "initiated" | "pending" | "verified" | "failed" | "max_attempts_exceeded";
  attempts: number;
  max_attempts: number;
  failure_reason: string | null;
  initiated_at: string;
  verified_at: string | null;
}

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

export async function startBankVerification(input: {
  tenantId: string;
  paymentMethodId: string;
  externalRecipientId?: string | null;
}): Promise<{ verification: BankVerification; already_verified?: boolean }> {
  return invoke("moov-micro-deposit-initiate", {
    tenant_id: input.tenantId,
    payment_method_id: input.paymentMethodId,
    external_recipient_id: input.externalRecipientId ?? null,
  });
}

/** code is a 4-digit string, e.g. "1234" */
export async function confirmBankVerification(input: {
  tenantId: string;
  verificationId: string;
  code: string;
}): Promise<{ verification: BankVerification; already_verified?: boolean }> {
  return invoke("moov-micro-deposit-confirm", {
    tenant_id: input.tenantId,
    verification_id: input.verificationId,
    code: input.code,
  });
}

export async function latestBankVerification(
  paymentMethodId: string,
): Promise<BankVerification | null> {
  const { data, error } = await supabase
    .from("payment_method_verifications")
    .select("*")
    .eq("payment_method_id", paymentMethodId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as BankVerification) ?? null;
}
