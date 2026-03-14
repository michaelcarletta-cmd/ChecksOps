import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function log(sb: any, entry: Record<string, unknown>) {
  try {
    await sb.from("esign_event_logs").insert(entry);
  } catch (err) {
    console.error("esign log write failed:", err);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { token } = await req.json();

    if (!token || typeof token !== "string" || token.length < 10) {
      return respond({ ok: false, stage: "validate_token", error: "Missing or invalid token" }, 400);
    }

    // Look up signer by access token
    const { data: signer, error: signerError } = await sb
      .from("signature_signers")
      .select("*, signature_requests(*, claims(id, claim_number, policyholder_name))")
      .eq("access_token", token)
      .maybeSingle();

    if (signerError) {
      console.error("Error fetching signer:", signerError);
      return respond({ ok: false, stage: "fetch_signer", error: signerError.message }, 500);
    }

    if (!signer || !signer.signature_requests) {
      return respond({ ok: false, stage: "fetch_signer", error: "Signature request not found or link has expired" }, 404);
    }

    const request = signer.signature_requests;
    const claimId = request.claim_id;

    // Mark as viewed (first time only)
    if (!signer.viewed_at) {
      await sb
        .from("signature_signers")
        .update({ viewed_at: new Date().toISOString() })
        .eq("id", signer.id);

      // Log viewed event
      await log(sb, {
        request_id: request.id,
        signer_id: signer.id,
        claim_id: claimId,
        stage: "signer_viewed",
        status: "ok",
        message: `${signer.signer_name} opened the document`,
        payload: { signer_email: signer.signer_email },
      });

      // Update request status if it was just "pending"
      if (request.status === "pending") {
        await sb
          .from("signature_requests")
          .update({ status: "in_progress" })
          .eq("id", request.id);
      }
    }

    // Generate signed URL — 4 hours to give signers plenty of time
    const documentPath = request.document_path;
    let signedUrl: string | null = null;

    if (documentPath) {
      const { data: urlData, error: urlError } = await sb.storage
        .from("claim-files")
        .createSignedUrl(documentPath, 14400); // 4 hours

      if (urlError) {
        console.error("Error creating signed URL:", urlError);
        return respond({ ok: false, stage: "document_url", error: "Could not generate document URL" }, 500);
      }
      signedUrl = urlData?.signedUrl || null;
    }

    if (!signedUrl) {
      return respond({ ok: false, stage: "document_url", error: "Document not found in storage" }, 404);
    }

    return respond({
      ok: true,
      signer: {
        id: signer.id,
        signer_name: signer.signer_name,
        signer_email: signer.signer_email,
        signer_type: signer.signer_type,
        signing_order: signer.signing_order,
        status: signer.status,
        signed_at: signer.signed_at,
        viewed_at: signer.viewed_at,
      },
      request: {
        id: request.id,
        document_name: request.document_name,
        document_path: request.document_path,
        field_data: request.field_data,
        status: request.status,
      },
      signedUrl,
    });
  } catch (error) {
    console.error("Error in get-signature-document:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return respond({ ok: false, stage: "function_error", error: message }, 500);
  }
});
