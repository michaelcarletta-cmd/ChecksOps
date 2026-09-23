import { supabase } from "@/integrations/aws/client";
import { createPaymentDirectionRequest } from "@/lib/paymentDirection";

type OnEndorsementCompletedParams = {
  claimId: string;
  checkId: string;
};

export async function onEndorsementCompleted({
  claimId,
  checkId,
}: OnEndorsementCompletedParams) {
  const { data: check, error } = await supabase
    .from("claim_checks")
    .select("id, claim_id, endorsement_status")
    .eq("id", checkId)
    .single();

  if (error) throw error;
  if (!check) throw new Error("Check not found.");

  await supabase
    .from("claim_checks")
    .update({
      endorsement_status: "signed",
    })
    .eq("id", checkId);

  const { data: existingRequest } = await supabase
    .from("check_payment_directions")
    .select("id")
    .eq("check_id", checkId)
    .eq("request_status", "pending")
    .maybeSingle();

  if (!existingRequest) {
    const request = await createPaymentDirectionRequest({
      claimId,
      checkId,
      expiresInDays: 21,
    });

    await sendPaymentDirectionEmail({
      claimId,
      checkId,
      token: request.secure_token,
    });
  }
}

type SendPaymentDirectionEmailParams = {
  claimId: string;
  checkId: string;
  token: string;
};

async function sendPaymentDirectionEmail({
  claimId,
  checkId,
  token,
}: SendPaymentDirectionEmailParams) {
  const appUrl = import.meta.env.VITE_APP_URL || window.location.origin;
  const requestUrl = `${appUrl}/payment-direction/${token}`;

  const { error } = await supabase.functions.invoke("send-payment-direction-request", {
    body: {
      claimId,
      checkId,
      requestUrl,
      subject: "Payment direction needed for your insurance check",
      message: `We have received the required endorsement for your insurance check.\n\nPlease tell us how you want funds handled so we can move your claim forward.\n\nDo you authorize us to pay your contractor directly for work to commence?\n\nRespond here:\n${requestUrl}`,
    },
  });

  if (error) throw error;
}
