import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

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
  await sb
    .from("signature_requests")
    .update({ status: "failed", last_error: error })
    .eq("id", id);
}

// ---------------------------------------------------------------------------
// Mailjet direct send
// ---------------------------------------------------------------------------

async function sendMailjet(
  to: string,
  subject: string,
  html: string,
  traceId: string,
) {
  const apiKey = Deno.env.get("MAILJET_API_KEY");
  const secretKey = Deno.env.get("MAILJET_SECRET_KEY");

  const body = {
    Messages: [
      {
        From: { Email: "claims@freedomclaims.work", Name: "Freedom Claims" },
        To: [{ Email: to }],
        Subject: subject,
        HTMLPart: html,
        CustomID: traceId,
      },
    ],
  };

  const res = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}`,
    },
    body: JSON.stringify(body),
  });

  const result = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(`Mailjet ${res.status}: ${JSON.stringify(result)}`), {
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
) {
  const payload = {
    request_id: request.id,
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

// ---------------------------------------------------------------------------
// Email HTML builder
// ---------------------------------------------------------------------------

function emailHtml(signer: any, request: any, signUrl: string): string {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff">
      <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:30px;border-radius:10px 10px 0 0;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:28px">📝 Signature Required</h1>
      </div>
      <div style="background:#f8f9fa;padding:30px;border-radius:0 0 10px 10px">
        <p style="font-size:16px;color:#333;margin-bottom:20px">Hello <strong>${signer.signer_name}</strong>,</p>
        <p style="font-size:16px;color:#333;margin-bottom:25px">
          You have been requested to electronically sign a document. This will only take a moment.
        </p>
        <div style="background:#fff;border-left:4px solid #667eea;padding:20px;margin:25px 0;border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,.1)">
          <p style="margin:8px 0;color:#555"><strong style="color:#333">📋 Claim:</strong> ${request.claims?.claim_number || "N/A"}</p>
          <p style="margin:8px 0;color:#555"><strong style="color:#333">📄 Document:</strong> ${request.document_name}</p>
          <p style="margin:8px 0;color:#555"><strong style="color:#333">👤 Policyholder:</strong> ${request.claims?.policyholder_name || "N/A"}</p>
        </div>
        <div style="text-align:center;margin:35px 0">
          <a href="${signUrl}" style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:16px 40px;text-decoration:none;border-radius:50px;display:inline-block;font-size:18px;font-weight:bold;box-shadow:0 4px 15px rgba(102,126,234,.4)">✍️ Click Here to Sign</a>
        </div>
        <div style="background:#e9ecef;padding:15px;border-radius:5px;margin:25px 0">
          <p style="margin:0;font-size:13px;color:#666"><strong>Can't click?</strong> Copy this link:</p>
          <p style="margin:10px 0 0"><a href="${signUrl}" style="color:#667eea;word-break:break-all;font-size:12px">${signUrl}</a></p>
        </div>
        <div style="border-top:2px solid #dee2e6;margin-top:30px;padding-top:20px">
          <p style="color:#6c757d;font-size:13px;margin:5px 0">📧 Questions? Contact Freedom Claims support</p>
          <p style="color:#adb5bd;font-size:11px;margin:15px 0 0">Automated message — do not reply.</p>
        </div>
      </div>
    </div>`;
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

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "request_loaded", status: "ok",
      message: `${request.document_name} — ${request.signature_signers?.length ?? 0} signers`,
      payload: { document_name: request.document_name },
    });

    // ── determine delivery mode ──
    let deliveryMode: "manual_bypass" | "make_signnow" | "mailjet_direct";

    if (skipEmail) {
      deliveryMode = "manual_bypass";
    } else {
      // Check company branding for Make webhook
      const { data: branding } = await sb
        .from("company_branding")
        .select("signnow_make_webhook_url")
        .limit(1)
        .maybeSingle();

      deliveryMode = branding?.signnow_make_webhook_url
        ? "make_signnow"
        : "mailjet_direct";
    }

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "delivery_mode_resolved", status: "ok",
      message: `Delivery mode: ${deliveryMode}`,
      payload: { deliveryMode },
    });

    // ── manual bypass ──
    if (deliveryMode === "manual_bypass") {
      const signerLinks = (request.signature_signers || []).map((s: any) => ({
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
      const { data: branding } = await sb
        .from("company_branding")
        .select("signnow_make_webhook_url")
        .limit(1)
        .maybeSingle();

      const webhookUrl = branding!.signnow_make_webhook_url!;

      // Generate a signed URL for the document
      const { data: urlData } = await sb.storage
        .from("claim-files")
        .createSignedUrl(request.document_path, 86400);

      if (!urlData?.signedUrl) {
        const msg = "Could not generate signed URL for document";
        await log(sb, { request_id: requestId, signer_id: null, claim_id: claimId, stage: "document_url", status: "error", message: msg, payload: null });
        throw new Error(msg);
      }

      const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/signature-webhook`;

      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "make_webhook_sending", status: "in_progress",
        message: `POSTing to Make webhook`,
        payload: { webhookUrl: webhookUrl.substring(0, 60) + "..." },
      });

      const makeResult = await sendMake(webhookUrl, request, claim, urlData.signedUrl, callbackUrl);

      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "make_webhook_response", status: makeResult.ok ? "ok" : "error",
        message: `Make responded ${makeResult.status}`,
        payload: { status: makeResult.status, body: makeResult.body },
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
        provider_status: "sent_to_make",
        last_provider_response: typeof makeResult.body === "string" ? makeResult.body : JSON.stringify(makeResult.body),
      }).eq("id", requestId);

      // Mark signers
      for (const signer of request.signature_signers || []) {
        await sb.from("signature_signers").update({
          delivery_status: "sent_via_make",
        }).eq("id", signer.id);
      }

      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "function_complete", status: "ok",
        message: "Sent via Make/SignNow",
        payload: null,
      });

      return respond({ success: true, mode: "make_signnow" });
    }

    // ── mailjet_direct ──
    const appUrl = "https://freedomclaims.lovable.app";
    const results: { signer_id: string; success: boolean; error?: string }[] = [];

    for (const signer of request.signature_signers || []) {
      const signUrl = `${appUrl}/sign?token=${signer.access_token}`;
      const traceId = `esign-${requestId}-${signer.id}`;

      await log(sb, {
        request_id: requestId, signer_id: signer.id, claim_id: claimId,
        stage: "email_sending", status: "in_progress",
        message: `Sending to ${signer.signer_email}`,
        payload: { signUrl, traceId },
      });

      try {
        const html = emailHtml(signer, request, signUrl);
        const emailRes = await sendMailjet(
          signer.signer_email,
          `🔔 Action Required: Sign ${request.document_name}`,
          html,
          traceId,
        );

        const mjMsg = emailRes?.Messages?.[0];
        const mjMsgId = mjMsg?.To?.[0]?.MessageID?.toString() || null;
        const mjStatus = mjMsg?.Status || "unknown";

        await sb.from("signature_signers").update({
          delivery_status: mjStatus === "success" ? "sent" : mjStatus,
          email_sent_at: new Date().toISOString(),
          email_provider_message_id: mjMsgId,
        }).eq("id", signer.id);

        await log(sb, {
          request_id: requestId, signer_id: signer.id, claim_id: claimId,
          stage: "email_sent", status: "ok",
          message: `Mailjet ${mjStatus} — msgId ${mjMsgId}`,
          payload: { emailRes, mjMsgId, mjStatus },
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

    await sb.from("signature_requests").update({
      status: allFailed ? "failed" : "pending",
      delivery_mode: "mailjet_direct",
      sent_at: new Date().toISOString(),
      last_error: allFailed ? "All emails failed" : someFailed ? "Some emails failed" : null,
      provider_status: "emails_sent",
    }).eq("id", requestId);

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "function_complete", status: allFailed ? "error" : "ok",
      message: `${results.filter((r) => r.success).length}/${results.length} emails sent`,
      payload: { results },
    });

    return respond({ success: !allFailed, mode: "mailjet_direct", results });
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
