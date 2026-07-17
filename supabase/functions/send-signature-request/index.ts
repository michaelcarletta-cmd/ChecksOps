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

async function sendResend(
  to: string,
  subject: string,
  html: string,
  opts?: { fromOverride?: string | null; replyTo?: string | null },
) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");

  const fromEmail = Deno.env.get("FROM_EMAIL") || "claims@freedomclaims.work";
  const defaultFrom = `Freedom Claims <${fromEmail}>`;
  const body: Record<string, unknown> = {
    from: opts?.fromOverride || defaultFrom,
    to: [to],
    subject,
    html,
  };
  if (opts?.replyTo) body.reply_to = opts.replyTo;

  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) throw new Error("LOVABLE_API_KEY not configured");
  const res = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lovableApiKey}`,
      "X-Connection-Api-Key": apiKey,
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

interface BrandingConfig {
  company_name?: string;
  company_email?: string;
  company_phone?: string;
  esign_email_subject?: string;
  esign_email_body?: string;
  esign_email_header_color?: string;
  esign_email_button_color?: string;
  letterhead_url?: string;
}

function replaceMergeFields(text: string, signer: any, request: any, signUrl: string, branding: BrandingConfig): string {
  const claim = request.claims || {};
  return text
    .replace(/\{signer\.name\}/g, signer.signer_name || "")
    .replace(/\{signer\.email\}/g, signer.signer_email || "")
    .replace(/\{document\.name\}/g, request.document_name || "")
    .replace(/\{claim\.number\}/g, claim.claim_number || "N/A")
    .replace(/\{claim\.policyholder\}/g, claim.policyholder_name || "N/A")
    .replace(/\{claim\.policy_number\}/g, claim.policy_number || "N/A")
    .replace(/\{company\.name\}/g, branding.company_name || "Freedom Claims")
    .replace(/\{company\.email\}/g, branding.company_email || "")
    .replace(/\{company\.phone\}/g, branding.company_phone || "")
    .replace(/\{sign\.url\}/g, signUrl)
    .replace(/\{sign\.expiry_hours\}/g, "72");
}

function emailHtml(signer: any, request: any, signUrl: string, branding: BrandingConfig): string {
  const companyName = branding.company_name || "Freedom Claims";
  const headerColor = branding.esign_email_header_color || "#1a56db";
  const buttonColor = branding.esign_email_button_color || "#1a56db";
  const logoUrl = branding.letterhead_url || "";

  // Process custom body — replace merge fields and convert newlines to <br>
  const rawBody = branding.esign_email_body || "You have been requested to electronically sign a document. Please review the details below and click the button to proceed.";
  const processedBody = replaceMergeFields(rawBody, signer, request, signUrl, branding)
    .replace(/\n/g, "<br>");

  const claim = request.claims || {};

  const logoBlock = logoUrl
    ? `<img src="${logoUrl}" alt="${companyName}" style="max-height:48px;max-width:200px;object-fit:contain;" />`
    : `<span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${companyName}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signature Required</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f0f2f5;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:${headerColor};padding:24px 40px;text-align:center;">
              ${logoBlock}
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <p style="font-size:16px;color:#1a1a2e;margin:0 0 8px;font-weight:600;">Hello ${signer.signer_name},</p>
              <p style="font-size:15px;color:#4a4a68;margin:0 0 24px;line-height:1.6;">
                ${processedBody}
              </p>
              <!-- Document Details -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f8f9fb;border-radius:8px;margin:0 0 28px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding:4px 0;color:#6b7280;font-size:13px;width:120px;vertical-align:top;">Document</td>
                        <td style="padding:4px 0;color:#1a1a2e;font-size:13px;font-weight:600;">${request.document_name}</td>
                      </tr>
                      <tr>
                        <td style="padding:4px 0;color:#6b7280;font-size:13px;vertical-align:top;">Claim #</td>
                        <td style="padding:4px 0;color:#1a1a2e;font-size:13px;font-weight:600;">${claim.claim_number || "N/A"}</td>
                      </tr>
                      <tr>
                        <td style="padding:4px 0;color:#6b7280;font-size:13px;vertical-align:top;">Policyholder</td>
                        <td style="padding:4px 0;color:#1a1a2e;font-size:13px;font-weight:600;">${claim.policyholder_name || "N/A"}</td>
                      </tr>
                      ${claim.policy_number ? `<tr>
                        <td style="padding:4px 0;color:#6b7280;font-size:13px;vertical-align:top;">Policy #</td>
                        <td style="padding:4px 0;color:#1a1a2e;font-size:13px;font-weight:600;">${claim.policy_number}</td>
                      </tr>` : ""}
                    </table>
                  </td>
                </tr>
              </table>
              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:4px 0 28px;">
                    <a href="${signUrl}" target="_blank" style="display:inline-block;background-color:${buttonColor};color:#ffffff;padding:14px 48px;text-decoration:none;border-radius:6px;font-size:16px;font-weight:600;">Review &amp; Sign Document</a>
                  </td>
                </tr>
              </table>
              <!-- Fallback link -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f8f9fb;border-radius:6px;">
                <tr>
                  <td style="padding:14px 18px;">
                    <p style="margin:0 0 6px;font-size:12px;color:#6b7280;">Can't click the button? Copy and paste this link into your browser:</p>
                    <p style="margin:0;"><a href="${signUrl}" style="color:${buttonColor};word-break:break-all;font-size:11px;">${signUrl}</a></p>
                  </td>
                </tr>
              </table>
              <!-- Expiry notice -->
              <p style="font-size:12px;color:#9ca3af;margin:20px 0 0;text-align:center;">This link expires in 72 hours.</p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #e5e7eb;background-color:#f8f9fb;">
              <p style="color:#6b7280;font-size:12px;margin:0 0 4px;">${companyName}${branding.company_phone ? ` &bull; ${branding.company_phone}` : ""}${branding.company_email ? ` &bull; ${branding.company_email}` : ""}</p>
              <p style="color:#9ca3af;font-size:11px;margin:0;">This is an automated message. Please do not reply directly to this email.</p>
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
    const senderOverride: string | null = body.senderOverride || body.sender_override || null;

    if (!requestId) throw new Error("requestId is required");

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: null,
      stage: "function_start", status: "ok",
      message: skipEmail ? "Manual bypass mode" : "Function invoked",
      payload: { requestId, skipEmail },
    });

    // Load request + signers (claim joined separately so null claim_id works for shared intake checks)
    const { data: request, error: reqErr } = await sb
      .from("signature_requests")
      .select("*, signature_signers(*)")
      .eq("id", requestId)
      .single();

    if (reqErr || !request) {
      const msg = reqErr?.message || "Request not found";
      await log(sb, { request_id: requestId, signer_id: null, claim_id: null, stage: "fetch_request", status: "error", message: msg, payload: null });
      throw new Error(msg);
    }

    // Load claim OR check_intake_item context for email merge fields.
    // Shared checks ingested from Freedom CRM live in check_intake_items
    // and have no claim_id in this project — fall back to that row.
    if (request.claim_id) {
      const { data: claimRow } = await sb
        .from("claims")
        .select("id, claim_number, policyholder_name, policyholder_email, policy_number")
        .eq("id", request.claim_id)
        .maybeSingle();
      request.claims = claimRow || {};
    } else if (request.check_intake_item_id) {
      const { data: intakeRow } = await sb
        .from("check_intake_items")
        .select("id, check_number, detected_claim_number, payee_line, carrier_name")
        .eq("id", request.check_intake_item_id)
        .maybeSingle();
      request.claims = intakeRow
        ? {
            claim_number: intakeRow.detected_claim_number || `Check #${intakeRow.check_number || ""}`,
            policyholder_name: intakeRow.payee_line || "",
            policy_number: null,
            policyholder_email: null,
          }
        : {};
    } else {
      request.claims = {};
    }

    // Load system-default email copy/colors (subject/body strings live on company_branding).
    const { data: brandingRow } = await sb
      .from("company_branding")
      .select("company_name, company_email, company_phone, esign_email_subject, esign_email_body, esign_email_header_color, esign_email_button_color, letterhead_url")
      .limit(1)
      .maybeSingle();
    const branding: BrandingConfig = brandingRow || {};

    // Resolve tenant-specific From / Reply-To and visual branding (white-label override).
    // Tenant comes from claim or shared check_intake_item; falls back to Freedom default.
    let tenantFromOverride: string | null = null;
    let tenantReplyTo: string | null = null;
    try {
      let tenantId: string | null = null;
      if (request.claim_id) {
        const { data: cl } = await sb
          .from("claims").select("tenant_id").eq("id", request.claim_id).maybeSingle();
        tenantId = (cl as any)?.tenant_id ?? null;
      }
      if (!tenantId && request.check_intake_item_id) {
        const { data: ck } = await sb
          .from("check_intake_items").select("tenant_id").eq("id", request.check_intake_item_id).maybeSingle();
        tenantId = (ck as any)?.tenant_id ?? null;
      }
      if (tenantId) {
        const { data: t } = await sb
          .from("tenants")
          .select("name, logo_url, primary_color, is_system_tenant, email_from_name, email_from_address, email_reply_to")
          .eq("id", tenantId)
          .maybeSingle();
        const tenantRec = t as any;
        const addr = tenantRec?.email_from_address;
        if (addr) {
          const name = tenantRec?.email_from_name || tenantRec?.name || "Notifications";
          tenantFromOverride = `${name} <${addr}>`;
        }
        tenantReplyTo = tenantRec?.email_reply_to ?? null;

        // For non-system (white-label) tenants, override visual branding with tenant identity
        // so the email logo/colors/company name match the tenant — not Freedom Claims.
        if (tenantRec && tenantRec.is_system_tenant === false) {
          if (tenantRec.name) branding.company_name = tenantRec.name;
          if (tenantRec.logo_url) branding.letterhead_url = tenantRec.logo_url;
          if (tenantRec.primary_color) {
            branding.esign_email_header_color = tenantRec.primary_color;
            branding.esign_email_button_color = tenantRec.primary_color;
          }
          if (tenantRec.email_reply_to) branding.company_email = tenantRec.email_reply_to;
        }
      }
    } catch (_e) { /* fall back to default sender */ }

    // Mortgage Ops desk sends everything as ChecksOps regardless of tenant branding.
    if (senderOverride === "checksops") {
      tenantFromOverride = "ChecksOps <notify@checksops.com>";
      tenantReplyTo = "notify@checksops.com";
      branding.company_name = "ChecksOps";
      branding.company_email = "notify@checksops.com";
    }

    claimId = request.claim_id;
    const signersArr: any[] = request.signature_signers || [];

    await log(sb, {
      request_id: requestId, signer_id: null, claim_id: claimId,
      stage: "request_loaded", status: "ok",
      message: `${request.document_name} — ${signersArr.length} signers${request.check_intake_item_id ? " (shared check)" : ""}`,
      payload: { document_name: request.document_name, check_intake_item_id: request.check_intake_item_id || null },
    });

    // Generate tokens for each signer, store hash, keep raw for link
    const TOKEN_EXPIRY_HOURS = 72;
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    const appUrl = (Deno.env.get("SIGN_BASE_URL") || "https://checksops.com").replace(/\/$/, "");

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
          width: f.width ?? 33,
          height: f.height ?? 6,
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
        const html = emailHtml(signer, request, signUrl, branding);
        const rawSubject = branding.esign_email_subject || "Action Required: Sign {document.name}";
        const subject = replaceMergeFields(rawSubject, signer, request, signUrl, branding);
        const emailRes = await sendResend(
          signer.signer_email,
          subject,
          html,
          { fromOverride: tenantFromOverride, replyTo: tenantReplyTo },
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
