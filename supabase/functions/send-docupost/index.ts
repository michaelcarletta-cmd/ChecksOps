import { createClient } from "npm:@supabase/supabase-js";
import { corsHeaders } from "npm:@supabase/supabase-js/cors";

const DOCUPOST_API_URL = "https://app.docupost.com/api/1.1/wf/sendletter";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const DOCUPOST_API_KEY = Deno.env.get("DOCUPOST_API_KEY");
    if (!DOCUPOST_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Docupost integration not configured. Please add DOCUPOST_API_KEY." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Auth check
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      claim_id,
      claim_number,
      document_type,
      to_name,
      to_address1,
      to_address2,
      to_city,
      to_state,
      to_zip,
      from_name,
      from_address1,
      from_address2,
      from_city,
      from_state,
      from_zip,
      pdf_url,
      mail_service,
    } = body;

    // Validate required fields
    if (!to_name || !to_address1 || !to_city || !to_state || !to_zip) {
      return new Response(
        JSON.stringify({ error: "Missing required recipient address fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!pdf_url) {
      return new Response(
        JSON.stringify({ error: "PDF URL is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build query params for Docupost
    const params = new URLSearchParams({
      api_token: DOCUPOST_API_KEY,
      to_name,
      to_address1,
      to_city,
      to_state,
      to_zip,
      pdf: pdf_url,
    });

    if (to_address2) params.set("to_address2", to_address2);
    if (from_name) params.set("from_name", from_name);
    if (from_address1) params.set("from_address1", from_address1);
    if (from_address2) params.set("from_address2", from_address2);
    if (from_city) params.set("from_city", from_city);
    if (from_state) params.set("from_state", from_state);
    if (from_zip) params.set("from_zip", from_zip);
    if (mail_service) params.set("mail_service", mail_service);

    console.log(`Sending Docupost letter for claim ${claim_number || claim_id}`);

    const response = await fetch(`${DOCUPOST_API_URL}?${params.toString()}`, {
      method: "POST",
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Docupost API error:", JSON.stringify(result));
      return new Response(
        JSON.stringify({ error: `Docupost API error: ${result?.message || response.statusText}` }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log to claim activity
    if (claim_id) {
      await supabase.from("claim_activity").insert({
        claim_id,
        user_id: user.id,
        activity_type: "docupost_send",
        description: `Sent ${document_type || "document"} via Docupost to ${to_name} at ${to_address1}, ${to_city}, ${to_state} ${to_zip}`,
        metadata: {
          document_type,
          recipient: to_name,
          address: `${to_address1}, ${to_city}, ${to_state} ${to_zip}`,
          docupost_response: result,
        },
      });
    }

    return new Response(
      JSON.stringify({ success: true, data: result }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("send-docupost error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
