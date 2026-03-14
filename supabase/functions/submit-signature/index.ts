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
    const { token, fieldValues } = await req.json();

    if (!token || typeof token !== "string") {
      return respond({ ok: false, stage: "validate_token", error: "Missing token" }, 400);
    }

    // Capture IP and user agent for audit
    const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") || "unknown";
    const userAgent = req.headers.get("user-agent") || "unknown";

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
      return respond({ ok: false, stage: "fetch_signer", error: "Invalid or expired signing token" }, 404);
    }

    // Prevent double-submit race condition
    if (signer.status === "signed") {
      return respond({ ok: false, stage: "already_signed", error: "Document already signed", alreadySigned: true }, 400);
    }

    const request = signer.signature_requests;
    const claimId = request.claim_id;

    // Validate required fields
    const signerFields = (request.field_data || []).filter(
      (f: any) => f.signerIndex === signer.signing_order - 1
    );

    const validationErrors: string[] = [];
    for (const field of signerFields) {
      const value = fieldValues?.[field.id];
      const isRequired = field.required !== false; // default to required

      if (isRequired) {
        if (field.type === "signature") {
          if (!value || typeof value !== "string" || !value.startsWith("data:")) {
            validationErrors.push(`Signature field "${field.label || "Signature"}" is required`);
          }
        } else if (field.type === "checkbox") {
          // Checkbox: value should be truthy
          if (!value) {
            validationErrors.push(`Checkbox "${field.label || "Checkbox"}" must be checked`);
          }
        } else if (field.type === "date" || field.type === "text") {
          if (!value || (typeof value === "string" && value.trim() === "")) {
            validationErrors.push(`"${field.label || field.type}" is required`);
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      await log(sb, {
        request_id: request.id,
        signer_id: signer.id,
        claim_id: claimId,
        stage: "field_validation_failed",
        status: "error",
        message: validationErrors.join("; "),
        payload: { validationErrors, fieldValues: Object.keys(fieldValues || {}) },
      });
      return respond({
        ok: false,
        stage: "field_validation",
        error: validationErrors.join("; "),
        validationErrors,
      }, 400);
    }

    // Normalize field values for storage
    const normalizedValues: Record<string, any> = {};
    for (const field of signerFields) {
      const value = fieldValues?.[field.id];
      normalizedValues[field.id] = {
        field_type: field.type,
        field_label: field.label,
        value: value ?? null,
        page: field.page,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
      };
    }

    // Update the signer record — use conditional update to prevent race condition
    const { data: updated, error: updateError } = await sb
      .from("signature_signers")
      .update({
        status: "signed",
        signed_at: new Date().toISOString(),
        field_values: normalizedValues,
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .eq("id", signer.id)
      .neq("status", "signed") // race condition guard
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error("Error updating signer:", updateError);
      return respond({ ok: false, stage: "save_signature", error: updateError.message }, 500);
    }

    if (!updated) {
      // Another request beat us — already signed
      return respond({ ok: false, stage: "already_signed", error: "Document already signed", alreadySigned: true }, 400);
    }

    // Log the sign event
    await log(sb, {
      request_id: request.id,
      signer_id: signer.id,
      claim_id: claimId,
      stage: "signer_signed",
      status: "ok",
      message: `${signer.signer_name} signed the document`,
      payload: {
        ip_address: ipAddress,
        fields_completed: Object.keys(normalizedValues).length,
      },
    });

    // Check if all signers have signed
    const { data: allSigners, error: allSignersError } = await sb
      .from("signature_signers")
      .select("id, status")
      .eq("signature_request_id", request.id);

    if (allSignersError) {
      console.error("Error fetching all signers:", allSignersError);
      return respond({ ok: false, stage: "check_completion", error: allSignersError.message }, 500);
    }

    const allSigned = allSigners?.every((s) => s.status === "signed") ?? false;

    if (allSigned) {
      // ── COMPLETION FLOW ──
      const completedAt = new Date().toISOString();

      // Update request to completed
      await sb
        .from("signature_requests")
        .update({
          status: "completed",
          completed_at: completedAt,
          last_error: null,
        })
        .eq("id", request.id);

      // Log completion
      await log(sb, {
        request_id: request.id,
        signer_id: null,
        claim_id: claimId,
        stage: "request_completed",
        status: "ok",
        message: `All ${allSigners!.length} signers completed — "${request.document_name}"`,
        payload: { signer_count: allSigners!.length },
      });

      // Attempt to create a record in claim_files for the signed document
      // (the original document path serves as the signed copy since field values are stored in DB)
      try {
        // Upload a metadata marker — the actual PDF flattening with embedded signatures
        // would require a PDF library. For now we attach the original + field_values as the signed record.
        const finalPdfPath = request.document_path;

        await sb.from("signature_requests").update({
          final_pdf_path: finalPdfPath,
        }).eq("id", request.id);

        // Attach signed document to claim files if not already there
        const signedFileName = `SIGNED - ${request.document_name}`;
        const { data: existingFile } = await sb
          .from("claim_files")
          .select("id")
          .eq("claim_id", claimId)
          .eq("file_name", signedFileName)
          .maybeSingle();

        if (!existingFile) {
          await sb.from("claim_files").insert({
            claim_id: claimId,
            file_name: signedFileName,
            file_path: finalPdfPath,
            file_type: "application/pdf",
          });
        }

        // Log to claim timeline
        await sb.from("claim_updates").insert({
          claim_id: claimId,
          content: `✅ All signatures completed for "${request.document_name}"`,
          update_type: "esign",
        });

      } catch (completionErr) {
        const errMsg = completionErr instanceof Error ? completionErr.message : "Unknown error";
        console.error("Completion post-processing error:", errMsg);

        await log(sb, {
          request_id: request.id,
          signer_id: null,
          claim_id: claimId,
          stage: "completion_failed",
          status: "error",
          message: `Post-processing failed: ${errMsg}`,
          payload: null,
        });

        // Don't fail the response — the signature was captured successfully
        // The completion artifacts can be retried
      }
    } else {
      // Update request to in_progress
      await sb
        .from("signature_requests")
        .update({ status: "in_progress" })
        .eq("id", request.id);
    }

    return respond({
      ok: true,
      stage: "submit_complete",
      allSigned,
      message: allSigned ? "All signatures completed" : "Signature recorded successfully",
      signerCount: allSigners?.length ?? 0,
      signedCount: allSigners?.filter((s) => s.status === "signed").length ?? 0,
    });
  } catch (error) {
    console.error("Error in submit-signature:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return respond({ ok: false, stage: "function_error", error: message }, 500);
  }
});
