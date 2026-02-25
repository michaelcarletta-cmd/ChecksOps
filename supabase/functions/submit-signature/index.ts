import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { token, fieldValues } = await req.json();

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Missing token" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Look up signer by access token to validate the request
    const { data: signer, error: signerError } = await supabaseClient
      .from("signature_signers")
      .select("*, signature_requests(*)")
      .eq("access_token", token)
      .maybeSingle();

    if (signerError) {
      console.error("Error fetching signer:", signerError);
      throw signerError;
    }

    if (!signer || !signer.signature_requests) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired signing token" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (signer.status === "signed") {
      return new Response(
        JSON.stringify({ error: "Document already signed", alreadySigned: true }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const request = signer.signature_requests;

    // Update the signer record with signature data
    const { error: updateError } = await supabaseClient
      .from("signature_signers")
      .update({
        status: "signed",
        signed_at: new Date().toISOString(),
        field_values: fieldValues,
      })
      .eq("id", signer.id);

    if (updateError) {
      console.error("Error updating signer:", updateError);
      throw updateError;
    }

    // Check if all signers have signed
    const { data: allSigners, error: allSignersError } = await supabaseClient
      .from("signature_signers")
      .select("status")
      .eq("signature_request_id", request.id);

    if (allSignersError) {
      console.error("Error fetching all signers:", allSignersError);
      throw allSignersError;
    }

    const allSigned = allSigners?.every((s) => s.status === "signed");

    // Update signature request status
    if (allSigned) {
      await supabaseClient
        .from("signature_requests")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", request.id);
    } else {
      await supabaseClient
        .from("signature_requests")
        .update({ status: "in_progress" })
        .eq("id", request.id);
    }

    console.log(`Signature submitted successfully for signer ${signer.id}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        allSigned,
        message: "Document signed successfully" 
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in submit-signature function:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
