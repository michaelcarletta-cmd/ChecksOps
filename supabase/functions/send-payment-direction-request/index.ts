import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY');
    const TELNYX_PHONE_NUMBER = Deno.env.get('TELNYX_PHONE_NUMBER');
    const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get('TELNYX_MESSAGING_PROFILE_ID');

    // Validate auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { claimId, checkId, requestUrl, subject, message } = await req.json();

    if (!claimId || !checkId || !requestUrl) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: claimId, checkId, requestUrl' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const serviceSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch claim details for contact info
    const { data: claim } = await serviceSupabase
      .from("claims")
      .select("policyholder_name, policyholder_email, policyholder_phone, claim_number, insurance_company")
      .eq("id", claimId)
      .single();

    if (!claim) {
      return new Response(
        JSON.stringify({ error: 'Claim not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch branding
    const { data: branding } = await serviceSupabase
      .from("company_branding")
      .select("*")
      .limit(1)
      .maybeSingle();

    const companyName = branding?.company_name || "Freedom Claims";
    const headerColor = branding?.endorsement_email_header_color || "#1e3a5f";
    const buttonColor = branding?.endorsement_email_button_color || "#1a56db";
    const logoUrl = branding?.letterhead_url || "";

    const emailSubject = subject || "Payment direction needed for your insurance check";
    const emailBody = message || `We have received the required endorsement for your insurance check.\n\nPlease tell us how you want funds handled so we can move your claim forward.\n\nDo you authorize us to pay your contractor directly for work to commence?\n\nRespond here:\n${requestUrl}`;

    // Build HTML email
    const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:${headerColor};padding:24px 32px;text-align:center">
    ${logoUrl ? `<img src="${logoUrl}" alt="${companyName}" style="max-height:48px;margin-bottom:8px"><br>` : ""}
    <span style="color:#ffffff;font-size:20px;font-weight:700">${companyName}</span>
  </td></tr>
  <tr><td style="padding:32px">
    <h2 style="margin:0 0 16px;color:#1a1a1a;font-size:22px">Payment Direction Needed</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 8px">
      Dear ${claim.policyholder_name || "Policyholder"},
    </p>
    <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 8px">
      We have received the required endorsement for your insurance check.
      Please tell us how you want funds handled so we can move your claim forward.
    </p>
    ${claim.claim_number ? `<p style="color:#555;font-size:14px;margin:0 0 4px"><strong>Claim:</strong> ${claim.claim_number}</p>` : ""}
    ${claim.insurance_company ? `<p style="color:#555;font-size:14px;margin:0 0 16px"><strong>Carrier:</strong> ${claim.insurance_company}</p>` : ""}
    <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px;font-weight:600">
      Do you authorize us to pay your contractor directly for work to commence?
    </p>
    <div style="text-align:center;margin:24px 0">
      <a href="${requestUrl}" style="display:inline-block;background:${buttonColor};color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600">
        Respond Now
      </a>
    </div>
    <p style="color:#888;font-size:13px;line-height:1.5;margin:16px 0 0">
      Your response helps us direct funds properly and avoid delays in claim handling.
    </p>
  </td></tr>
  <tr><td style="background:#f8f9fa;padding:16px 32px;text-align:center;border-top:1px solid #e5e5e5">
    <p style="color:#999;font-size:12px;margin:0">&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

    const results: { email?: boolean; sms?: boolean } = {};

    // Send email via Resend
    if (claim.policyholder_email && RESEND_API_KEY) {
      try {
        const fromDomain = branding?.email_from_domain || "notifications@freedomclaims.com";
        const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
        const resendResponse = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${LOVABLE_API_KEY}`,
            "X-Connection-Api-Key": RESEND_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: `${companyName} <${fromDomain}>`,
            to: [claim.policyholder_email],
            subject: emailSubject,
            html: emailHtml,
          }),
        });

        if (resendResponse.ok) {
          results.email = true;
          console.log("[payment-direction] Email sent successfully");
        } else {
          const err = await resendResponse.text();
          console.error("[payment-direction] Email send failed:", err);
        }
      } catch (emailErr) {
        console.error("[payment-direction] Email error:", emailErr);
      }
    }

    // Send SMS via Telnyx
    if (claim.policyholder_phone && TELNYX_API_KEY && TELNYX_PHONE_NUMBER) {
      try {
        const digits = claim.policyholder_phone.replace(/\D/g, '');
        const normalizedPhone = digits.length === 10 ? `+1${digits}` :
          digits.length === 11 && digits.startsWith('1') ? `+${digits}` :
          claim.policyholder_phone.startsWith('+') ? claim.policyholder_phone : `+${digits}`;

        const smsBody = `${companyName}: Payment direction needed for your insurance check (Claim ${claim.claim_number || ""}). Please respond here: ${requestUrl}`;

        const telnyxResponse = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TELNYX_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: TELNYX_PHONE_NUMBER,
            to: normalizedPhone,
            text: smsBody,
            messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
          }),
        });

        if (telnyxResponse.ok) {
          results.sms = true;
          console.log("[payment-direction] SMS sent successfully");
        } else {
          const err = await telnyxResponse.text();
          console.error("[payment-direction] SMS send failed:", err);
        }
      } catch (smsErr) {
        console.error("[payment-direction] SMS error:", smsErr);
      }
    }

    // Log the notification in claim events
    await serviceSupabase.from("claim_events").insert([{
      claim_id: claimId,
      event_type: "payment_direction_notification_sent",
      occurred_at: new Date().toISOString(),
      date_source: "system",
      summary: `Payment direction request sent${results.email ? " via email" : ""}${results.sms ? " via SMS" : ""}`,
      metadata_json: { check_id: checkId, email: !!results.email, sms: !!results.sms },
    }]);

    return new Response(
      JSON.stringify({ success: true, results }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error in send-payment-direction-request:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
