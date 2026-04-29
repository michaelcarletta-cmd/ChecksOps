import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Endorsement {
  id: string;
  check_id: string;
  payee_id: string | null;
  payee_name: string;
  payee_type: string;
  status: string;
  signature_method: string;
  token: string | null;
  token_expires_at: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  reminder_count: number;
  last_reminder_at: string | null;
  request_sent_at: string | null;
  check_intake_items?: {
    carrier_name: string | null;
    check_number: string | null;
    amount: number | null;
    is_multi_payee: boolean;
    deposit_recommendation: string | null;
  } | null;
}

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

function signerForensics(req: Request, consentText?: string): Record<string, string | null> {
  return {
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? req.headers.get("cf-connecting-ip")
      ?? null,
    user_agent: req.headers.get("user-agent") ?? null,
    consent_text: consentText || "I agree to use electronic records and electronic signatures for this endorsement. I confirm my identity as the named payee, intend my electronic signature to be legally binding, and authorize the electronic endorsement of this insurance check payment. I understand I may decline to sign electronically and request another process.",
    signed_at_utc: new Date().toISOString(),
  };
}

const db = (client: ReturnType<typeof createClient>) => client as any;

async function refreshCompositeBackImage(checkId: string) {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    console.log(`[ENDORSEMENT] Refreshing signature composite for check ${checkId}`);

    const response = await fetch(`${supabaseUrl}/functions/v1/composite-endorsement-signatures`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ checkId }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      console.error(
        `[ENDORSEMENT] Signature composite refresh failed for check ${checkId}: ${response.status} ${responseText}`,
      );
      return;
    }

    console.log(`[ENDORSEMENT] Signature composite refresh completed for check ${checkId}: ${responseText}`);
  } catch (compositeErr) {
    console.error("Auto signature composite refresh failed (non-blocking):", compositeErr);
  }
}

async function reEvaluateAfterEndorsement(
  supabase: any,
  checkId: string,
) {
  const { data: allEndorsements } = await supabase
    .from("check_endorsements")
    .select("status, payee_type")
    .eq("check_id", checkId);

  if (!allEndorsements?.length) return { allSigned: false, newStatus: null };

  const allDone = allEndorsements.every(
    (e: { status: string; payee_type: string }) =>
      e.status === "signed" || e.status === "waived" ||
      (e.payee_type === "mortgage_company" && e.status === "manual_required"),
  );
  const anyRejected = allEndorsements.some(
    (e: { status: string }) => e.status === "rejected",
  );

  if (anyRejected) {
    await supabase.from("check_intake_items")
      .update({ status: "needs_review" })
      .eq("id", checkId);

    await refreshCompositeBackImage(checkId);
    return { allSigned: false, newStatus: "needs_review" };
  }

  if (allDone) {
    const { data: check } = await supabase
      .from("check_intake_items")
      .select("is_multi_payee, deposit_recommendation")
      .eq("id", checkId)
      .single();

    const originalRec = check?.deposit_recommendation ?? "";

    if (originalRec === "loss_draft_required") {
      await supabase.from("check_intake_items")
        .update({ status: "loss_draft_required" })
        .eq("id", checkId);

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "all_endorsements_complete",
        event_description: "All endorsements complete — routed to loss draft workflow",
      });
    } else if (originalRec === "branch_deposit_recommended") {
      await supabase.from("check_intake_items")
        .update({ status: "branch_deposit_required" })
        .eq("id", checkId);

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "all_endorsements_complete",
        event_description: "All endorsements complete — routed to branch deposit workflow",
      });
    } else {
      await supabase.from("check_intake_items")
        .update({ status: "approved_for_deposit", deposit_recommendation: "ready_for_deposit" })
        .eq("id", checkId);

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "all_endorsements_complete",
        event_description: "All endorsements complete — ready for deposit",
      });
    }

    // Auto-generate endorsement packet
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      await fetch(`${supabaseUrl}/functions/v1/generate-endorsement-packet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ checkId, automatic: true }),
      });
    } catch (packetErr) {
      console.error("Auto packet generation failed (non-blocking):", packetErr);
    }

    await refreshCompositeBackImage(checkId);

    // Trigger payment direction workflow for linked claim_checks
    try {
      const { data: linkedCheck } = await supabase
        .from("claim_checks")
        .select("id, claim_id")
        .eq("check_intake_item_id", checkId)
        .maybeSingle();

      if (linkedCheck) {
        await supabase
          .from("claim_checks")
          .update({ endorsement_status: "signed" })
          .eq("id", linkedCheck.id);

        // Check if a payment direction request already exists (pending OR already answered during signing)
        const { data: existingPD } = await supabase
          .from("check_payment_directions")
          .select("id")
          .eq("check_id", linkedCheck.id)
          .in("request_status", ["pending", "answered"])
          .maybeSingle();

        if (!existingPD) {
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 21);

          const { data: pdRequest } = await supabase
            .from("check_payment_directions")
            .insert({
              claim_id: linkedCheck.claim_id,
              check_id: linkedCheck.id,
              request_status: "pending",
              expires_at: expiresAt.toISOString(),
            })
            .select()
            .single();

          if (pdRequest) {
            await supabase
              .from("claim_checks")
              .update({ payment_direction_status: "requested" })
              .eq("id", linkedCheck.id);

            // Send payment direction notification
            const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
            const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

            // Determine app URL for the payment direction link
            const appUrl = Deno.env.get("APP_URL") || `${supabaseUrl.replace('.supabase.co', '.lovable.app')}`;
            const requestUrl = `${appUrl}/payment-direction/${pdRequest.secure_token}`;

            await fetch(`${supabaseUrl}/functions/v1/send-payment-direction-request`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${serviceKey}`,
              },
              body: JSON.stringify({
                claimId: linkedCheck.claim_id,
                checkId: linkedCheck.id,
                requestUrl,
                subject: "Payment direction needed for your insurance check",
              }),
            });

            console.log(`[ENDORSEMENT] Payment direction request created for claim_check ${linkedCheck.id}`);

            await supabase.from("check_audit_log").insert({
              check_id: checkId,
              event_type: "payment_direction_triggered",
              event_description: `Payment direction request automatically triggered after endorsement completion`,
              event_data: { claim_check_id: linkedCheck.id, payment_direction_id: pdRequest.id },
            });
          }
        }
      }
    } catch (pdErr) {
      console.error("Payment direction trigger failed (non-blocking):", pdErr);
    }

    return { allSigned: true, newStatus: check?.is_multi_payee || RESTRICTED_RECOMMENDATIONS.has(originalRec) ? "endorsements_complete" : "ready" };
  }

  await refreshCompositeBackImage(checkId);
  return { allSigned: false, newStatus: null };
}

/* ------------------------------------------------------------------ */
/*  Endorsement Signing Page (with signature canvas)                   */
/* ------------------------------------------------------------------ */

function renderEndorsementPage(endorsement: Endorsement, supabaseUrl: string): string {
  const carrier = endorsement.check_intake_items?.carrier_name ?? "Unknown Carrier";
  const checkNum = endorsement.check_intake_items?.check_number ?? "N/A";
  const amount = endorsement.check_intake_items?.amount;
  const amountStr = amount != null
    ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
    : "N/A";
  const token = endorsement.token ?? "";
  const fnUrl = `${supabaseUrl}/functions/v1/check-endorsement`;

  const alreadySigned = endorsement.status === "signed" || endorsement.status === "waived";
  const isRejected = endorsement.status === "rejected";
  const isExpired = endorsement.status === "expired";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Endorsement — Check #${escHtml(checkNum)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;max-width:520px;width:100%;padding:32px}
    h1{font-size:20px;margin-bottom:4px}
    .sub{color:#94a3b8;font-size:14px;margin-bottom:24px}
    .detail{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #334155;font-size:14px}
    .detail .label{color:#94a3b8}
    .detail .value{font-weight:600}
    .amount{font-size:28px;font-weight:700;text-align:center;padding:20px 0;color:#22c55e}
    .sig-section{margin-top:20px}
    .sig-tabs{display:flex;gap:8px;margin-bottom:12px}
    .sig-tab{padding:8px 16px;border-radius:6px;border:1px solid #334155;background:transparent;color:#94a3b8;cursor:pointer;font-size:13px;font-weight:500}
    .sig-tab.active{background:#334155;color:#e2e8f0}
    .sig-canvas-wrap{border:2px dashed #334155;border-radius:8px;position:relative;background:#0f172a;margin-bottom:8px}
    canvas{display:block;width:100%;border-radius:8px;cursor:crosshair}
    .sig-input{width:100%;padding:14px;border:2px solid #334155;border-radius:8px;background:#0f172a;color:#e2e8f0;font-size:24px;font-family:'Dancing Script',cursive,'Brush Script MT',cursive}
    .sig-typed-preview{text-align:center;font-size:32px;font-family:'Dancing Script',cursive,'Brush Script MT',cursive;color:#e2e8f0;padding:20px;border:2px dashed #334155;border-radius:8px;background:#0f172a;min-height:80px;display:flex;align-items:center;justify-content:center}
    .clear-btn{position:absolute;top:8px;right:8px;background:#334155;border:none;color:#94a3b8;padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer}
    .actions{display:flex;gap:12px;margin-top:20px}
    .btn{flex:1;padding:14px;border-radius:8px;border:none;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s}
    .btn-approve{background:#22c55e;color:#0f172a}
    .btn-reject{background:#334155;color:#e2e8f0}
    .btn:hover{opacity:0.85;transform:translateY(-1px)}
    .btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}
    .status{text-align:center;padding:24px;font-size:18px;font-weight:600}
    .status.signed{color:#22c55e}
    .status.rejected{color:#ef4444}
    .status.expired{color:#94a3b8}
    #msg{text-align:center;margin-top:12px;font-size:13px;min-height:20px}
    .error{color:#ef4444}
    .success{color:#22c55e}
    .consent{font-size:11px;color:#64748b;margin-top:16px;text-align:center;line-height:1.5}
    .auth-text{font-size:13px;color:#94a3b8;margin-bottom:12px;padding:12px;background:#0f172a;border-radius:8px;border:1px solid #334155;line-height:1.6}
    @import url('https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&display=swap');
  </style>
</head>
<body>
  <div class="card">
    <h1>Insurance Check Endorsement</h1>
    <p class="sub">You have been identified as a payee on the following check.</p>
    <div class="detail"><span class="label">Carrier</span><span class="value">${escHtml(carrier)}</span></div>
    <div class="detail"><span class="label">Check #</span><span class="value">${escHtml(checkNum)}</span></div>
    <div class="detail"><span class="label">Your Name</span><span class="value">${escHtml(endorsement.payee_name)}</span></div>
    <div class="amount">${escHtml(amountStr)}</div>

    ${alreadySigned
      ? '<div class="status signed">&#x2713; You have already endorsed this check.</div>'
      : isRejected
      ? '<div class="status rejected">&#x2717; You have rejected this endorsement.</div>'
      : isExpired
      ? '<div class="status expired">This endorsement link has expired.</div>'
      : `
    <div class="auth-text">
      <strong>Authorization:</strong> I, <strong>${escHtml(endorsement.payee_name)}</strong>, hereby authorize the endorsement of the above check. I confirm my identity as the named payee and consent to the electronic endorsement of this insurance payment.
    </div>

    <div class="sig-section">
      <p style="font-size:13px;color:#94a3b8;margin-bottom:8px;font-weight:600;">Your Signature</p>
      <div class="sig-tabs">
        <button class="sig-tab active" id="tabDraw" onclick="switchTab('draw')">Draw</button>
        <button class="sig-tab" id="tabType" onclick="switchTab('type')">Type</button>
      </div>
      <div id="drawSection">
        <div class="sig-canvas-wrap">
          <canvas id="sigCanvas" height="120"></canvas>
          <button class="clear-btn" onclick="clearCanvas()">Clear</button>
        </div>
      </div>
      <div id="typeSection" style="display:none">
        <input type="text" class="sig-input" id="typedSig" placeholder="Type your full name..." oninput="updatePreview()">
        <div class="sig-typed-preview" id="typedPreview" style="margin-top:8px"></div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-approve" id="approveBtn" onclick="submitEndorsement('approve')">Endorse Check</button>
      <button class="btn btn-reject" id="rejectBtn" onclick="submitEndorsement('reject')">Reject</button>
    </div>
    <div id="msg"></div>
    <p class="consent">By endorsing, you agree: "I confirm my identity as the named payee and authorize the electronic endorsement of this insurance check payment."</p>

    <script>
    var canvas=document.getElementById('sigCanvas'),ctx=canvas.getContext('2d');
    var drawing=false,mode='draw',sigData=null;

    function resizeCanvas(){canvas.width=canvas.parentElement.clientWidth;ctx.strokeStyle='#e2e8f0';ctx.lineWidth=2;ctx.lineCap='round';}
    resizeCanvas();
    window.addEventListener('resize',resizeCanvas);

    canvas.addEventListener('mousedown',function(e){drawing=true;ctx.beginPath();ctx.moveTo(e.offsetX,e.offsetY);});
    canvas.addEventListener('mousemove',function(e){if(!drawing)return;ctx.lineTo(e.offsetX,e.offsetY);ctx.stroke();});
    canvas.addEventListener('mouseup',function(){drawing=false;});
    canvas.addEventListener('mouseleave',function(){drawing=false;});

    canvas.addEventListener('touchstart',function(e){e.preventDefault();drawing=true;var t=e.touches[0];var r=canvas.getBoundingClientRect();ctx.beginPath();ctx.moveTo(t.clientX-r.left,t.clientY-r.top);},{passive:false});
    canvas.addEventListener('touchmove',function(e){e.preventDefault();if(!drawing)return;var t=e.touches[0];var r=canvas.getBoundingClientRect();ctx.lineTo(t.clientX-r.left,t.clientY-r.top);ctx.stroke();},{passive:false});
    canvas.addEventListener('touchend',function(){drawing=false;});

    function clearCanvas(){ctx.clearRect(0,0,canvas.width,canvas.height);}

    function switchTab(t){
      mode=t;
      document.getElementById('tabDraw').classList.toggle('active',t==='draw');
      document.getElementById('tabType').classList.toggle('active',t==='type');
      document.getElementById('drawSection').style.display=t==='draw'?'block':'none';
      document.getElementById('typeSection').style.display=t==='type'?'block':'none';
    }

    function updatePreview(){
      var v=document.getElementById('typedSig').value;
      document.getElementById('typedPreview').textContent=v||'';
    }

    function getSignatureData(){
      if(mode==='draw'){
        var d=ctx.getImageData(0,0,canvas.width,canvas.height).data;
        var empty=true;
        for(var i=3;i<d.length;i+=4){if(d[i]>0){empty=false;break;}}
        if(empty)return null;
        return canvas.toDataURL('image/png');
      } else {
        var v=document.getElementById('typedSig').value.trim();
        if(!v)return null;
        return 'typed:'+v;
      }
    }

    async function submitEndorsement(type){
      var msg=document.getElementById('msg');
      var approveBtn=document.getElementById('approveBtn');
      var rejectBtn=document.getElementById('rejectBtn');

      if(type==='approve'){
        var sig=getSignatureData();
        if(!sig){msg.className='error';msg.textContent='Please provide your signature before endorsing.';return;}
      }

      approveBtn.disabled=true;rejectBtn.disabled=true;
      msg.textContent='Processing...';msg.className='';
      try{
        var action=type==='approve'?'submit_endorsement':'reject_endorsement';
        var body={action:action,token:'${escHtml(token)}'};
        if(type==='approve')body.signatureData=getSignatureData();
        if(type==='reject')body.reason='Payee declined';
        var resp=await fetch('${escHtml(fnUrl)}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        var data=await resp.json();
        if(!resp.ok)throw new Error(data.error||'Request failed');
        msg.className=type==='approve'?'success':'error';
        msg.textContent=type==='approve'?'Endorsement submitted successfully.':'Endorsement rejected.';
        setTimeout(function(){location.reload();},1500);
      }catch(e){
        msg.className='error';msg.textContent='Error: '+e.message;
        approveBtn.disabled=false;rejectBtn.disabled=false;
      }
    }
    </script>`
    }
  </div>
</body>
</html>`;
}

interface EndorsementBranding {
  company_name?: string;
  company_email?: string;
  company_phone?: string;
  endorsement_email_subject?: string;
  endorsement_email_body?: string;
  endorsement_email_header_color?: string;
  endorsement_email_button_color?: string;
  letterhead_url?: string;
}

function replaceEndorsementMergeFields(text: string, payeeName: string, checkNum: string, carrier: string, amount: number | null, endorsementUrl: string, branding: EndorsementBranding): string {
  const amountStr = amount != null ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "N/A";
  return text
    .replace(/\{payee\.name\}/g, payeeName)
    .replace(/\{check\.number\}/g, checkNum)
    .replace(/\{check\.carrier\}/g, carrier)
    .replace(/\{check\.amount\}/g, amountStr)
    .replace(/\{endorse\.url\}/g, endorsementUrl)
    .replace(/\{company\.name\}/g, branding.company_name || "Freedom Claims")
    .replace(/\{company\.email\}/g, branding.company_email || "")
    .replace(/\{company\.phone\}/g, branding.company_phone || "");
}

function buildEndorsementEmailHtml(
  payeeName: string,
  checkNum: string,
  carrier: string,
  amount: number | null,
  endorsementUrl: string,
  branding: EndorsementBranding = {},
): string {
  const amountStr = amount != null
    ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
    : "N/A";
  const headerColor = branding.endorsement_email_header_color || "#1e293b";
  const buttonColor = branding.endorsement_email_button_color || "#2563eb";
  const companyName = branding.company_name || "Freedom Claims";
  const logoUrl = branding.letterhead_url || "";

  const rawBody = branding.endorsement_email_body || "An insurance check requires your endorsement before it can be processed. Please review the details below and complete your endorsement.";
  const processedBody = replaceEndorsementMergeFields(rawBody, payeeName, checkNum, carrier, amount, endorsementUrl, branding).replace(/\n/g, "<br>");

  const logoBlock = logoUrl
    ? `<img src="${escHtml(logoUrl)}" alt="${escHtml(companyName)}" style="max-height:48px;max-width:200px;object-fit:contain;" />`
    : `<span style="font-size:20px;font-weight:700;color:#ffffff;">${escHtml(companyName)}</span>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr><td style="background-color:${headerColor};padding:24px 32px;text-align:center;">
          ${logoBlock}
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="color:#1a1a2e;font-size:16px;font-weight:600;margin:0 0 8px;">Hello ${escHtml(payeeName)},</p>
          <p style="color:#4a4a68;font-size:15px;margin:0 0 24px;line-height:1.6;">${processedBody}</p>
          <table width="100%" style="margin:0 0 24px;background-color:#f8f9fb;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:12px 20px;color:#6b7280;font-size:13px;border-bottom:1px solid #e5e7eb;">Carrier</td>
              <td style="padding:12px 20px;font-weight:600;color:#1a1a2e;font-size:13px;border-bottom:1px solid #e5e7eb;text-align:right;">${escHtml(carrier)}</td>
            </tr>
            <tr>
              <td style="padding:12px 20px;color:#6b7280;font-size:13px;border-bottom:1px solid #e5e7eb;">Check #</td>
              <td style="padding:12px 20px;font-weight:600;color:#1a1a2e;font-size:13px;border-bottom:1px solid #e5e7eb;text-align:right;">${escHtml(checkNum)}</td>
            </tr>
            <tr>
              <td style="padding:12px 20px;color:#6b7280;font-size:13px;">Amount</td>
              <td style="padding:12px 20px;font-weight:700;color:#16a34a;font-size:16px;text-align:right;">${escHtml(amountStr)}</td>
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 24px;">
              <a href="${escHtml(endorsementUrl)}" style="display:inline-block;background-color:${buttonColor};color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:6px;font-size:16px;font-weight:600;">Review &amp; Endorse Check</a>
            </td></tr>
          </table>
          <p style="color:#9ca3af;font-size:12px;margin:0;text-align:center;">This link expires in 30 days. If you did not expect this, please disregard.</p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #e5e7eb;background-color:#f8f9fb;">
          <p style="color:#6b7280;font-size:12px;margin:0 0 4px;">${escHtml(companyName)}${branding.company_phone ? ` &bull; ${escHtml(branding.company_phone)}` : ""}${branding.company_email ? ` &bull; ${escHtml(branding.company_email)}` : ""}</p>
          <p style="color:#9ca3af;font-size:11px;margin:0;">This is an automated message. Please do not reply directly to this email.</p>
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
  const supabase = createClient<any>(supabaseUrl, serviceKey);

  try {
    const url = new URL(req.url);
    const tokenParam = url.searchParams.get("token");

    // GET with token → redirect to frontend endorsement page
    if (req.method === "GET" && tokenParam) {
      const appUrl = Deno.env.get("APP_URL") || "https://freedomclaims.lovable.app";
      return new Response(null, {
        status: 302,
        headers: { ...corsHeaders, Location: `${appUrl}/endorse?token=${tokenParam}` },
      });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action as string | undefined;

    switch (action) {
      /* ------------------------------------------------------------ */
      /*  Get endorsement data (public, token-based, for React page)   */
      /* ------------------------------------------------------------ */
      case "get_endorsement_data": {
        const eToken = body.token as string;
        if (!eToken) return json({ error: "Token required" }, 400);

        const { data: endorsement, error: eErr } = await supabase
          .from("check_endorsements")
          .select("id, payee_name, payee_type, status, token, token_expires_at, check_id, check_intake_items(carrier_name, check_number, amount, claim_id)")
          .eq("token", eToken)
          .single();

        if (eErr || !endorsement) return json({ error: "Invalid or expired endorsement link" }, 404);

        // Check expiry
        if (endorsement.token_expires_at && new Date(endorsement.token_expires_at) < new Date()) {
          await supabase.from("check_endorsements").update({ status: "expired" }).eq("id", endorsement.id);
          return json({ error: "This endorsement link has expired" }, 410);
        }

        const ci = endorsement.check_intake_items as any;

        // Determine if this endorsement needs a payment direction answer.
        // Only show for non-mortgage payees on checks linked to a claim.
        let requiresPaymentDirection = false;
        // Only show payment direction for client (insured) payees, not for
        // mortgage companies, contractors, public adjusters, or internal signatures
        const clientPayeeTypes = ["insured"];
        if (
          clientPayeeTypes.includes(endorsement.payee_type ?? "") &&
          endorsement.status !== "signed" &&
          endorsement.status !== "waived" &&
          ci?.claim_id
        ) {
          // Check if a payment direction already exists for this check's claim_checks record
          const { data: linkedCheck } = await supabase
            .from("claim_checks")
            .select("id")
            .eq("check_intake_item_id", endorsement.check_id)
            .maybeSingle();

          if (linkedCheck) {
            const { data: existingPD } = await supabase
              .from("check_payment_directions")
              .select("id")
              .eq("check_id", linkedCheck.id)
              .in("request_status", ["pending", "answered"])
              .maybeSingle();

            // Only require payment direction if none exists yet
            requiresPaymentDirection = !existingPD;
          }
        }

        return json({
          id: endorsement.id,
          payee_name: endorsement.payee_name,
          status: endorsement.status,
          carrier_name: ci?.carrier_name ?? "Unknown Carrier",
          check_number: ci?.check_number ?? "N/A",
          amount: ci?.amount ?? null,
          token: endorsement.token,
          requires_payment_direction: requiresPaymentDirection,
        });
      }
      /* ------------------------------------------------------------ */
      /*  Send endorsement request (authenticated)                     */
      /* ------------------------------------------------------------ */
      case "send_endorsement_request": {
        const authToken = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!authToken) return json({ error: "Unauthorized" }, 401);

        const anon = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${authToken}` } },
        });
        const { data: ud, error: ae } = await anon.auth.getUser(authToken);
        if (ae || !ud?.user) return json({ error: "Unauthorized" }, 401);

        let endorsementId = body.endorsementId as string | undefined;
        const payeeId = body.payeeId as string | undefined;
        const method = body.method as string | undefined;

        console.log("send_endorsement_request body keys:", Object.keys(body));
        console.log("endorsementId:", endorsementId, "payeeId:", payeeId, "method:", method);

        // Support lookup by payeeId if endorsementId not provided
        if (!endorsementId && payeeId) {
          const { data: found } = await supabase
            .from("check_endorsements")
            .select("id")
            .eq("payee_id", payeeId)
            .limit(1)
            .maybeSingle();
          if (found) {
            endorsementId = found.id;
          } else {
            // Auto-create endorsement from check_payees record
            const { data: payee } = await supabase
              .from("check_payees")
              .select("*")
              .eq("id", payeeId)
              .single();
            if (payee) {
              const { data: created, error: cErr } = await supabase
                .from("check_endorsements")
                .insert({
                  check_id: payee.check_id,
                  payee_id: payee.id,
                  payee_name: payee.payee_name,
                  payee_type: payee.payee_type ?? "other",
                  status: "pending",
                  signature_method: "portal",
                  contact_email: payee.contact_email ?? (body.email as string | undefined) ?? null,
                  contact_phone: payee.contact_phone ?? (body.phone as string | undefined) ?? null,
                })
                .select("id")
                .single();
              if (cErr) console.error("Failed to auto-create endorsement:", cErr.message);
              if (created) endorsementId = created.id;
            }
          }
        }

        if (!endorsementId || !method) {
          return json({ error: `endorsementId (or payeeId) and method required. Got endorsementId=${endorsementId}, payeeId=${payeeId}, method=${method}` }, 400);
        }

        const { data: endorsement, error: eErr } = await supabase
          .from("check_endorsements")
          .select("*, check_intake_items(check_number, carrier_name, amount)")
          .eq("id", endorsementId)
          .single();

        if (eErr || !endorsement) return json({ error: "Endorsement not found" }, 404);

        // Rate-limit: 5 min cooldown
        if (endorsement.request_sent_at) {
          const lastSent = new Date(endorsement.request_sent_at).getTime();
          if (Date.now() - lastSent < 5 * 60 * 1000) {
            return json({ error: "Request was sent recently. Please wait before resending." }, 429);
          }
        }

        // Update contact info if provided
        const newEmail = body.email as string | undefined;
        const newPhone = body.phone as string | undefined;
        const normalizedEmail = newEmail?.trim();
        const normalizedPhone = newPhone?.trim();

        if (normalizedEmail || normalizedPhone) {
          await supabase.from("check_endorsements").update({
            contact_email: normalizedEmail || endorsement.contact_email,
            contact_phone: normalizedPhone || endorsement.contact_phone,
          }).eq("id", endorsementId);
          if (normalizedEmail) endorsement.contact_email = normalizedEmail;
          if (normalizedPhone) endorsement.contact_phone = normalizedPhone;
        }

        // If missing contact details on endorsement, hydrate from check_payees
        if (endorsement.payee_id && (!endorsement.contact_email || !endorsement.contact_phone)) {
          const { data: payeeContact } = await supabase
            .from("check_payees")
            .select("contact_email, contact_phone")
            .eq("id", endorsement.payee_id)
            .maybeSingle();

          if (payeeContact?.contact_email && !endorsement.contact_email) {
            endorsement.contact_email = payeeContact.contact_email;
          }
          if (payeeContact?.contact_phone && !endorsement.contact_phone) {
            endorsement.contact_phone = payeeContact.contact_phone;
          }
        }

        const appUrl = Deno.env.get("APP_URL") || "https://freedomclaims.lovable.app";
        const endorsementUrl = `${appUrl}/endorse?token=${endorsement.token}`;
        const checkNum = endorsement.check_intake_items?.check_number ?? "N/A";
        const carrier = endorsement.check_intake_items?.carrier_name ?? "Unknown";
        const amount = endorsement.check_intake_items?.amount ?? null;

        let emailSent = false;
        let smsSent = false;
        let emailError: string | null = null;
        let smsError: string | null = null;

        if ((method === "email" || method === "both") && !endorsement.contact_email) {
          emailError = "Missing payee email address";
        }

        if ((method === "sms" || method === "both") && !endorsement.contact_phone) {
          smsError = "Missing payee phone number";
        }

        // Load branding for email customization
        const { data: brandingRow } = await supabase
          .from("company_branding")
          .select("company_name, company_email, company_phone, endorsement_email_subject, endorsement_email_body, endorsement_email_header_color, endorsement_email_button_color, letterhead_url")
          .limit(1)
          .maybeSingle();
        const emailBranding: EndorsementBranding = brandingRow || {};

        if ((method === "email" || method === "both") && endorsement.contact_email) {
          try {
            const rawSubject = emailBranding.endorsement_email_subject || "Endorsement Required — Check #{check.number}";
            const finalSubject = replaceEndorsementMergeFields(rawSubject, endorsement.payee_name, checkNum, carrier, amount, endorsementUrl, emailBranding);
            const { error: invokeErr } = await supabase.functions.invoke("send-email", {
              body: {
                to: endorsement.contact_email,
                subject: finalSubject,
                body: buildEndorsementEmailHtml(endorsement.payee_name, checkNum, carrier, amount, endorsementUrl, emailBranding),
              },
            });
            if (invokeErr) throw invokeErr;
            emailSent = true;
          } catch (e) {
            emailError = e instanceof Error ? e.message : String(e);
          }
        }

        if ((method === "sms" || method === "both") && endorsement.contact_phone) {
          try {
            const { error: invokeErr } = await supabase.functions.invoke("send-sms", {
              body: {
                to: endorsement.contact_phone,
                message: `Endorsement needed for check #${checkNum} ($${amount ?? "N/A"}) from ${carrier}. Review & sign: ${endorsementUrl}`,
              },
            });
            if (invokeErr) throw invokeErr;
            smsSent = true;
          } catch (e) {
            smsError = e instanceof Error ? e.message : String(e);
          }
        }

        const anyDelivered = emailSent || smsSent;

        // Update endorsement record
        await supabase.from("check_endorsements").update({
          status: anyDelivered ? "sent" : endorsement.status,
          request_sent_at: anyDelivered ? new Date().toISOString() : endorsement.request_sent_at,
          last_reminder_at: endorsement.request_sent_at ? new Date().toISOString() : null,
          reminder_count: endorsement.request_sent_at ? endorsement.reminder_count + 1 : 0,
          updated_at: new Date().toISOString(),
        }).eq("id", endorsementId);

        // Log the request
        await supabase.from("endorsement_requests").insert({
          endorsement_id: endorsementId,
          check_id: endorsement.check_id,
          method,
          sent_by: ud.user.id,
          delivery_status: anyDelivered ? "delivered" : "failed",
          delivery_error: !anyDelivered ? [emailError, smsError].filter(Boolean).join("; ") : null,
          email_address: endorsement.contact_email,
          phone_number: endorsement.contact_phone,
        });

        // Also update legacy check_payees for backward compatibility
        if (endorsement.payee_id) {
          await supabase.from("check_payees").update({
            contact_email: endorsement.contact_email,
            contact_phone: endorsement.contact_phone,
            notification_sent_via: anyDelivered ? method : null,
            notification_sent_at: anyDelivered ? new Date().toISOString() : null,
            notification_delivery_status: anyDelivered ? "delivered" : "failed",
          }).eq("id", endorsement.payee_id);
        }

        // Audit
        await supabase.from("endorsement_audit_log").insert({
          endorsement_id: endorsementId,
          check_id: endorsement.check_id,
          event_type: anyDelivered ? "request_sent" : "request_failed",
          event_description: anyDelivered
            ? `Endorsement request sent to ${endorsement.payee_name} via ${method}`
            : `Delivery failed: ${[emailError, smsError].filter(Boolean).join("; ")}`,
          event_data: { method, emailSent, smsSent, emailError, smsError },
          actor_id: ud.user.id,
        });

        await supabase.from("check_audit_log").insert({
          check_id: endorsement.check_id,
          event_type: anyDelivered ? "endorsement_request_sent" : "endorsement_request_failed",
          event_description: anyDelivered
            ? `Endorsement request sent to ${endorsement.payee_name} via ${method}`
            : `Endorsement delivery failed`,
          event_data: { endorsement_id: endorsementId, method },
          actor_id: ud.user.id,
        });

        if (anyDelivered) {
          await supabase.from("check_intake_items")
            .update({ status: "endorsements_in_progress" })
            .eq("id", endorsement.check_id);
        }

        if (!anyDelivered) {
          return json({ success: false, error: "All delivery methods failed", details: { emailError, smsError } }, 502);
        }

        return json({ success: true, endorsementUrl, emailSent, smsSent });
      }

      /* ------------------------------------------------------------ */
      /*  Submit endorsement (public, token-based)                     */
      /* ------------------------------------------------------------ */
      case "submit_endorsement": {
        const eToken = body.token as string;
        const signatureData = body.signatureData as string | undefined;
        const paymentDirection = body.paymentDirection as string | undefined; // "pay_contractor" or "pay_insured"
        const contractorName = body.contractorName as string | undefined;
        const eSignConsentAccepted = body.eSignConsentAccepted === true;
        const consentText = typeof body.consentText === "string" ? body.consentText : undefined;
        if (!eToken) return json({ error: "Token required" }, 400);
        if (!eSignConsentAccepted) return json({ error: "Electronic signature consent is required" }, 400);

        const { data: endorsement, error: eErr } = await supabase
          .from("check_endorsements")
          .select("*")
          .eq("token", eToken)
          .single();

        if (eErr || !endorsement) return json({ error: "Invalid or already-used token" }, 404);

        if (endorsement.token_expires_at && new Date(endorsement.token_expires_at) < new Date()) {
          await supabase.from("check_endorsements").update({ status: "expired" }).eq("id", endorsement.id);
          return json({ error: "Token expired" }, 410);
        }

        if (endorsement.status === "signed") {
          return json({ success: true, message: "Already endorsed" });
        }

        const forensics = signerForensics(req, consentText);
        const newToken = crypto.randomUUID();

        // Determine signature image URL
        let signatureImageUrl: string | null = null;
        if (signatureData && signatureData.startsWith("data:image/")) {
          // Store as base64 reference — in production this would upload to storage
          signatureImageUrl = signatureData;
        } else if (signatureData && signatureData.startsWith("typed:")) {
          signatureImageUrl = signatureData;
        }

        // Update endorsement
        await supabase.from("check_endorsements").update({
          status: "signed",
          signed_at: new Date().toISOString(),
          signature_image_url: signatureImageUrl,
          signature_method: signatureData?.startsWith("typed:") ? "portal" : "portal",
          ip_address: forensics.ip_address,
          user_agent: forensics.user_agent,
          consent_text: forensics.consent_text,
          token: newToken,
          token_expires_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", endorsement.id);

        // Also update legacy check_payees
        if (endorsement.payee_id) {
          await supabase.from("check_payees").update({
            endorsement_status: "signed",
            endorsed_at: new Date().toISOString(),
            endorsement_image_path: signatureImageUrl,
            endorsement_token: newToken,
            endorsement_token_expires_at: null,
          }).eq("id", endorsement.payee_id);
        }

        // Audit
        await supabase.from("endorsement_audit_log").insert({
          endorsement_id: endorsement.id,
          check_id: endorsement.check_id,
          event_type: "endorsement_signed",
          event_description: `${endorsement.payee_name} endorsed the check`,
          event_data: { has_signature: !!signatureData, e_sign_consent_accepted: eSignConsentAccepted, ...forensics },
          ip_address: forensics.ip_address,
          user_agent: forensics.user_agent,
        });

        await supabase.from("check_endorsement_events").insert({
          check_id: endorsement.check_id,
          payee_id: endorsement.payee_id,
          event_type: "endorsement_signed",
          event_data: { endorsement_id: endorsement.id, ...forensics },
        });

        await supabase.from("check_audit_log").insert({
          check_id: endorsement.check_id,
          event_type: "endorsement_completed",
          event_description: `${endorsement.payee_name} endorsed the check`,
          event_data: { endorsement_id: endorsement.id, ...forensics },
        });

        // Save payment direction if provided during endorsement signing
        if (paymentDirection && (paymentDirection === "pay_contractor" || paymentDirection === "pay_insured")) {
          try {
            const { data: linkedCheck } = await supabase
              .from("claim_checks")
              .select("id, claim_id")
              .eq("check_intake_item_id", endorsement.check_id)
              .maybeSingle();

            if (linkedCheck) {
              // Check if a payment direction already exists
              const { data: existingPD } = await supabase
                .from("check_payment_directions")
                .select("id")
                .eq("check_id", linkedCheck.id)
                .in("request_status", ["pending", "answered"])
                .maybeSingle();

              if (!existingPD) {
                // Create and immediately answer the payment direction
                await supabase
                  .from("check_payment_directions")
                  .insert({
                    claim_id: linkedCheck.claim_id,
                    check_id: linkedCheck.id,
                    request_status: "answered",
                    decision: paymentDirection,
                    contractor_name: contractorName || null,
                    answered_at: new Date().toISOString(),
                    answer_source: "endorsement_signing",
                    answer_notes: `Client selected "${paymentDirection}" during endorsement signing`,
                    expires_at: new Date(Date.now() + 21 * 86400000).toISOString(),
                  });

                await supabase
                  .from("claim_checks")
                  .update({
                    endorsement_status: "signed",
                    payment_direction_status: "answered",
                  })
                  .eq("id", linkedCheck.id);

                await supabase.from("check_audit_log").insert({
                  check_id: endorsement.check_id,
                  event_type: "payment_direction_answered_during_endorsement",
                  event_description: `${endorsement.payee_name} chose "${paymentDirection}" during endorsement signing`,
                  event_data: { decision: paymentDirection, contractor_name: contractorName, ...forensics },
                });

                console.log(`[ENDORSEMENT] Payment direction "${paymentDirection}" saved inline for check ${endorsement.check_id}`);

                // Send email notification to team about payment direction
                try {
                  const { data: brandingForNotif } = await supabase
                    .from("company_branding")
                    .select("company_name, company_email")
                    .limit(1)
                    .maybeSingle();

                  const notifEmail = brandingForNotif?.company_email;
                  if (notifEmail) {
                    const decisionLabel = paymentDirection === "pay_contractor"
                      ? "Pay Contractor" + (contractorName ? ` (${contractorName})` : "")
                      : "Send Funds to Insured";

                    // Fetch claim number for context
                    const { data: claimInfo } = await supabase
                      .from("claims")
                      .select("claim_number, insured_name")
                      .eq("id", linkedCheck.claim_id)
                      .maybeSingle();

                    const claimLabel = claimInfo?.claim_number || linkedCheck.claim_id;
                    const insuredName = claimInfo?.insured_name || "the insured";
                    const companyName = brandingForNotif?.company_name || "Freedom Claims";

                    await supabase.functions.invoke("send-email", {
                      body: {
                        to: notifEmail,
                        subject: `Payment Direction Received — Claim ${claimLabel}`,
                        body: `
                          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2 style="color: #1a1a2e; margin-bottom: 16px;">Payment Direction Received</h2>
                            <p style="color: #333; font-size: 15px; line-height: 1.6;">
                              <strong>${endorsement.payee_name}</strong> has submitted their payment direction during endorsement signing.
                            </p>
                            <div style="background: #f4f6f9; border-radius: 8px; padding: 16px; margin: 16px 0;">
                              <p style="margin: 4px 0; font-size: 14px;"><strong>Claim:</strong> ${claimLabel}</p>
                              <p style="margin: 4px 0; font-size: 14px;"><strong>Insured:</strong> ${insuredName}</p>
                              <p style="margin: 4px 0; font-size: 14px;"><strong>Signer:</strong> ${endorsement.payee_name}</p>
                              <p style="margin: 4px 0; font-size: 14px;"><strong>Decision:</strong> ${decisionLabel}</p>
                            </div>
                            <p style="color: #666; font-size: 13px;">
                              You can view the full check details in the ${companyName} dashboard.
                            </p>
                          </div>
                        `,
                      },
                    });
                    console.log(`[ENDORSEMENT] Payment direction notification sent to ${notifEmail}`);
                  }
                } catch (notifErr) {
                  console.error("[ENDORSEMENT] Payment direction notification email failed (non-blocking):", notifErr);
                }
              }
            }
          } catch (pdErr) {
            console.error("[ENDORSEMENT] Inline payment direction save failed (non-blocking):", pdErr);
          }
        }

        const result = await reEvaluateAfterEndorsement(supabase, endorsement.check_id);
        return json({ success: true, ...result });
      }

      /* ------------------------------------------------------------ */
      /*  Reject endorsement (public, token-based)                     */
      /* ------------------------------------------------------------ */
      case "reject_endorsement": {
        const rToken = body.token as string;
        const reason = body.reason as string | undefined;
        if (!rToken) return json({ error: "Token required" }, 400);

        const { data: endorsement, error: eErr } = await supabase
          .from("check_endorsements")
          .select("*")
          .eq("token", rToken)
          .single();

        if (eErr || !endorsement) return json({ error: "Invalid or already-used token" }, 404);

        const forensics = signerForensics(req);
        const newToken = crypto.randomUUID();

        await supabase.from("check_endorsements").update({
          status: "rejected",
          ip_address: forensics.ip_address,
          user_agent: forensics.user_agent,
          notes: reason,
          token: newToken,
          token_expires_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", endorsement.id);

        if (endorsement.payee_id) {
          await supabase.from("check_payees").update({
            endorsement_status: "rejected",
            endorsement_token: newToken,
            endorsement_token_expires_at: null,
          }).eq("id", endorsement.payee_id);
        }

        await supabase.from("endorsement_audit_log").insert({
          endorsement_id: endorsement.id,
          check_id: endorsement.check_id,
          event_type: "endorsement_rejected",
          event_description: `${endorsement.payee_name} rejected: ${reason ?? "No reason"}`,
          event_data: { reason, ...forensics },
          ip_address: forensics.ip_address,
          user_agent: forensics.user_agent,
        });

        await supabase.from("check_audit_log").insert({
          check_id: endorsement.check_id,
          event_type: "endorsement_rejected",
          event_description: `${endorsement.payee_name} rejected endorsement`,
          event_data: { endorsement_id: endorsement.id, reason },
        });

        await reEvaluateAfterEndorsement(supabase, endorsement.check_id);
        return json({ success: true });
      }

      /* ------------------------------------------------------------ */
      /*  Mark internal endorsement (authenticated staff action)       */
      /* ------------------------------------------------------------ */
      case "mark_internal_signed": {
        const authToken = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!authToken) return json({ error: "Unauthorized" }, 401);

        const anon = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${authToken}` } },
        });
        const { data: ud, error: ae } = await anon.auth.getUser(authToken);
        if (ae || !ud?.user) return json({ error: "Unauthorized" }, 401);

        const endorsementId = body.endorsementId as string;
        if (!endorsementId) return json({ error: "endorsementId required" }, 400);

        const { data: endorsement, error: eErr } = await supabase
          .from("check_endorsements")
          .select("*")
          .eq("id", endorsementId)
          .single();

        if (eErr || !endorsement) return json({ error: "Endorsement not found" }, 404);

        await supabase.from("check_endorsements").update({
          status: "signed",
          signed_at: new Date().toISOString(),
          signature_method: "internal",
          signature_image_url: null,
          notes: (body.notes as string) ?? "Internally endorsed by staff",
          updated_at: new Date().toISOString(),
        }).eq("id", endorsementId);

        if (endorsement.payee_id) {
          await supabase.from("check_payees").update({
            endorsement_status: "signed",
            endorsed_at: new Date().toISOString(),
            endorsement_image_path: null,
          }).eq("id", endorsement.payee_id);
        }

        await supabase.from("endorsement_audit_log").insert({
          endorsement_id: endorsementId,
          check_id: endorsement.check_id,
          event_type: "internal_endorsement",
          event_description: `${endorsement.payee_name} endorsed internally by staff`,
          event_data: { notes: body.notes },
          actor_id: ud.user.id,
        });

        const result = await reEvaluateAfterEndorsement(supabase, endorsement.check_id);
        return json({ success: true, ...result });
      }

      /* ------------------------------------------------------------ */
      /*  Waive endorsement (authenticated staff action)               */
      /* ------------------------------------------------------------ */
      case "waive_endorsement": {
        const authToken = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!authToken) return json({ error: "Unauthorized" }, 401);

        const anon = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${authToken}` } },
        });
        const { data: ud, error: ae } = await anon.auth.getUser(authToken);
        if (ae || !ud?.user) return json({ error: "Unauthorized" }, 401);

        const endorsementId = body.endorsementId as string;
        if (!endorsementId) return json({ error: "endorsementId required" }, 400);

        const { data: endorsement, error: eErr } = await supabase
          .from("check_endorsements")
          .select("*")
          .eq("id", endorsementId)
          .single();

        if (eErr || !endorsement) return json({ error: "Endorsement not found" }, 404);

        await supabase.from("check_endorsements").update({
          status: "waived",
          notes: (body.notes as string) ?? "Endorsement waived by staff",
          updated_at: new Date().toISOString(),
        }).eq("id", endorsementId);

        await supabase.from("endorsement_audit_log").insert({
          endorsement_id: endorsementId,
          check_id: endorsement.check_id,
          event_type: "endorsement_waived",
          event_description: `${endorsement.payee_name} endorsement waived`,
          event_data: { reason: body.notes },
          actor_id: ud.user.id,
        });

        const result = await reEvaluateAfterEndorsement(supabase, endorsement.check_id);
        return json({ success: true, ...result });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error("check-endorsement error:", e);
    return json({ error: "An error occurred processing your request" }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Public page handler                                                */
/* ------------------------------------------------------------------ */

async function handlePublicEndorsementPage(
  supabase: any,
  supabaseUrl: string,
  token: string,
) {
  const { data: endorsement, error } = await supabase
    .from("check_endorsements")
    .select("*, check_intake_items(carrier_name, check_number, amount, is_multi_payee, deposit_recommendation)")
    .eq("token", token)
    .single();

  if (error || !endorsement) {
    return htmlResp(
      `<!DOCTYPE html><html><body style="background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif"><h1>Invalid or expired endorsement link.</h1></body></html>`,
      404,
    );
  }

  if (endorsement.token_expires_at && new Date(endorsement.token_expires_at) < new Date()) {
    await supabase.from("check_endorsements").update({ status: "expired" }).eq("id", endorsement.id);
    endorsement.status = "expired";
  }

  if (endorsement.status === "pending") {
    await supabase.from("check_endorsements").update({ status: "sent" }).eq("id", endorsement.id);
    await supabase.from("endorsement_audit_log").insert({
      endorsement_id: endorsement.id,
      check_id: endorsement.check_id,
      event_type: "page_viewed",
      event_description: `${endorsement.payee_name} viewed the endorsement page`,
    });
    endorsement.status = "sent";
  }

  return htmlResp(renderEndorsementPage(endorsement as Endorsement, supabaseUrl));
}
