import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CheckPayee {
  id: string;
  check_id: string;
  payee_name: string;
  payee_type: string;
  endorsement_status: string;
  endorsement_token: string | null;
  endorsement_token_expires_at: string | null;
  endorsement_image_path: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notification_delivery_status: string | null;
  check_intake_items?: {
    carrier_name: string | null;
    check_number: string | null;
    amount: number | null;
    is_multi_payee: boolean;
    deposit_recommendation: string | null;
  } | null;
}

/** Recommendations that should NEVER be auto-promoted to ready_for_deposit */
const RESTRICTED_RECOMMENDATIONS = new Set([
  "manual_review_required",
  "branch_deposit_recommended",
]);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function htmlResp(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

function escHtml(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Build a forensic evidence object from the HTTP request */
function signerForensics(req: Request): Record<string, string | null> {
  return {
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? req.headers.get("cf-connecting-ip")
      ?? null,
    user_agent: req.headers.get("user-agent") ?? null,
    consent_text: "By clicking Endorse/Reject, the signer confirms their identity and acknowledges this check payment action.",
    signed_at_utc: new Date().toISOString(),
  };
}

async function reEvaluateAfterEndorsement(
  supabase: ReturnType<typeof createClient>,
  checkId: string,
) {
  const { data: allPayees } = await supabase
    .from("check_payees")
    .select("endorsement_status")
    .eq("check_id", checkId);

  if (!allPayees?.length) return { allSigned: false, newStatus: null };

  const allSigned = allPayees.every(
    (p: { endorsement_status: string }) => p.endorsement_status === "signed",
  );
  const anyRejected = allPayees.some(
    (p: { endorsement_status: string }) => p.endorsement_status === "rejected",
  );

  if (anyRejected) {
    await supabase.from("check_intake_items")
      .update({ status: "needs_review" })
      .eq("id", checkId);
    return { allSigned: false, newStatus: "needs_review" };
  }

  if (allSigned) {
    const { data: check } = await supabase
      .from("check_intake_items")
      .select("is_multi_payee, deposit_recommendation")
      .eq("id", checkId)
      .single();

    const originalRec = check?.deposit_recommendation ?? "";

    if (check?.is_multi_payee) {
      // Multi-payee: endorsements_complete is a STATUS — never touch deposit_recommendation
      await supabase.from("check_intake_items")
        .update({ status: "endorsements_complete" })
        .eq("id", checkId);

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "all_endorsements_complete",
        event_description: `All payees endorsed — deposit recommendation preserved: ${originalRec}`,
      });

      return { allSigned: true, newStatus: "endorsements_complete" };
    } else {
      // Single-payee: ONLY promote to ready_for_deposit if the original
      // recommendation is not a restricted/stricter one
      if (RESTRICTED_RECOMMENDATIONS.has(originalRec)) {
        await supabase.from("check_intake_items")
          .update({ status: "endorsements_complete" })
          .eq("id", checkId);

        await supabase.from("check_audit_log").insert({
          check_id: checkId,
          event_type: "all_endorsements_complete",
          event_description: `Single-payee endorsed but original recommendation "${originalRec}" preserved — manual review still required`,
        });

        return { allSigned: true, newStatus: "endorsements_complete" };
      }

      await supabase.from("check_intake_items")
        .update({
          status: "ready",
          deposit_recommendation: "ready_for_deposit",
        })
        .eq("id", checkId);

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "all_endorsements_complete",
        event_description: "Single-payee check — endorsement complete, ready for deposit",
      });

      return { allSigned: true, newStatus: "ready" };
    }
  }

  return { allSigned: false, newStatus: null };
}

function renderEndorsementPage(
  payee: CheckPayee,
  supabaseUrl: string,
): string {
  const carrier = payee.check_intake_items?.carrier_name ?? "Unknown Carrier";
  const checkNum = payee.check_intake_items?.check_number ?? "N/A";
  const amount = payee.check_intake_items?.amount;
  const amountStr = amount != null
    ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
    : "N/A";
  const token = payee.endorsement_token ?? "";
  const fnUrl = `${supabaseUrl}/functions/v1/check-endorsement`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Endorsement — Check #${escHtml(checkNum)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;max-width:480px;width:100%;padding:32px}
    h1{font-size:20px;margin-bottom:4px}
    .sub{color:#94a3b8;font-size:14px;margin-bottom:24px}
    .detail{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #334155;font-size:14px}
    .detail .label{color:#94a3b8}
    .detail .value{font-weight:600}
    .amount{font-size:28px;font-weight:700;text-align:center;padding:20px 0;color:#22c55e}
    .actions{display:flex;gap:12px;margin-top:24px}
    .btn{flex:1;padding:12px;border-radius:8px;border:none;font-size:14px;font-weight:600;cursor:pointer;transition:opacity 0.2s}
    .btn-approve{background:#22c55e;color:#0f172a}
    .btn-reject{background:#334155;color:#e2e8f0}
    .btn:hover{opacity:0.85}
    .btn:disabled{opacity:0.5;cursor:not-allowed}
    .status{text-align:center;padding:20px;font-size:16px;font-weight:600}
    .status.signed{color:#22c55e}
    .status.rejected{color:#ef4444}
    .status.expired{color:#94a3b8}
    #msg{text-align:center;margin-top:12px;font-size:13px;min-height:20px}
    .error{color:#ef4444}
    .success{color:#22c55e}
    .consent{font-size:11px;color:#64748b;margin-top:12px;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <h1>Insurance Check Endorsement</h1>
    <p class="sub">You have been identified as a payee on the following check.</p>
    <div class="detail"><span class="label">Carrier</span><span class="value">${escHtml(carrier)}</span></div>
    <div class="detail"><span class="label">Check #</span><span class="value">${escHtml(checkNum)}</span></div>
    <div class="detail"><span class="label">Your Name</span><span class="value">${escHtml(payee.payee_name)}</span></div>
    <div class="amount">${escHtml(amountStr)}</div>
    ${
    payee.endorsement_status === "signed"
      ? '<div class="status signed">&#x2713; You have already endorsed this check.</div>'
      : payee.endorsement_status === "rejected"
      ? '<div class="status rejected">&#x2717; You have rejected this endorsement.</div>'
      : payee.endorsement_status === "expired"
      ? '<div class="status expired">This endorsement link has expired.</div>'
      : `
    <p style="font-size:13px;color:#94a3b8;margin-bottom:8px;">By clicking &quot;Endorse&quot;, you confirm your identity and acknowledge this check payment.</p>
    <div class="actions">
      <button class="btn btn-approve" id="approveBtn" onclick="submitEndorsement('approve')">Endorse Check</button>
      <button class="btn btn-reject" id="rejectBtn" onclick="submitEndorsement('reject')">Reject</button>
    </div>
    <div id="msg"></div>
    <p class="consent">By taking action you agree: &quot;I confirm my identity as the named payee and acknowledge this endorsement action.&quot;</p>
    <script>
    async function submitEndorsement(type) {
      var msg = document.getElementById('msg');
      var approveBtn = document.getElementById('approveBtn');
      var rejectBtn = document.getElementById('rejectBtn');
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      msg.textContent = 'Processing...';
      msg.className = '';
      try {
        var action = type === 'approve' ? 'submit_endorsement' : 'reject_endorsement';
        var resp = await fetch('${escHtml(fnUrl)}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action, token: '${escHtml(token)}', reason: type === 'reject' ? 'Payee declined' : undefined })
        });
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Request failed');
        msg.className = type === 'approve' ? 'success' : 'error';
        msg.textContent = type === 'approve' ? 'Endorsement submitted successfully.' : 'Endorsement rejected.';
        setTimeout(function() { location.reload(); }, 1500);
      } catch(e) {
        msg.className = 'error';
        msg.textContent = 'Error: ' + e.message;
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
      }
    }
    </script>`
  }
  </div>
</body>
</html>`;
}

function buildEndorsementEmailHtml(
  payeeName: string,
  checkNum: string,
  carrier: string,
  amount: number | null,
  endorsementUrl: string,
): string {
  const amountStr = amount != null
    ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
    : "N/A";
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background:#1e293b;padding:24px 32px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:20px;">Insurance Check Endorsement</h1>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="color:#334155;font-size:16px;margin:0 0 20px;">Hello ${escHtml(payeeName)},</p>
          <p style="color:#475569;font-size:14px;margin:0 0 24px;">An insurance check requires your endorsement before it can be processed.</p>
          <table width="100%" style="margin:0 0 24px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tr style="background:#f8fafc;">
              <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Carrier</td>
              <td style="padding:12px 16px;font-weight:600;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">${escHtml(carrier)}</td>
            </tr>
            <tr>
              <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Check #</td>
              <td style="padding:12px 16px;font-weight:600;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">${escHtml(checkNum)}</td>
            </tr>
            <tr style="background:#f8fafc;">
              <td style="padding:12px 16px;color:#64748b;font-size:13px;">Amount</td>
              <td style="padding:12px 16px;font-weight:700;color:#16a34a;font-size:16px;text-align:right;">${escHtml(amountStr)}</td>
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 24px;">
              <a href="${escHtml(endorsementUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">Review &amp; Endorse Check</a>
            </td></tr>
          </table>
          <p style="color:#94a3b8;font-size:12px;margin:0;text-align:center;">This link expires in 30 days. If you did not expect this, please disregard.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const url = new URL(req.url);
    const tokenParam = url.searchParams.get("token");
    if (req.method === "GET" && tokenParam) {
      return await handlePublicEndorsementPage(supabase, supabaseUrl, tokenParam);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action as string | undefined;

    switch (action) {
      case "send_endorsement_request": {
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) return json({ error: "Unauthorized" }, 401);

        const anon = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: ud, error: ae } = await anon.auth.getUser(token);
        if (ae || !ud?.user) return json({ error: "Unauthorized" }, 401);

        const payeeId = body.payeeId as string;
        const method = body.method as string;
        if (!payeeId || !method) return json({ error: "payeeId and method required" }, 400);

        const { data: payee, error: pErr } = await supabase
          .from("check_payees")
          .select("*, check_intake_items(check_number, carrier_name, amount)")
          .eq("id", payeeId)
          .single();

        if (pErr || !payee) return json({ error: "Payee not found" }, 404);

        // Rate-limit: 5 min cooldown
        if (payee.notification_sent_at) {
          const lastSent = new Date(payee.notification_sent_at).getTime();
          if (Date.now() - lastSent < 5 * 60 * 1000) {
            return json({ error: "Endorsement request was sent recently. Please wait before resending." }, 429);
          }
        }

        const endorsementUrl = `${supabaseUrl}/functions/v1/check-endorsement?token=${payee.endorsement_token}`;
        const checkNum = payee.check_intake_items?.check_number ?? "N/A";
        const carrier = payee.check_intake_items?.carrier_name ?? "Unknown";
        const amount = payee.check_intake_items?.amount ?? null;

        let emailSent = false;
        let smsSent = false;
        let emailError: string | null = null;
        let smsError: string | null = null;

        if ((method === "email" || method === "both") && payee.contact_email) {
          try {
            const { error: invokeErr } = await supabase.functions.invoke("send-email", {
              body: {
                to: payee.contact_email,
                subject: `Endorsement Required — Check #${checkNum}`,
                html: buildEndorsementEmailHtml(payee.payee_name, checkNum, carrier, amount, endorsementUrl),
              },
            });
            if (invokeErr) throw invokeErr;
            emailSent = true;
          } catch (e) {
            emailError = e instanceof Error ? e.message : String(e);
            console.error("Email send failed:", emailError);
          }
        }

        if ((method === "sms" || method === "both") && payee.contact_phone) {
          try {
            const { error: invokeErr } = await supabase.functions.invoke("send-sms", {
              body: {
                to: payee.contact_phone,
                message: `Endorsement needed for check #${checkNum} ($${amount ?? "N/A"}) from ${carrier}. Review & sign: ${endorsementUrl}`,
              },
            });
            if (invokeErr) throw invokeErr;
            smsSent = true;
          } catch (e) {
            smsError = e instanceof Error ? e.message : String(e);
            console.error("SMS send failed:", smsError);
          }
        }

        // Only mark notification as sent if at least one delivery succeeded
        const anyDelivered = emailSent || smsSent;
        const deliveryStatus = anyDelivered
          ? (emailSent && smsSent ? "delivered_both" : emailSent ? "delivered_email" : "delivered_sms")
          : "failed";
        const deliveryError = !anyDelivered
          ? [emailError, smsError].filter(Boolean).join("; ")
          : null;

        await supabase.from("check_payees").update({
          notification_sent_via: anyDelivered ? method : null,
          notification_sent_at: anyDelivered ? new Date().toISOString() : payee.notification_sent_at,
          notification_delivery_status: deliveryStatus,
          notification_error: deliveryError,
        }).eq("id", payeeId);

        await supabase.from("check_endorsement_events").insert({
          check_id: payee.check_id,
          payee_id: payeeId,
          event_type: anyDelivered ? "endorsement_request_sent" : "endorsement_request_failed",
          event_data: { method, emailSent, smsSent, emailError, smsError },
          actor_id: ud.user.id,
        });

        await supabase.from("check_audit_log").insert({
          check_id: payee.check_id,
          event_type: anyDelivered ? "endorsement_request_sent" : "endorsement_request_failed",
          event_description: anyDelivered
            ? `Endorsement request sent to ${payee.payee_name} via ${method}`
            : `Endorsement delivery to ${payee.payee_name} failed: ${deliveryError}`,
          event_data: { payee_id: payeeId, method, emailSent, smsSent },
          actor_id: ud.user.id,
        });

        if (anyDelivered) {
          await supabase.from("check_intake_items")
            .update({ status: "endorsements_in_progress" })
            .eq("id", payee.check_id);
        }

        if (!anyDelivered) {
          return json({
            success: false,
            error: "All delivery methods failed",
            details: { emailError, smsError },
          }, 502);
        }

        return json({ success: true, endorsementUrl, emailSent, smsSent });
      }

      case "submit_endorsement": {
        const eToken = body.token as string;
        const endorsementImagePath = body.endorsementImagePath as string | undefined;
        if (!eToken) return json({ error: "Token required" }, 400);

        const { data: payee, error: pErr } = await supabase
          .from("check_payees")
          .select("*")
          .eq("endorsement_token", eToken)
          .single();

        if (pErr || !payee) return json({ error: "Invalid or already-used token" }, 404);

        if (
          payee.endorsement_token_expires_at &&
          new Date(payee.endorsement_token_expires_at) < new Date()
        ) {
          await supabase.from("check_payees").update({ endorsement_status: "expired" }).eq("id", payee.id);
          return json({ error: "Token expired" }, 410);
        }

        if (payee.endorsement_status === "signed") {
          return json({ success: true, message: "Already endorsed" });
        }

        // Capture signer forensics
        const forensics = signerForensics(req);

        // Rotate token after use
        const newToken = crypto.randomUUID();
        await supabase.from("check_payees").update({
          endorsement_status: "signed",
          endorsement_image_path: endorsementImagePath ?? null,
          endorsed_at: new Date().toISOString(),
          endorsement_token: newToken,
          endorsement_token_expires_at: null,
        }).eq("id", payee.id);

        await supabase.from("check_endorsement_events").insert({
          check_id: payee.check_id,
          payee_id: payee.id,
          event_type: "endorsement_signed",
          event_data: {
            has_image: !!endorsementImagePath,
            ...forensics,
          },
        });

        await supabase.from("check_audit_log").insert({
          check_id: payee.check_id,
          event_type: "endorsement_completed",
          event_description: `${payee.payee_name} endorsed the check`,
          event_data: {
            payee_id: payee.id,
            ...forensics,
          },
        });

        const result = await reEvaluateAfterEndorsement(supabase, payee.check_id);
        return json({ success: true, ...result });
      }

      case "reject_endorsement": {
        const rToken = body.token as string;
        const reason = body.reason as string | undefined;
        if (!rToken) return json({ error: "Token required" }, 400);

        const { data: payee, error: pErr } = await supabase
          .from("check_payees")
          .select("*")
          .eq("endorsement_token", rToken)
          .single();

        if (pErr || !payee) return json({ error: "Invalid or already-used token" }, 404);

        // Capture signer forensics
        const forensics = signerForensics(req);

        const newToken = crypto.randomUUID();
        await supabase.from("check_payees").update({
          endorsement_status: "rejected",
          endorsement_token: newToken,
          endorsement_token_expires_at: null,
        }).eq("id", payee.id);

        await supabase.from("check_endorsement_events").insert({
          check_id: payee.check_id,
          payee_id: payee.id,
          event_type: "endorsement_rejected",
          event_data: {
            reason,
            ...forensics,
          },
        });

        await supabase.from("check_audit_log").insert({
          check_id: payee.check_id,
          event_type: "endorsement_rejected",
          event_description: `${payee.payee_name} rejected endorsement: ${reason ?? "No reason"}`,
          event_data: {
            payee_id: payee.id,
            reason,
            ...forensics,
          },
        });

        await reEvaluateAfterEndorsement(supabase, payee.check_id);
        return json({ success: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error("check-endorsement error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

async function handlePublicEndorsementPage(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  token: string,
) {
  const { data: payee, error } = await supabase
    .from("check_payees")
    .select("*, check_intake_items(carrier_name, check_number, amount, is_multi_payee, deposit_recommendation)")
    .eq("endorsement_token", token)
    .single();

  if (error || !payee) {
    return htmlResp(
      `<!DOCTYPE html><html><body style="background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif"><h1>Invalid or expired endorsement link.</h1></body></html>`,
      404,
    );
  }

  if (
    payee.endorsement_token_expires_at &&
    new Date(payee.endorsement_token_expires_at) < new Date()
  ) {
    await supabase.from("check_payees").update({ endorsement_status: "expired" }).eq("id", payee.id);
    (payee as CheckPayee).endorsement_status = "expired";
  }

  if (payee.endorsement_status === "pending") {
    await supabase.from("check_payees").update({ endorsement_status: "viewed" }).eq("id", payee.id);
    await supabase.from("check_endorsement_events").insert({
      check_id: payee.check_id,
      payee_id: payee.id,
      event_type: "endorsement_viewed",
    });
    (payee as CheckPayee).endorsement_status = "viewed";
  }

  return htmlResp(renderEndorsementPage(payee as CheckPayee, supabaseUrl));
}
