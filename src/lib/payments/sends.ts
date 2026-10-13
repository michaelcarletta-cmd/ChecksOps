import { supabase } from "@/integrations/supabase/client";

/**
 * Sends from the Funds tab: the organization's balance pays stakeholders and the
 * partners a check is shared with. When the balance is short, the server sends the
 * available part from the balance and the shortfall straight from the linked bank.
 */

export type SendRecipient =
  | { kind: "stakeholder"; stakeholder_account_id: string; amount_cents: number }
  | { kind: "partner"; partner_tenant_id: string; amount_cents: number };

export interface SendRecipientResult {
  index: number;
  kind: "stakeholder" | "partner";
  id: string;
  name: string | null;
  destination: "bank" | "wallet" | null;
  amount_cents: number;
  sent_cents: number;
  unknown_cents: number;
  unsent_cents: number;
}

export interface SendSummary {
  recipients: SendRecipientResult[];
  amount_cents: number;
  sent_cents: number;
  unknown_cents: number;
  unsent_cents: number;
}

/** A send the server did not fully complete; `code` is the server's error code. */
export class SendPaymentError extends Error {
  constructor(message: string, readonly code: string | null, readonly send: SendSummary | null = null) {
    super(message);
    this.name = "SendPaymentError";
  }
}

type SendReply = { error?: unknown; message?: unknown; send?: SendSummary };

/**
 * `idempotencyKey` identifies one click: retrying with the same key never sends
 * twice and reports what that click actually did.
 */
export async function sendPayment(input: {
  tenantId: string;
  checkId: string;
  claimId?: string | null;
  speed: "standard" | "same_day";
  recipients: SendRecipient[];
  idempotencyKey: string;
}): Promise<{ send: SendSummary; duplicate: boolean; message?: string }> {
  const { data, error } = await supabase.functions.invoke("moov-disburse", {
    body: {
      tenant_id: input.tenantId,
      check_id: input.checkId,
      claim_id: input.claimId ?? null,
      speed: input.speed,
      recipients: input.recipients,
      idempotency_key: input.idempotencyKey,
    },
  });
  const failure = (reply: SendReply | null | undefined, fallback: string) => {
    const code = typeof reply?.error === "string" ? reply.error : null;
    const message = typeof reply?.message === "string" && reply.message ? reply.message : code || fallback;
    return new SendPaymentError(message, code, reply?.send ?? null);
  };
  if (error) {
    // Supabase puts a Response on `context`; AWS puts the parsed reply on `context.body` (and `data`).
    const context = (error as { context?: { body?: unknown; json?: () => Promise<SendReply> } }).context;
    let reply: SendReply | null = null;
    if (typeof context?.json === "function") {
      try {
        reply = await context.json();
      } catch {
        /* keep the original message */
      }
    } else if (context?.body && typeof context.body === "object") {
      reply = context.body as SendReply;
    }
    reply = reply ?? (data as SendReply | null) ?? null;
    throw failure(reply, error.message ?? "The payment could not be sent");
  }
  if ((data as SendReply | null)?.error) throw failure(data as SendReply, "The payment could not be sent");
  return data as { send: SendSummary; duplicate: boolean; message?: string };
}
