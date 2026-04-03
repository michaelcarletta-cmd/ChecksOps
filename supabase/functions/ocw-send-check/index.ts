import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[OCW] ${step}${d}`);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const API_KEY = Deno.env.get("OCW_API_KEY");
    if (!API_KEY) {
      throw new Error("Online Check Writer API key not configured");
    }

    // Production URL
    const BASE = "https://app.onlinecheckwriter.com/api/v3";

    const body = await req.json();
    const {
      action,
      recipientName,
      recipientEmail,
      amount,
      description,
      recipientAddress,
      claimId,
      recipientType,
      bankAccountId,
    } = body;

    log("Action requested", { action, recipientName, amount });

    if (!amount || Number(amount) <= 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Amount must be greater than 0" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!recipientName) {
      return new Response(
        JSON.stringify({ success: false, error: "Recipient name is required" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve bank account ID — passed from client or fall back to env
    const accountId = bankAccountId || Deno.env.get("OCW_BANK_ACCOUNT_ID");
    if (!accountId) {
      return new Response(
        JSON.stringify({ success: false, error: "No bank account configured. Set it in Settings → Company Branding." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "send-digital" || action === "send-physical") {
      // Build destination
      const destination: Record<string, string> = {
        name: recipientName,
      };

      if (recipientEmail) destination.email = recipientEmail;

      if (action === "send-physical" && recipientAddress) {
        if (!recipientAddress.line_1 || !recipientAddress.city || !recipientAddress.state || !recipientAddress.zip) {
          return new Response(
            JSON.stringify({ success: false, error: "Full mailing address is required for physical checks" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        destination.address1 = recipientAddress.line_1;
        destination.address2 = recipientAddress.line_2 || "";
        destination.city = recipientAddress.city;
        destination.state = recipientAddress.state;
        destination.zip = recipientAddress.zip;
      }

      const checkPayload = {
        source: {
          accountType: "bankaccount",
          accountId: accountId,
        },
        destination,
        payment_details: {
          amount: Number(amount),
          memo: description || `Payment to ${recipientName}`,
          note: claimId ? `Claim: ${claimId}` : "",
          issueDate: new Date().toISOString().split("T")[0],
        },
      };

      log("Sending check via QuickPay", { action });

      const checkResponse = await fetch(`${BASE}/quickpay/check`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(checkPayload),
      });

      if (!checkResponse.ok) {
        const errText = await checkResponse.text();
        log("OCW API error", { status: checkResponse.status, body: errText });
        throw new Error(`Online Check Writer API error (${checkResponse.status}): ${errText}`);
      }

      const checkResult = await checkResponse.json();
      log("Check created successfully", checkResult);

      const checkId = checkResult?.data?.checkId || checkResult?.checkId || "OCW-" + Date.now();

      // Track in database
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, supabaseKey);

      // 1. Add to outstanding_checks
      const { error: outstandingErr } = await sb.from("outstanding_checks").insert({
        check_number: String(checkId),
        payee: recipientName,
        amount: Number(amount),
      });
      if (outstandingErr) {
        log("Warning: failed to add outstanding check", outstandingErr);
      }

      // 2. Add to claim_payments if linked to a claim
      if (claimId) {
        const { error: paymentErr } = await sb.from("claim_payments").insert({
          claim_id: claimId,
          payment_date: new Date().toISOString().split("T")[0],
          amount: Number(amount),
          payment_method: "check",
          check_number: String(checkId),
          recipient_type: recipientType || "contractor",
          notes: `Sent via Online Check Writer (${action === "send-digital" ? "Digital" : "Physical"})`,
          direction: "released",
        });
        if (paymentErr) {
          log("Warning: failed to add claim payment", paymentErr);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          checkId,
          checkNumber: checkId,
          data: checkResult,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else if (action === "request-payment") {
      // Payment request / invoice — use OCW receive-payment or email check endpoint
      if (!recipientEmail) {
        return new Response(
          JSON.stringify({ success: false, error: "Recipient email is required for payment requests" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // OCW Email Check endpoint for sending payment requests
      const emailPayload = {
        source: {
          accountType: "bankaccount",
          accountId: accountId,
        },
        destination: {
          name: recipientName,
          email: recipientEmail,
        },
        payment_details: {
          amount: Number(amount),
          memo: description || `Payment request for ${recipientName}`,
        },
      };

      const response = await fetch(`${BASE}/quickpay/check`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(emailPayload),
      });

      if (!response.ok) {
        const errText = await response.text();
        log("OCW payment request error", { status: response.status, body: errText });
        throw new Error(`Online Check Writer API error (${response.status}): ${errText}`);
      }

      const result = await response.json();
      log("Payment request created", result);

      return new Response(
        JSON.stringify({
          success: true,
          checkId: result?.data?.checkId || null,
          data: result,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid action. Use send-digital, send-physical, or request-payment" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    log("ERROR", { message: msg });
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
