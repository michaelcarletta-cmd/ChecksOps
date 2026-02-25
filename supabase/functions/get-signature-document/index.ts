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
    const { token } = await req.json();

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

    // Look up signer and related request by access token
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
        JSON.stringify({ error: "Signature request not found or link has expired" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const request = signer.signature_requests;
    const documentPath = request.document_path;

    let signedUrl = null;
    if (documentPath) {
      const { data: urlData, error: urlError } = await supabaseClient.storage
        .from("claim-files")
        .createSignedUrl(documentPath, 3600);

      if (urlError) {
        console.error("Error creating signed URL:", urlError);
      } else {
        signedUrl = urlData?.signedUrl || null;
      }
    }

    // Return all data needed for the signing page
    return new Response(
      JSON.stringify({
        signer: {
          id: signer.id,
          signer_name: signer.signer_name,
          signer_email: signer.signer_email,
          signer_type: signer.signer_type,
          signing_order: signer.signing_order,
          status: signer.status,
          signed_at: signer.signed_at,
        },
        request: {
          id: request.id,
          document_name: request.document_name,
          document_path: request.document_path,
          field_data: request.field_data,
          status: request.status,
        },
        signedUrl,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in get-signature-document function:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
