import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { claimId } = await req.json();

    if (!claimId) {
      return new Response(
        JSON.stringify({ error: "claimId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get claim details
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .select("*")
      .eq("id", claimId)
      .single();

    if (claimError || !claim) {
      return new Response(
        JSON.stringify({ error: "Claim not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!claim.contract_pdf_path) {
      return new Response(
        JSON.stringify({ error: "No contract PDF available. Generate the contract first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!claim.policyholder_email) {
      return new Response(
        JSON.stringify({ error: "Policyholder email is required for e-signature" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get company branding and webhook URL
    const { data: branding } = await supabase
      .from("company_branding")
      .select("*")
      .limit(1)
      .maybeSingle();

    if (!branding?.signnow_make_webhook_url) {
      return new Response(
        JSON.stringify({ error: "Make.com webhook URL not configured. Go to Settings > Company Branding." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate signed URL for the PDF (24 hours)
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(claim.contract_pdf_path, 86400);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      return new Response(
        JSON.stringify({ error: "Failed to generate PDF URL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update claim status to sending
    await supabase
      .from("claims")
      .update({ 
        esign_status: "sending",
        esign_provider: "signnow",
        updated_at: new Date().toISOString()
      })
      .eq("id", claimId);

    // Build the webhook payload
    const webhookPayload = {
      crm_contract_id: claimId,
      signer: {
        name: claim.policyholder_name || "Signer",
        email: claim.policyholder_email,
      },
      pdf_url: signedUrlData.signedUrl,
      callback_url: `${supabaseUrl}/functions/v1/esign-callback`,
      // Additional context
      claim_number: claim.claim_number,
      policy_number: claim.policy_number,
      // Signature field coordinates from settings
      signature_fields: {
        signature: {
          page: branding.esign_signature_page || 1,
          x: branding.esign_signature_x || 100,
          y: branding.esign_signature_y || 600,
          width: branding.esign_signature_width || 200,
          height: branding.esign_signature_height || 50,
          role: "signer",
        },
        date: {
          page: branding.esign_date_page || 1,
          x: branding.esign_date_x || 350,
          y: branding.esign_date_y || 600,
          width: branding.esign_date_width || 100,
          height: branding.esign_date_height || 25,
          role: "signer",
        },
      },
      email_subject: branding.esign_email_subject || "Please sign your document",
      email_body: branding.esign_email_body || "Please click the link to review and sign your document.",
    };

    console.log("Sending to Make webhook:", JSON.stringify(webhookPayload));

    // Send to Make webhook
    const webhookResponse = await fetch(branding.signnow_make_webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });

    if (!webhookResponse.ok) {
      const errorText = await webhookResponse.text();
      console.error("Make webhook error:", errorText);
      
      // Update status to error
      await supabase
        .from("claims")
        .update({ 
          esign_status: "error",
          esign_error_message: `Webhook failed: ${webhookResponse.status}`,
          updated_at: new Date().toISOString()
        })
        .eq("id", claimId);

      return new Response(
        JSON.stringify({ error: "Failed to send to Make webhook" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log the event
    await supabase.from("claim_updates").insert({
      claim_id: claimId,
      content: `📝 Contract sent for e-signature to ${claim.policyholder_email}`,
      update_type: "esign",
    });

    // Note: The actual status update to "sent" will come from the callback
    // when Make confirms the document was sent to SignNow

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Signature request sent",
        claim_id: claimId
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    console.error("Error in esign-send:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
