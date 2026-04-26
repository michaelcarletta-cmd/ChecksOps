import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

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

async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
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

    // Hash the incoming token and look up by hash
    const tokenHash = await hashToken(token);

    const { data: signer, error: signerError } = await sb
      .from("signature_signers")
      .select("*, signature_requests!inner(*, claims!signature_requests_claim_id_fkey(id, claim_number, policyholder_name))")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (signerError) {
      console.error("Error fetching signer:", signerError);
      return respond({ ok: false, stage: "fetch_signer", error: signerError.message }, 500);
    }

    if (!signer || !signer.signature_requests) {
      return respond({ ok: false, stage: "fetch_signer", error: "Signature request not found or link has expired" }, 404);
    }

    // Check token expiry
    if (signer.expires_at) {
      const expiresAt = new Date(signer.expires_at);
      if (expiresAt < new Date()) {
        await log(sb, {
          request_id: signer.signature_requests.id,
          signer_id: signer.id,
          claim_id: signer.signature_requests.claim_id,
          stage: "token_expired",
          status: "error",
          message: `Token expired at ${signer.expires_at}`,
          payload: null,
        });
        return respond({ ok: false, stage: "token_expired", error: "This signing link has expired. Please request a new one." }, 403);
      }
    }

    const request = signer.signature_requests;
    const claimId = request.claim_id;

    // Enforce signer ordering — block if a prior signer hasn't completed
    if (signer.signing_order > 1) {
      const { data: priorSigners } = await sb
        .from("signature_signers")
        .select("id, status, signing_order, signer_name")
        .eq("signature_request_id", request.id)
        .lt("signing_order", signer.signing_order)
        .neq("status", "signed");

      if (priorSigners && priorSigners.length > 0) {
        const waitingFor = priorSigners.map((s: any) => s.signer_name).join(", ");
        return respond({
          ok: false,
          stage: "signer_order_blocked",
          error: `Please wait — ${waitingFor} must sign before you.`,
          waitingFor: priorSigners.map((s: any) => ({ name: s.signer_name, order: s.signing_order })),
        }, 403);
      }
    }

    // Mark as viewed (first time only)
    if (!signer.viewed_at) {
      await sb
        .from("signature_signers")
        .update({ viewed_at: new Date().toISOString() })
        .eq("id", signer.id);

      await log(sb, {
        request_id: request.id,
        signer_id: signer.id,
        claim_id: claimId,
        stage: "signer_viewed",
        status: "ok",
        message: `${signer.signer_name} opened the document`,
        payload: { signer_email: signer.signer_email },
      });

      if (request.status === "pending") {
        await sb
          .from("signature_requests")
          .update({ status: "in_progress" })
          .eq("id", request.id);
      }
    }

    // Generate signed URL — 4 hours
    const documentPath = request.document_path;
    let signedUrl: string | null = null;

    if (documentPath) {
      const { data: urlData, error: urlError } = await sb.storage
        .from("claim-files")
        .createSignedUrl(documentPath, 14400);

      if (urlError) {
        console.error("Error creating signed URL:", urlError);
        return respond({ ok: false, stage: "document_url", error: "Could not generate document URL" }, 500);
      }
      signedUrl = urlData?.signedUrl || null;
    }

    if (!signedUrl) {
      return respond({ ok: false, stage: "document_url", error: "Document not found in storage" }, 404);
    }

    // Load normalized fields for this signer
    const { data: fields } = await sb
      .from("signature_fields")
      .select("*")
      .eq("signature_request_id", request.id)
      .eq("signer_index", signer.signing_order - 1);

    // Load document presets so the signing page can show custom labels
    const { data: presets } = await sb
      .from("signature_document_presets")
      .select("document_type, fields")
      .order("label");

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
        document_type: request.document_type || null,
        field_data: request.field_data, // backwards compat
        status: request.status,
      },
      fields: fields || [], // normalized fields
      presets: presets || [], // document presets for display labels
      signedUrl,
    });
  } catch (error) {
    console.error("Error in get-signature-document:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return respond({ ok: false, stage: "function_error", error: message }, 500);
  }
});
