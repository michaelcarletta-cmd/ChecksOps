import { supabase } from "@/integrations/supabase/client";

type CreatePaymentDirectionParams = {
  claimId: string;
  checkId: string;
  contractorName?: string | null;
  expiresInDays?: number;
};

export async function createPaymentDirectionRequest({
  claimId,
  checkId,
  contractorName,
  expiresInDays = 21,
}: CreatePaymentDirectionParams) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const { data, error } = await supabase
    .from("check_payment_directions")
    .insert({
      claim_id: claimId,
      check_id: checkId,
      contractor_name: contractorName ?? null,
      request_status: "pending",
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from("claim_checks")
    .update({
      payment_direction_status: "requested",
    })
    .eq("id", checkId);

  await logClaimEvent({
    claimId,
    eventType: "payment_direction_requested",
    summary: "Payment direction request sent to client.",
    metadata: {
      check_id: checkId,
      payment_direction_id: data.id,
    },
  });

  return data;
}

export async function getPaymentDirectionByToken(token: string) {
  const { data, error } = await supabase.rpc("get_payment_direction_by_token", {
    _token: token,
  });

  if (error) throw error;
  if (!data) throw new Error("Payment direction request not found.");
  if ((data as any).request_status === "expired") {
    throw new Error("This payment direction request has expired.");
  }
  return data as any;
}

type SubmitPaymentDirectionParams = {
  token: string;
  decision: "pay_contractor" | "pay_insured";
  source?: "email" | "sms" | "portal" | "manual";
  notes?: string | null;
};

export async function submitPaymentDirection({
  token,
  decision,
  source = "portal",
  notes,
}: SubmitPaymentDirectionParams) {
  const { data: updated, error: updateError } = await supabase.rpc(
    "submit_payment_direction_by_token",
    {
      _token: token,
      _decision: decision,
      _source: source,
      _notes: notes ?? null,
    },
  );

  if (updateError) throw updateError;
  const request = updated as any;

  await createDraftDisbursementFromDecision({
    claimId: request.claim_id,
    checkId: request.check_id,
    paymentDirectionId: request.id,
    decision,
    contractorName: request.contractor_name,
  });

  await logClaimEvent({
    claimId: request.claim_id,
    eventType: "payment_direction_answered",
    summary:
      decision === "pay_contractor"
        ? "Client authorized payment to contractor."
        : "Client requested funds be sent to insured.",
    metadata: {
      check_id: request.check_id,
      payment_direction_id: request.id,
      decision,
    },
  });

  return updated;
}


type DraftDisbursementParams = {
  claimId: string;
  checkId: string;
  paymentDirectionId: string;
  decision: "pay_contractor" | "pay_insured";
  contractorName?: string | null;
};

export async function createDraftDisbursementFromDecision({
  claimId,
  checkId,
  paymentDirectionId,
  decision,
  contractorName,
}: DraftDisbursementParams) {
  // Idempotency: check for existing draft
  const { data: existing } = await supabase
    .from("claim_disbursements")
    .select("id")
    .eq("payment_direction_id", paymentDirectionId)
    .maybeSingle();

  if (existing) return existing;

  const recipientType = decision === "pay_contractor" ? "contractor" : "insured";
  const recipientName = decision === "pay_contractor" ? contractorName ?? "Contractor" : "Insured";

  const { error } = await supabase
    .from("claim_disbursements")
    .insert({
      claim_id: claimId,
      check_id: checkId,
      payment_direction_id: paymentDirectionId,
      recipient_type: recipientType,
      recipient_name: recipientName,
      method: "manual",
      status: "draft",
    });

  if (error) throw error;
}

type LogClaimEventParams = {
  claimId: string;
  eventType: string;
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export async function logClaimEvent({
  claimId,
  eventType,
  summary,
  metadata = {},
}: LogClaimEventParams) {
  const { error } = await supabase.from("claim_events").insert([{
    claim_id: claimId,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    date_source: "system",
    summary,
    metadata_json: metadata,
  }]);

  if (error) {
    console.warn("[paymentDirection] claim event insert failed", error);
  }
}
