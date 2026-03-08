import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface LogEntry {
  request_id: string | null;
  signer_id: string | null;
  claim_id: string | null;
  stage: string;
  status: string;
  message: string | null;
  payload: Record<string, unknown> | null;
}

async function writeLog(supabase: any, entry: LogEntry) {
  try {
    await supabase.from("esign_event_logs").insert(entry);
  } catch (e) {
    console.error("Failed to write esign log:", e);
  }
}

async function updateRequestError(supabase: any, requestId: string, error: string) {
  await supabase.from("signature_requests").update({
    status: "failed",
    last_error: error,
  }).eq("id", requestId);
}

async function sendMailjetEmail(to: string, subject: string, htmlContent: string, traceId: string) {
  const apiKey = Deno.env.get("MAILJET_API_KEY");
  const secretKey = Deno.env.get("MAILJET_SECRET_KEY");

  const payload = {
    Messages: [
      {
        From: { Email: "claims@freedomclaims.work", Name: "Freedom Claims" },
        To: [{ Email: to }],
        Subject: subject,
        HTMLPart: htmlContent,
        CustomID: traceId,
      },
    ],
  };

  const response = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}`,
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!response.ok) {
    throw Object.assign(new Error(`Mailjet error: ${JSON.stringify(result)}`), {
      response: result,
      statusCode: response.status,
    });
  }

  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  let requestId: string | null = null;
  let claimId: string | null = null;
  let skipEmail = false;

  try {
    const body = await req.json();
    requestId = body.requestId;
    skipEmail = body.skipEmail === true; // manual bypass mode

    if (!requestId) throw new Error("requestId is required");

    // -- Stage: function_start --
    await writeLog(supabaseClient, {
      request_id: requestId,
      signer_id: null,
      claim_id: null,
      stage: "function_start",
      status: "ok",
      message: skipEmail ? "Manual bypass mode — skip email" : "Function invoked",
      payload: { requestId, skipEmail },
    });

    // -- Stage: fetch_request --
    const { data: request, error: requestError } = await supabaseClient
      .from("signature_requests")
      .select(`*, signature_signers(*), claims(claim_number, policyholder_name)`)
      .eq("id", requestId)
      .single();

    if (requestError || !request) {
      const msg = requestError?.message || "Request not found";
      await writeLog(supabaseClient, {
        request_id: requestId, signer_id: null, claim_id: null,
        stage: "fetch_request", status: "error", message: msg, payload: null,
      });
      throw new Error(msg);
    }

    claimId = request.claim_id;

    await writeLog(supabaseClient, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "request_loaded", status: "ok",
      message: `Request loaded: ${request.document_name}, ${request.signature_signers?.length || 0} signers`,
      payload: { document_name: request.document_name, signer_count: request.signature_signers?.length },
    });

    if (skipEmail) {
      // Manual bypass: just mark as pending (link-only mode)
      const signerLinks = (request.signature_signers || []).map((s: any) => ({
        signer_id: s.id,
        signer_name: s.signer_name,
        signer_email: s.signer_email,
        sign_url: `https://freedomclaims.lovable.app/sign?token=${s.access_token}`,
      }));

      await supabaseClient.from("signature_requests").update({
        status: "pending",
        provider_status: "manual_bypass",
      }).eq("id", requestId);

      await writeLog(supabaseClient, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "manual_bypass_complete", status: "ok",
        message: "Sign links generated without sending email",
        payload: { signerLinks },
      });

      return new Response(
        JSON.stringify({ success: true, mode: "manual_bypass", signerLinks }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // -- Stage: send emails --
    const appUrl = "https://freedomclaims.lovable.app";
    const results: { signer_id: string; success: boolean; error?: string }[] = [];

    for (const signer of request.signature_signers || []) {
      const signUrl = `${appUrl}/sign?token=${signer.access_token}`;
      const traceId = `esign-${requestId}-${signer.id}`;

      await writeLog(supabaseClient, {
        request_id: requestId, signer_id: signer.id, claim_id: claimId,
        stage: "email_sending", status: "in_progress",
        message: `Sending to ${signer.signer_email}`,
        payload: { signUrl, traceId },
      });

      try {
        const htmlContent = buildEmailHtml(signer, request, signUrl);

        const emailResponse = await sendMailjetEmail(
          signer.signer_email,
          `🔔 Action Required: Sign ${request.document_name}`,
          htmlContent,
          traceId
        );

        // Extract Mailjet message ID
        const mjMessage = emailResponse?.Messages?.[0];
        const mjMessageId = mjMessage?.To?.[0]?.MessageID?.toString() || null;
        const mjStatus = mjMessage?.Status || "unknown";

        // Update signer with delivery info
        await supabaseClient.from("signature_signers").update({
          delivery_status: mjStatus === "success" ? "sent" : mjStatus,
          email_sent_at: new Date().toISOString(),
          email_provider_message_id: mjMessageId,
        }).eq("id", signer.id);

        await writeLog(supabaseClient, {
          request_id: requestId, signer_id: signer.id, claim_id: claimId,
          stage: "email_sent", status: "ok",
          message: `Email sent to ${signer.signer_email} — Mailjet status: ${mjStatus}`,
          payload: { emailResponse, mjMessageId, mjStatus },
        });

        results.push({ signer_id: signer.id, success: true });
      } catch (emailErr: any) {
        const errMsg = emailErr.message || "Unknown email error";
        const errResponse = emailErr.response || null;

        await supabaseClient.from("signature_signers").update({
          delivery_status: "failed",
          delivery_error: errMsg,
        }).eq("id", signer.id);

        await writeLog(supabaseClient, {
          request_id: requestId, signer_id: signer.id, claim_id: claimId,
          stage: "email_failed", status: "error",
          message: errMsg,
          payload: { error: errMsg, response: errResponse, statusCode: emailErr.statusCode },
        });

        results.push({ signer_id: signer.id, success: false, error: errMsg });
      }
    }

    // Update request status
    const allFailed = results.every((r) => !r.success);
    const someFailed = results.some((r) => !r.success);

    if (allFailed) {
      await supabaseClient.from("signature_requests").update({
        status: "failed",
        last_error: "All emails failed to send",
        sent_at: new Date().toISOString(),
      }).eq("id", requestId);
    } else {
      await supabaseClient.from("signature_requests").update({
        status: "pending",
        sent_at: new Date().toISOString(),
        last_error: someFailed ? "Some emails failed" : null,
        provider_status: "emails_sent",
      }).eq("id", requestId);
    }

    await writeLog(supabaseClient, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "function_complete", status: allFailed ? "error" : "ok",
      message: `${results.filter((r) => r.success).length}/${results.length} emails sent`,
      payload: { results },
    });

    return new Response(
      JSON.stringify({ success: !allFailed, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("send-signature-request error:", errorMessage);

    if (requestId) {
      await updateRequestError(supabaseClient, requestId, errorMessage);
      await writeLog(supabaseClient, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "function_error", status: "error",
        message: errorMessage, payload: null,
      });
    }

    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function buildEmailHtml(signer: any, request: any, signUrl: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">📝 Signature Required</h1>
      </div>
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <p style="font-size: 16px; color: #333; margin-bottom: 20px;">Hello <strong>${signer.signer_name}</strong>,</p>
        <p style="font-size: 16px; color: #333; margin-bottom: 25px;">
          You have been requested to electronically sign a document. This will only take a moment.
        </p>
        <div style="background: white; border-left: 4px solid #667eea; padding: 20px; margin: 25px 0; border-radius: 5px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <p style="margin: 8px 0; color: #555;"><strong style="color: #333;">📋 Claim Number:</strong> ${request.claims?.claim_number || "N/A"}</p>
          <p style="margin: 8px 0; color: #555;"><strong style="color: #333;">📄 Document:</strong> ${request.document_name}</p>
          <p style="margin: 8px 0; color: #555;"><strong style="color: #333;">👤 Policyholder:</strong> ${request.claims?.policyholder_name || "N/A"}</p>
        </div>
        <div style="text-align: center; margin: 35px 0;">
          <a href="${signUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 50px; display: inline-block; font-size: 18px; font-weight: bold; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">
            ✍️ Click Here to Sign Document
          </a>
        </div>
        <div style="background: #e9ecef; padding: 15px; border-radius: 5px; margin: 25px 0;">
          <p style="margin: 0; font-size: 13px; color: #666;"><strong>Can't click the button?</strong> Copy and paste this link into your browser:</p>
          <p style="margin: 10px 0 0 0;"><a href="${signUrl}" style="color: #667eea; word-break: break-all; font-size: 12px;">${signUrl}</a></p>
        </div>
        <div style="border-top: 2px solid #dee2e6; margin-top: 30px; padding-top: 20px;">
          <p style="color: #6c757d; font-size: 13px; margin: 5px 0;">📧 Questions? Contact Freedom Claims support</p>
          <p style="color: #adb5bd; font-size: 11px; margin: 15px 0 0 0;">This is an automated message from Freedom Claims. Please do not reply to this email.</p>
        </div>
      </div>
    </div>
  `;
}
