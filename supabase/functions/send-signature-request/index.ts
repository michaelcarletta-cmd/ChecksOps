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
  const { data: current } = await sb
    .from("signature_requests")
    .select("status")
    .eq("id", id)
    .single();

  const terminalStatuses = ["failed", "completed", "cancelled", "expired"];
  const alreadyTerminal = current && terminalStatuses.includes(current.status);

  await sb
    .from("signature_requests")
    .update({
      ...(alreadyTerminal ? {} : { status: "failed" }),
      last_error: error,
      last_attempted_at: new Date().toISOString(),
    })
    .eq("id", id);
}

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Resend email delivery
// ---------------------------------------------------------------------------

async function sendResend(to: string, subject: string, html: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");

  const fromEmail = Deno.env.get("FROM_EMAIL") || "claims@freedomclaims.work";
  const body = {
    from: `Freedom Claims <${fromEmail}>`,
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
// Email HTML builder
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
          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:30px 40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;">&#128221; Signature Required</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 40px;">
              <p style="font-size:16px;color:#333333;margin:0 0 16px;">Hello <strong>${signer.signer_name}</strong>,</p>
              <p style="font-size:16px;color:#333333;margin:0 0 24px;">
                You have been requested to electronically sign a document. This will only take a moment.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f8f9fa;border-left:4px solid #667eea;border-radius:6px;margin:0 0 28px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <p style="margin:6px 0;color:#555555;font-size:14px;"><strong style="color:#333333;">&#128203; Claim:</strong> ${request.claims?.claim_number || "N/A"}</p>
                    <p style="margin:6px 0;color:#555555;font-size:14px;"><strong style="color:#333333;">&#128196; Document:</strong> ${request.document_name}</p>
                    <p style="margin:6px 0;color:#555555;font-size:14px;"><strong style="color:#333333;">&#128100; Policyholder:</strong> ${request.claims?.policyholder_name || "N/A"}</p>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:8px 0 28px;">
                    <a href="${signUrl}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:50px;font-size:18px;font-weight:bold;box-shadow:0 4px 15px rgba(102,126,234,0.4);">&#9997;&#65039; Click Here to Sign</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#e9ecef;border-radius:6px;">
                <tr>
                  <td style="padding:14px 18px;">
                    <p style="margin:0 0 8px;font-size:13px;color:#666666;"><strong>Can&#39;t click the button?</strong> Copy and paste this link:</p>
                    <p style="margin:0;"><a href="${signUrl}" style="color:#667eea;word-break:break-all;font-size:12px;">${signUrl}</a></p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
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

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: null,
      stage: "function_start", status: "ok",
      message: skipEmail ? "Manual bypass mode" : "Function invoked",
      payload: { requestId, skipEmail },
    });

    // Load request + signers + claim
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
    const signersArr: any[] = request.signature_signers || [];

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "request_loaded", status: "ok",
      message: `${request.document_name} — ${signersArr.length} signers`,
      payload: { document_name: request.document_name },
    });

    // Generate tokens for each signer, store hash, keep raw for link
    const TOKEN_EXPIRY_HOURS = 72;
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    const appUrl = "https://freedomclaims.lovable.app";

    const signerLinks: { signer_id: string; signer_name: string; signer_email: string; sign_url: string }[] = [];

    for (const signer of signersArr) {
      const rawToken = generateRawToken();
      const tokenHash = await hashToken(rawToken);

      await sb.from("signature_signers").update({
        access_token: rawToken, // kept temporarily for backwards compat, will be cleared after send
        token_hash: tokenHash,
        expires_at: expiresAt,
      }).eq("id", signer.id);

      signer._rawToken = rawToken;
      signer._signUrl = `${appUrl}/sign?token=${rawToken}`;

      signerLinks.push({
        signer_id: signer.id,
        signer_name: signer.signer_name,
        signer_email: signer.signer_email,
        sign_url: signer._signUrl,
      });
    }

    // Also normalize field_data into signature_fields table if present
    const fieldData: any[] = request.field_data || [];
    if (fieldData.length > 0) {
      // Check if fields already exist for this request
      const { data: existingFields } = await sb
        .from("signature_fields")
        .select("id")
        .eq("signature_request_id", requestId)
        .limit(1);

      if (!existingFields || existingFields.length === 0) {
        const fieldRows = fieldData.map((f: any) => ({
          id: f.id, // preserve the frontend-generated UUID
          signature_request_id: requestId,
          signer_index: f.signerIndex ?? 0,
          field_type: f.type,
          label: f.label || null,
          page: f.page ?? 1,
          x: f.x ?? 0,
          y: f.y ?? 0,
          width: f.width ?? 200,
          height: f.height ?? 50,
          required: f.required !== false,
          placeholder: f.placeholder || null,
          checkbox_label: f.checkboxLabel || null,
        }));
        await sb.from("signature_fields").insert(fieldRows);
      }
    }

    // Manual bypass mode
    if (skipEmail) {
      // Clear raw tokens from DB after capturing links
      for (const signer of signersArr) {
        await sb.from("signature_signers").update({ access_token: null }).eq("id", signer.id);
      }

      await sb.from("signature_requests").update({
        status: "pending",
        delivery_mode: "manual_bypass",
        provider_status: "manual_bypass",
        last_attempted_at: new Date().toISOString(),
        last_error: null,
      }).eq("id", requestId);

      if (claimId) {
        await sb.from("claims").update({
          latest_signature_request_id: requestId,
          updated_at: new Date().toISOString(),
        }).eq("id", claimId);
      }

      await log(sb, {
        request_id: requestId, signer_id: null, claim_id: claimId,
        stage: "manual_bypass_complete", status: "ok",
        message: "Sign links generated, email skipped",
        payload: { signerLinks },
      });

      return respond({ ok: true, mode: "manual_bypass", signerLinks });
    }

    // Resend email delivery
    const results: { signer_id: string; success: boolean; error?: string }[] = [];

    for (const signer of signersArr) {
      const signUrl = signer._signUrl;

      await log(sb, {
        request_id: requestId, signer_id: signer.id, claim_id: claimId,
        stage: "email_sending", status: "in_progress",
        message: `Sending to ${signer.signer_email}`,
        payload: null,
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
          access_token: null, // clear raw token after email sent
          delivery_status: "sent",
          email_sent_at: new Date().toISOString(),
          email_provider_message_id: resendId,
        }).eq("id", signer.id);

        await log(sb, {
          request_id: requestId, signer_id: signer.id, claim_id: claimId,
          stage: "email_sent", status: "ok",
          message: `Resend success — id ${resendId}`,
          payload: { resendId },
        });

        results.push({ signer_id: signer.id, success: true });
      } catch (emailErr: any) {
        const errMsg = emailErr.message || "Unknown email error";
        await sb.from("signature_signers").update({
          access_token: null,
          delivery_status: "failed",
          delivery_error: errMsg,
        }).eq("id", signer.id);

        await log(sb, {
          request_id: requestId, signer_id: signer.id, claim_id: claimId,
          stage: "email_failed", status: "error",
          message: errMsg,
          payload: { error: errMsg },
        });

        results.push({ signer_id: signer.id, success: false, error: errMsg });
      }
    }

    const allFailed = results.every((r) => !r.success);
    const someFailed = results.some((r) => !r.success);
    const allSucceeded = results.every((r) => r.success);

    const providerStatus = allSucceeded ? "emails_sent" : allFailed ? "emails_failed" : "emails_partially_failed";

    await sb.from("signature_requests").update({
      status: allFailed ? "failed" : "pending",
      delivery_mode: "resend_direct",
      sent_at: allFailed ? null : new Date().toISOString(),
      last_error: allFailed ? "All emails failed" : someFailed ? "Some emails failed" : null,
      last_attempted_at: new Date().toISOString(),
      provider_status: providerStatus,
    }).eq("id", requestId);

    if (claimId) {
      await sb.from("claims").update({
        latest_signature_request_id: requestId,
        updated_at: new Date().toISOString(),
      }).eq("id", claimId);
    }

    if (claimId && !allFailed) {
      const signerNames = signersArr.map((s: any) => s.signer_name).join(", ");
      await sb.from("claim_updates").insert({
        claim_id: claimId,
        content: `📝 Signature request sent for "${request.document_name}" to ${signerNames}`,
        update_type: "esign",
      });
    }

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "function_complete", status: allFailed ? "error" : "ok",
      message: `${results.filter((r) => r.success).length}/${results.length} emails sent — ${providerStatus}`,
      payload: { results },
    });

    return respond({
      ok: !allFailed,
      mode: "resend_direct",
      results,
      sent: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      total: results.length,
    });
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

    return respond({ ok: false, stage: "function_error", error: msg }, 500);
  }
});
