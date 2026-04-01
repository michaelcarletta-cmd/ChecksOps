import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CHECKBOOK] ${step}${d}`);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const API_KEY = Deno.env.get("CHECKBOOK_API_KEY");
    const API_SECRET = Deno.env.get("CHECKBOOK_API_SECRET");
    if (!API_KEY || !API_SECRET) {
      throw new Error("Checkbook.io API credentials not configured");
    }

    const authHeader = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);
    // Toggle between sandbox and production
    const USE_SANDBOX = Deno.env.get("CHECKBOOK_SANDBOX") !== "false"; // defaults to sandbox
    const BASE = USE_SANDBOX
      ? "https://sandbox.checkbook.io/v3"
      : "https://api.checkbook.io/v3";

    const body = await req.json();
    const {
      action,
      recipientName,
      recipientEmail,
      amount,
      description,
      // For physical checks
      recipientAddress,
      // For tracking
      claimId,
      recipientType,
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

    let checkResponse;

    if (action === "send-digital") {
      // Send a digital check via email
      if (!recipientEmail) {
        return new Response(
          JSON.stringify({ success: false, error: "Recipient email is required for digital checks" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      checkResponse = await fetch(`${BASE}/check/digital`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          recipient: recipientEmail,
          name: recipientName,
          amount: Number(amount).toFixed(2),
          description: description || `Payment to ${recipientName}`,
        }),
      });
    } else if (action === "send-physical") {
      // Send a physical (mailed) check
      if (!recipientAddress?.line_1 || !recipientAddress?.city || !recipientAddress?.state || !recipientAddress?.zip) {
        return new Response(
          JSON.stringify({ success: false, error: "Full mailing address is required for physical checks" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      checkResponse = await fetch(`${BASE}/check/physical`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          recipient: recipientName,
          name: recipientName,
          amount: Number(amount).toFixed(2),
          description: description || `Payment to ${recipientName}`,
          address: {
            line_1: recipientAddress.line_1,
            line_2: recipientAddress.line_2 || "",
            city: recipientAddress.city,
            state: recipientAddress.state,
            zip: recipientAddress.zip,
          },
        }),
      });
    } else if (action === "request-payment") {
      // Request payment (invoice) — sends recipient an email to pay you
      if (!recipientEmail) {
        return new Response(
          JSON.stringify({ success: false, error: "Recipient email is required for payment requests" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      checkResponse = await fetch(`${BASE}/invoice`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          recipient: recipientEmail,
          name: recipientName,
          amount: Number(amount).toFixed(2),
          description: description || `Payment request for ${recipientName}`,
        }),
      });
    } else {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid action. Use send-digital, send-physical, or request-payment" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!checkResponse.ok) {
      const errText = await checkResponse.text();
      log("Checkbook API error", { status: checkResponse.status, body: errText });
      throw new Error(`Checkbook API error (${checkResponse.status}): ${errText}`);
    }

    const checkResult = await checkResponse.json();
    log("Check sent successfully", { id: checkResult.id, number: checkResult.number });

    // Only track outgoing checks (not payment requests/invoices)
    if (action !== "request-payment") {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, supabaseKey);

      const checkNumber = checkResult.number || checkResult.id || "CB-" + Date.now();

      // 1. Add to outstanding_checks (sales tracker)
      const { error: outstandingErr } = await sb.from("outstanding_checks").insert({
        check_number: String(checkNumber),
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
          check_number: String(checkNumber),
          recipient_type: recipientType || "contractor",
          notes: `Sent via Checkbook.io (${action === "send-digital" ? "Digital" : "Physical"})`,
          direction: "released",
        });
        if (paymentErr) {
          log("Warning: failed to add claim payment", paymentErr);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        checkId: checkResult.id,
        checkNumber: checkResult.number || checkResult.id || null,
        status: checkResult.status,
        data: checkResult,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    log("ERROR", { message: msg });
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
