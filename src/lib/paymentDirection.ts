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
  const { data, error } = await supabase
    .from("check_payment_directions")
    .select(`
      *,
      claim_checks (
        id,
        claim_id,
        amount,
        check_number,
        endorsement_status,
        payment_direction_status,
        deposit_status,
        cleared_status
      )
    `)
    .eq("secure_token", token)
    .single();

  if (error) throw error;

  // Expiry check
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    if (data.request_status === "pending") {
      await supabase
        .from("check_payment_directions")
        .update({ request_status: "expired" })
        .eq("id", data.id);
    }
    throw new Error("This payment direction request has expired.");
  }

  return data;
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
  const { data: request, error: requestError } = await supabase
    .from("check_payment_directions")
    .select("*")
    .eq("secure_token", token)
    .single();

  if (requestError) throw requestError;
  if (!request) throw new Error("Payment direction request not found.");

  // Expiry check
  if (request.expires_at && new Date(request.expires_at) < new Date()) {
    await supabase
      .from("check_payment_directions")
      .update({ request_status: "expired" })
      .eq("id", request.id);
    throw new Error("This payment direction request has expired.");
  }

  if (request.request_status !== "pending") {
    throw new Error("This payment direction request is no longer active.");
  }

  const nowIso = new Date().toISOString();

  const { data: updated, error: updateError } = await supabase
    .from("check_payment_directions")
    .update({
      request_status: "answered",
      decision,
      answered_at: nowIso,
      answer_source: source,
      answer_notes: notes ?? null,
    })
    .eq("id", request.id)
    .select()
    .single();

  if (updateError) throw updateError;

  await supabase
    .from("claim_checks")
    .update({
      payment_direction_status: decision === "pay_contractor" ? "pay_contractor" : "pay_insured",
    })
    .eq("id", request.check_id);

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
