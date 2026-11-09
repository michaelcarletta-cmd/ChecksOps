import { supabase } from "@/integrations/supabase/client";

/**
 * A payment made outside ChecksOps (a paper check, cash, a bank transfer elsewhere), recorded
 * against a ChecksOps check so tracking counts it like a sent payment: remaining to disburse,
 * Funds Released, stakeholder balances, Payments & Financials and the reports. The server
 * (route record-external-disbursement, SQL 147) records one completed batch and one settled
 * "external_check" split per payee in one transaction, checks the amount available on the check,
 * and never calls the payment provider: no money moves and the wallet balance is unchanged.
 */

export const EXTERNAL_DISBURSEMENT_FUNCTION = "record-external-disbursement";

export interface ExternalPayment {
  amount_cents: number;
  recipient_name?: string | null;
  recipient_type?: string | null;
  external_check_number?: string | null;
  memo?: string | null;
  stakeholder_account_id?: string | null;
}

export interface ExternalDisbursementResult {
  batch_id: string;
  split_ids: string[];
  duplicate: boolean;
  total_cents: number;
  remaining_cents: number;
  fully_disbursed: boolean;
}

export class ExternalDisbursementError extends Error {
  constructor(message: string, readonly code: string | null, readonly availableCents: number | null = null) {
    super(message);
    this.name = "ExternalDisbursementError";
  }
}

/** Dollars typed by the user, to whole cents. */
export const dollarsToCents = (value: string | number): number => Math.round((Number(value) || 0) * 100);

/** One key per recorded payment: a retry or double click with the same key never records twice. */
export const newExternalDisbursementKey = (): string => crypto.randomUUID();

type Reply = { error?: unknown; message?: unknown; available_cents?: unknown } & Partial<ExternalDisbursementResult>;

export async function recordExternalDisbursement(input: {
  tenantId: string;
  checkId: string;
  payments: ExternalPayment[];
  idempotencyKey: string;
}): Promise<ExternalDisbursementResult> {
  const { data, error } = await supabase.functions.invoke(EXTERNAL_DISBURSEMENT_FUNCTION, {
    body: {
      tenant_id: input.tenantId,
      check_intake_item_id: input.checkId,
      idempotency_key: input.idempotencyKey,
      payments: input.payments,
    },
  });
  const failure = (reply: Reply | null | undefined, fallback: string) => {
    const code = typeof reply?.error === "string" ? reply.error : null;
    const message = typeof reply?.message === "string" && reply.message ? reply.message : code || fallback;
    const available = typeof reply?.available_cents === "number" ? reply.available_cents : null;
    return new ExternalDisbursementError(message, code, available);
  };
  if (error) {
    const context = (error as { context?: { body?: unknown; json?: () => Promise<Reply> } }).context;
    let reply: Reply | null = null;
    if (typeof context?.json === "function") {
      try {
        reply = await context.json();
      } catch {
        /* keep the original message */
      }
    } else if (context?.body && typeof context.body === "object") {
      reply = context.body as Reply;
    }
    reply = reply ?? (data as Reply | null) ?? null;
    throw failure(reply, error.message ?? "The payment could not be recorded");
  }
  const reply = data as Reply | null;
  if (reply?.error || !reply?.batch_id) throw failure(reply, "The payment could not be recorded");
  return reply as ExternalDisbursementResult;
}
