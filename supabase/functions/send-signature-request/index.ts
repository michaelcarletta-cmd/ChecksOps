import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  request_id: string | null;
  signer_id: string | null;
  claim_id: string | null;
  stage: string;
  status: string;
  message: string | null;
  payload: Record<string, unknown> | null;
}

async function log(sb: any, e: LogEntry) {
  try {
    await sb.from("esign_event_logs").insert(e);
  } catch (err) {
    console.error("esign log write failed:", err);
  }
}

async function failRequest(sb: any, id: string, error: string) {
  // Only set status=failed if not already in a deliberate terminal/error state
  const { data: current } = await sb
    .from("signature_requests")
    .select("status, provider_status")
    .eq("id", id)
    .single();

  const terminalStatuses = ["failed", "completed", "cancelled", "expired"];
  const alreadyTerminal = current && terminalStatuses.includes(current.status);

  await sb
    .from("signature_requests")
    .update({
      ...(alreadyTerminal ? {} : { status: "failed" }),
      last_error: error,
    })
    .eq("id", id);
}

// ---------------------------------------------------------------------------
// Resend direct send
// ---------------------------------------------------------------------------

async function sendResend(
  to: string,
  subject: string,
  html: string,
) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");

  const body = {
    from: "Freedom Claims <claims@freedomclaims.work>",
    to: [to],
    subject,
    html,
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const result = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(`Resend ${res.status}: ${JSON.stringify(result)}`), {
      response: result,
      statusCode: res.status,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Make / SignNow send (server-side)
// ---------------------------------------------------------------------------

async function sendMake(
  webhookUrl: string,
  request: any,
  claim: any,
  documentSignedUrl: string,
  callbackUrl: string,
  traceId: string,
) {
  const payload = {
    request_id: request.id,
    trace_id: traceId,
    claim_id: request.claim_id,
    claim_number: claim.claim_number,
    policy_number: claim.policy_number,
    policyholder_name: claim.policyholder_name,
    policyholder_email: claim.policyholder_email,
    document_name: request.document_name,
    document_url: documentSignedUrl,
    field_data: request.field_data,
    signers: (request.signature_signers || []).map((s: any) => ({
      name: s.signer_name,
      email: s.signer_email,
      type: s.signer_type,
      order: s.signing_order,
    })),
    callback_url: callbackUrl,
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // response may not be JSON
  }

  return { ok: res.ok, status: res.status, body: json ?? text };
}

/** Extract a provider-side ID from Make/SignNow response */
function extractProviderId(body: any): string | null {
  if (!body || typeof body !== "object") return null;
  // Common SignNow / Make response fields
  const candidates = [
    body.envelope_id,
    body.envelopeId,
    body.document_id,
    body.documentId,
    body.request_id,
    body.requestId,
    body.workflow_id,
    body.workflowId,
    body.id,
  ];
  for (const v of candidates) {
    if (v && typeof v === "string") return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Email HTML builder — full valid HTML with CTA button
// ---------------------------------------------------------------------------

function emailHtml(signer: any, request: any, signUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signature Required</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f5f7;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:30px 40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;">&#128221; Signature Required</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:30px 40px;">
              <p style="font-size:16px;color:#333333;margin:0 0 16px;">Hello <strong>${signer.signer_name}</strong>,</p>
              <p style="font-size:16px;color:#333333;margin:0 0 24px;">
                You have been requested to electronically sign a document. This will only take a moment.
              </p>
              <!-- Document info card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f8f9fa;border-left:4px solid #667eea;border-radius:6px;margin:0 0 28px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <p style="margin:6px 0;color:#555555;font-size:14px;"><strong style="color:#333333;">&#128203; Claim:</strong> ${request.claims?.claim_number || "N/A"}</p>
                    <p style="margin:6px 0;color:#555555;font-size:14px;"><strong style="color:#333333;">&#128196; Document:</strong> ${request.document_name}</p>
                    <p style="margin:6px 0;color:#555555;font-size:14px;"><strong style="color:#333333;">&#128100; Policyholder:</strong> ${request.claims?.policyholder_name || "N/A"}</p>
                  </td>
                </tr>
              </table>
              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:8px 0 28px;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${signUrl}" style="height:52px;v-text-anchor:middle;width:280px;" arcsize="50%" fillcolor="#667eea">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:18px;font-weight:bold;">✍️ Click Here to Sign</center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-->
                    <a href="${signUrl}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:50px;font-size:18px;font-weight:bold;box-shadow:0 4px 15px rgba(102,126,234,0.4);">&#9997;&#65039; Click Here to Sign</a>
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>
              <!-- Fallback link -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#e9ecef;border-radius:6px;">
                <tr>
                  <td style="padding:14px 18px;">
                    <p style="margin:0 0 8px;font-size:13px;color:#666666;"><strong>Can&#39;t click the button?</strong> Copy and paste this link into your browser:</p>
                    <p style="margin:0;"><a href="${signUrl}" style="color:#667eea;word-break:break-all;font-size:12px;">${signUrl}</a></p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #dee2e6;">
              <p style="color:#6c757d;font-size:13px;margin:0 0 6px;">&#128231; Questions? Contact Freedom Claims support</p>
              <p style="color:#adb5bd;font-size:11px;margin:0;">Automated message — do not reply directly to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let requestId: string | null = null;
  let claimId: string | null = null;

  try {
    const body = await req.json();
    requestId = body.requestId;
    const skipEmail: boolean = body.skipEmail === true;

    if (!requestId) throw new Error("requestId is required");

    // ── log: start ──
    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: null,
      stage: "function_start", status: "ok",
      message: skipEmail ? "Manual bypass mode" : "Function invoked",
      payload: { requestId, skipEmail },
    });

    // ── load request + signers + claim ──
    const { data: request, error: reqErr } = await sb
      .from("signature_requests")
      .select("*, signature_signers(*), claims(id, claim_number, policyholder_name, policyholder_email, policy_number)")
      .eq("id", requestId)
      .single();

    if (reqErr || !request) {
      const msg = reqErr?.message || "Request not found";
      await log(sb, { request_id: requestId, signer_id: null, claim_id: null, stage: "fetch_request", status: "error", message: msg, payload: null });
      throw new Error(msg);
    }

    claimId = request.claim_id;
    const claim = request.claims;
    const signersArr: any[] = request.signature_signers || [];

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "request_loaded", status: "ok",
      message: `${request.document_name} — ${signersArr.length} signers`,
      payload: { document_name: request.document_name },
    });

    // ── load company branding ONCE ──
    const { data: branding } = await sb
      .from("company_branding")
      .select("signnow_make_webhook_url")
      .limit(1)
      .maybeSingle();

    // ── determine delivery mode ──
    let deliveryMode: "manual_bypass" | "make_signnow" | "resend_direct";

    if (skipEmail) {
      deliveryMode = "manual_bypass";
    } else {
      deliveryMode = branding?.signnow_make_webhook_url
        ? "make_signnow"
        : "resend_direct";
    }

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "delivery_mode_resolved", status: "ok",
      message: `Delivery mode: ${deliveryMode}`,
      payload: { deliveryMode },
    });

    // ── manual bypass ──
    if (deliveryMode === "manual_bypass") {
      // Validate every signer has an access_token
      const missingTokenSigners = signersArr.filter((s: any) => !s.access_token);
      if (missingTokenSigners.length > 0) {
        const msg = `${missingTokenSigners.length} signer(s) missing access_token`;
        await log(sb, {
          request_id: requestId, signer_id: null, claim_id: claimId,
          stage: "manual_bypass_validation", status: "error",
          message: msg,
          payload: { missing_signer_ids: missingTokenSigners.map((s: any) => s.id) },
        });
        await failRequest(sb, requestId, msg);
        throw new Error(msg);
      }

      const signerLinks = signersArr.map((s: any) => ({
        signer_id: s.id,
        signer_name: s.signer_name,
        signer_email: s.signer_email,
        sign_url: `https://freedomclaims.lovable.app/sign?token=${s.access_token}`,
      }));

      await sb.from("signature_requests").update({
        status: "pending",
        delivery_mode: "manual_bypass",
        provider_status: "manual_bypass",
      }).eq("id", requestId);

      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "manual_bypass_complete", status: "ok",
        message: "Sign links generated, email skipped",
        payload: { signerLinks },
      });

      return respond({ success: true, mode: "manual_bypass", signerLinks });
    }

    // ── make_signnow ──
    if (deliveryMode === "make_signnow") {
      const webhookUrl = branding!.signnow_make_webhook_url!;

      // Generate a signed URL for the document — 72h for Make ingestion + retries
      const { data: urlData } = await sb.storage
        .from("claim-files")
        .createSignedUrl(request.document_path, 259200); // 72 hours

      if (!urlData?.signedUrl) {
        const msg = "Could not generate signed URL for document";
        await log(sb, { request_id: requestId, signer_id: null, claim_id: claimId, stage: "document_url", status: "error", message: msg, payload: null });
        throw new Error(msg);
      }

      const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/signature-webhook`;
      const traceId = `esign-${requestId}`;

      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "make_webhook_sending", status: "in_progress",
        message: `POSTing to Make webhook`,
        payload: { webhookUrl: webhookUrl.substring(0, 60) + "...", traceId },
      });

      const makeResult = await sendMake(webhookUrl, request, claim, urlData.signedUrl, callbackUrl, traceId);

      const providerId = extractProviderId(makeResult.body);

      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "make_webhook_response", status: makeResult.ok ? "ok" : "error",
        message: `Make responded ${makeResult.status}`,
        payload: { status: makeResult.status, body: makeResult.body, provider_id: providerId },
      });

      if (!makeResult.ok) {
        await sb.from("signature_requests").update({
          status: "failed",
          delivery_mode: "make_signnow",
          last_error: `Make webhook returned ${makeResult.status}`,
          last_provider_response: typeof makeResult.body === "string" ? makeResult.body : JSON.stringify(makeResult.body),
        }).eq("id", requestId);

        throw new Error(`Make webhook failed with status ${makeResult.status}`);
      }

      await sb.from("signature_requests").update({
        status: "pending",
        delivery_mode: "make_signnow",
        sent_at: new Date().toISOString(),
        provider_status: "submitted_to_provider",
        provider_message_id: providerId,
        last_provider_response: typeof makeResult.body === "string" ? makeResult.body : JSON.stringify(makeResult.body),
      }).eq("id", requestId);

      // Mark signers as queued — not yet delivered
      for (const signer of signersArr) {
        await sb.from("signature_signers").update({
          delivery_status: "submitted_to_provider",
        }).eq("id", signer.id);
      }

      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "function_complete", status: "ok",
        message: "Submitted to Make/SignNow",
        payload: { provider_id: providerId },
      });

      return respond({ success: true, mode: "make_signnow", provider_id: providerId });
    }

    // ── resend_direct ──
    const appUrl = "https://freedomclaims.lovable.app";
    const results: { signer_id: string; success: boolean; error?: string }[] = [];

    for (const signer of signersArr) {
      const signUrl = `${appUrl}/sign?token=${signer.access_token}`;

      await log(sb, {
        request_id: requestId, signer_id: signer.id, claim_id: claimId,
        stage: "email_sending", status: "in_progress",
        message: `Sending to ${signer.signer_email}`,
        payload: { signUrl },
      });

      try {
        const html = emailHtml(signer, request, signUrl);
        const emailRes = await sendResend(
          signer.signer_email,
          `🔔 Action Required: Sign ${request.document_name}`,
          html,
        );

        const resendId = emailRes?.id || null;

        await sb.from("signature_signers").update({
          delivery_status: "sent",
          email_sent_at: new Date().toISOString(),
          email_provider_message_id: resendId,
        }).eq("id", signer.id);

        await log(sb, {
          request_id: requestId, signer_id: signer.id, claim_id: claimId,
          stage: "email_sent", status: "ok",
          message: `Resend success — id ${resendId}`,
          payload: { emailRes, resendId },
        });

        results.push({ signer_id: signer.id, success: true });
      } catch (emailErr: any) {
        const errMsg = emailErr.message || "Unknown email error";
        await sb.from("signature_signers").update({
          delivery_status: "failed",
          delivery_error: errMsg,
        }).eq("id", signer.id);

        await log(sb, {
          request_id: requestId, signer_id: signer.id, claim_id: claimId,
          stage: "email_failed", status: "error",
          message: errMsg,
          payload: { error: errMsg, response: emailErr.response, statusCode: emailErr.statusCode },
        });

        results.push({ signer_id: signer.id, success: false, error: errMsg });
      }
    }

    const allFailed = results.every((r) => !r.success);
    const someFailed = results.some((r) => !r.success);
    const allSucceeded = results.every((r) => r.success);

    let providerStatus: string;
    if (allSucceeded) {
      providerStatus = "emails_sent";
    } else if (allFailed) {
      providerStatus = "emails_failed";
    } else {
      providerStatus = "emails_partially_failed";
    }

    await sb.from("signature_requests").update({
      status: allFailed ? "failed" : "pending",
      delivery_mode: "resend_direct",
      sent_at: allFailed ? null : new Date().toISOString(),
      last_error: allFailed ? "All emails failed" : someFailed ? "Some emails failed" : null,
      provider_status: providerStatus,
    }).eq("id", requestId);

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "function_complete", status: allFailed ? "error" : "ok",
      message: `${results.filter((r) => r.success).length}/${results.length} emails sent — ${providerStatus}`,
      payload: { results },
    });

    return respond({ success: !allFailed, mode: "resend_direct", results });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("send-signature-request error:", msg);

    if (requestId) {
      await failRequest(sb, requestId, msg);
      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "function_error", status: "error",
        message: msg, payload: null,
      });
    }

    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function respond(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
