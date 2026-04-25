import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { PDFDocument, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";

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

// ---------------------------------------------------------------------------
// Standalone signed certificate for non-PDF originals (e.g. DOCX)
// ---------------------------------------------------------------------------

async function generateSignedCertificatePdf(
  request: any,
  allSignersWithValues: any[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([612, 792]); // Letter size
  const { height } = page.getSize();
  let y = height - 60;

  // Title
  page.drawText("Certificate of Signature Completion", {
    x: 50, y, size: 18, font: helveticaBold, color: rgb(0.1, 0.1, 0.1),
  });
  y -= 30;

  // Document info
  page.drawText(`Document: ${request.document_name || "Untitled"}`, {
    x: 50, y, size: 11, font: helvetica, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 18;
  page.drawText(`Completed: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, {
    x: 50, y, size: 11, font: helvetica, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 30;

  // Separator line
  page.drawLine({
    start: { x: 50, y }, end: { x: 562, y },
    thickness: 1, color: rgb(0.7, 0.7, 0.7),
  });
  y -= 30;

  // Each signer
  for (const signer of allSignersWithValues) {
    page.drawText(signer.signer_name || "Unknown Signer", {
      x: 50, y, size: 13, font: helveticaBold, color: rgb(0.1, 0.1, 0.1),
    });
    y -= 18;

    const fieldValues = signer.field_values || {};
    for (const [, fieldEntry] of Object.entries(fieldValues)) {
      const field = fieldEntry as any;
      if (!field) continue;

      if (field.field_type === "signature" && field.value && typeof field.value === "string" && field.value.startsWith("data:")) {
        try {
          const base64Data = field.value.split(",")[1];
          if (!base64Data) continue;
          const imgBytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
          let embeddedImage;
          try { embeddedImage = await pdfDoc.embedPng(imgBytes); } catch { embeddedImage = await pdfDoc.embedJpg(imgBytes); }
          const aspectRatio = embeddedImage.width / embeddedImage.height;
          const drawH = Math.min(50, 200 / aspectRatio);
          const drawW = drawH * aspectRatio;
          page.drawImage(embeddedImage, { x: 60, y: y - drawH, width: drawW, height: drawH });
          y -= drawH + 10;
        } catch {
          page.drawText("[Signature on file]", { x: 60, y, size: 10, font: helvetica, color: rgb(0.4, 0.4, 0.4) });
          y -= 16;
        }
      } else if (field.value) {
        const label = field.field_label || field.field_type || "Field";
        page.drawText(`${label}: ${String(field.value)}`, {
          x: 60, y, size: 10, font: helvetica, color: rgb(0.3, 0.3, 0.3),
        });
        y -= 16;
      }
    }
    y -= 20;

    // Next page if running out of space
    if (y < 80) {
      const newPage = pdfDoc.addPage([612, 792]);
      y = 792 - 60;
    }
  }

  return await pdfDoc.save();
}

// ---------------------------------------------------------------------------
// PDF Flattening — embed signatures/fields onto original PDF
// ---------------------------------------------------------------------------

async function generateFlattenedPdf(
  sb: any,
  request: any,
  allSignersWithValues: any[],
): Promise<Uint8Array> {
  // Download the original document from storage
  const { data: fileData, error: downloadErr } = await sb.storage
    .from("claim-files")
    .download(request.document_path);

  if (downloadErr || !fileData) {
    throw new Error(`Failed to download original document: ${downloadErr?.message || "not found"}`);
  }

  const pdfBytes = await fileData.arrayBuffer();
  const headerBytes = new Uint8Array(pdfBytes.slice(0, 5));
  const headerStr = String.fromCharCode(...headerBytes);

  // If not a PDF, generate a standalone signed certificate
  if (headerStr !== "%PDF-") {
    return await generateSignedCertificatePdf(request, allSignersWithValues);
  }

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Process each signer's field values
  for (const signer of allSignersWithValues) {
    const fieldValues = signer.field_values || {};

    for (const [fieldId, fieldEntry] of Object.entries(fieldValues)) {
      const field = fieldEntry as any;
      if (!field) continue;

      const pageIndex = (field.page || 1) - 1;
      const pages = pdfDoc.getPages();
      if (pageIndex < 0 || pageIndex >= pages.length) continue;

      const page = pages[pageIndex];
      const pageHeight = page.getHeight();
      const pageWidth = page.getWidth();

      // field.x and field.y are percentages (0-100) from field placement editor
      const x = (field.x / 100) * pageWidth;
      const y = pageHeight - ((field.y / 100) * pageHeight) - ((field.height || 5) / 100) * pageHeight;
      const w = (field.width / 100) * pageWidth;
      const h = ((field.height || 5) / 100) * pageHeight;

      if (field.field_type === "signature" && field.value && typeof field.value === "string" && field.value.startsWith("data:")) {
        try {
          // Extract base64 from data URI
          const base64Data = field.value.split(",")[1];
          if (!base64Data) continue;

          const imgBytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

          let embeddedImage;
          if (field.value.includes("image/png")) {
            embeddedImage = await pdfDoc.embedPng(imgBytes);
          } else {
            // Try PNG first (canvas.toDataURL() defaults to PNG)
            try {
              embeddedImage = await pdfDoc.embedPng(imgBytes);
            } catch {
              embeddedImage = await pdfDoc.embedJpg(imgBytes);
            }
          }

          const aspectRatio = embeddedImage.width / embeddedImage.height;
          const drawH = Math.min(h, w / aspectRatio);
          const drawW = drawH * aspectRatio;

          page.drawImage(embeddedImage, {
            x,
            y: y + (h - drawH), // align to top of field area
            width: drawW,
            height: drawH,
          });
        } catch (imgErr) {
          console.error("Failed to embed signature image:", imgErr);
          // Draw placeholder text if image embedding fails
          page.drawText("[Signature on file]", {
            x,
            y: y + h / 2 - 5,
            size: 10,
            font: helvetica,
            color: rgb(0.3, 0.3, 0.3),
          });
        }
      } else if (field.field_type === "date" && field.value) {
        page.drawText(String(field.value), {
          x,
          y: y + h / 2 - 5,
          size: 11,
          font: helvetica,
          color: rgb(0, 0, 0),
        });
      } else if (field.field_type === "text" && field.value) {
        page.drawText(String(field.value), {
          x,
          y: y + h / 2 - 5,
          size: 11,
          font: helvetica,
          color: rgb(0, 0, 0),
        });
    } else if (field.field_type === "checkbox") {
        // Draw checkbox using vector primitives
        const boxSize = Math.min(h * 0.7, w * 0.7, 14);
        const boxX = x + 2;
        const boxY = y + (h - boxSize) / 2;

        // Draw box outline
        page.drawRectangle({
          x: boxX,
          y: boxY,
          width: boxSize,
          height: boxSize,
          borderColor: rgb(0.2, 0.2, 0.2),
          borderWidth: 1.2,
          color: rgb(1, 1, 1),
        });

        if (field.value) {
          // Draw checkmark using two lines (✓ shape)
          const margin = boxSize * 0.2;
          const lx = boxX + margin;
          const ly = boxY + margin;
          const rx = boxX + boxSize - margin;
          const ry = boxY + boxSize - margin;
          const midX = boxX + boxSize * 0.38;
          const midY = boxY + margin;

          page.drawLine({
            start: { x: lx, y: ly + (ry - ly) * 0.5 },
            end: { x: midX, y: midY },
            thickness: 1.8,
            color: rgb(0.1, 0.4, 0.1),
          });
          page.drawLine({
            start: { x: midX, y: midY },
            end: { x: rx, y: ry },
            thickness: 1.8,
            color: rgb(0.1, 0.4, 0.1),
          });
        }
      }
    }
  }

  return await pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { token, fieldValues, eSignConsentAccepted, consentText } = await req.json();

    if (!token || typeof token !== "string") {
      return respond({ ok: false, stage: "validate_token", error: "Missing token" }, 400);
    }

    if (eSignConsentAccepted !== true) {
      return respond({ ok: false, stage: "esign_consent", error: "Electronic signature consent is required" }, 400);
    }

    const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") || "unknown";
    const userAgent = req.headers.get("user-agent") || "unknown";

    // Hash token and look up by hash
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
      return respond({ ok: false, stage: "fetch_signer", error: "Invalid or expired signing token" }, 404);
    }

    // Check expiry
    if (signer.expires_at && new Date(signer.expires_at) < new Date()) {
      return respond({ ok: false, stage: "token_expired", error: "This signing link has expired. Please request a new one." }, 403);
    }

    // Prevent double-submit
    if (signer.status === "signed") {
      return respond({ ok: false, stage: "already_signed", error: "Document already signed", alreadySigned: true }, 400);
    }

    const request = signer.signature_requests;
    const claimId = request.claim_id;

    // Enforce signer ordering
    if (signer.signing_order > 1) {
      const { data: priorSigners } = await sb
        .from("signature_signers")
        .select("id, status, signing_order")
        .eq("signature_request_id", request.id)
        .lt("signing_order", signer.signing_order)
        .neq("status", "signed");

      if (priorSigners && priorSigners.length > 0) {
        return respond({ ok: false, stage: "signer_order_blocked", error: "A prior signer must complete before you can sign." }, 403);
      }
    }

    // Validate required fields (use normalized fields if available, fall back to field_data)
    const { data: normalizedFields } = await sb
      .from("signature_fields")
      .select("*")
      .eq("signature_request_id", request.id)
      .eq("signer_index", signer.signing_order - 1);

    const signerFields = normalizedFields && normalizedFields.length > 0
      ? normalizedFields.map((f: any) => ({
          id: f.id,
          type: f.field_type,
          label: f.label,
          required: f.required,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        }))
      : (request.field_data || []).filter(
          (f: any) => f.signerIndex === signer.signing_order - 1
        );

    const validationErrors: string[] = [];
    for (const field of signerFields) {
      const value = fieldValues?.[field.id];
      const isRequired = field.required !== false;

      if (isRequired) {
        if (field.type === "signature") {
          if (!value || typeof value !== "string" || !value.startsWith("data:")) {
            validationErrors.push(`Signature field "${field.label || "Signature"}" is required`);
          }
        } else if (field.type === "checkbox") {
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
        request_id: request.id, signer_id: signer.id, claim_id: claimId,
        stage: "field_validation_failed", status: "error",
        message: validationErrors.join("; "),
        payload: { validationErrors },
      });
      return respond({
        ok: false, stage: "field_validation",
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

    // Save to normalized signature_field_values table
    if (normalizedFields && normalizedFields.length > 0) {
      const valueRows = normalizedFields.map((f: any) => ({
        field_id: f.id,
        signer_id: signer.id,
        value: fieldValues?.[f.id] != null ? String(fieldValues[f.id]) : null,
        checked: f.field_type === "checkbox" ? (!!fieldValues?.[f.id]) : false,
      }));
      await sb.from("signature_field_values").insert(valueRows);
    }

    // Update the signer record — conditional update to prevent race condition
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
      .neq("status", "signed")
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error("Error updating signer:", updateError);
      return respond({ ok: false, stage: "save_signature", error: updateError.message }, 500);
    }

    if (!updated) {
      return respond({ ok: false, stage: "already_signed", error: "Document already signed", alreadySigned: true }, 400);
    }

    await log(sb, {
      request_id: request.id, signer_id: signer.id, claim_id: claimId,
      stage: "signer_signed", status: "ok",
      message: `${signer.signer_name} signed the document`,
      payload: {
        ip_address: ipAddress,
        user_agent: userAgent,
        e_sign_consent_accepted: true,
        consent_text: typeof consentText === "string" ? consentText : "Electronic records and signature consent accepted before signing.",
        fields_completed: Object.keys(normalizedValues).length,
      },
    });

    // Check if all signers have signed
    const { data: allSigners, error: allSignersError } = await sb
      .from("signature_signers")
      .select("id, status, field_values, signing_order, signer_name")
      .eq("signature_request_id", request.id);

    if (allSignersError) {
      console.error("Error fetching all signers:", allSignersError);
      return respond({ ok: false, stage: "check_completion", error: allSignersError.message }, 500);
    }

    const allSigned = allSigners?.every((s) => s.status === "signed") ?? false;

    if (allSigned) {
      // ── COMPLETION FLOW ──
      const completedAt = new Date().toISOString();

      await sb.from("signature_requests").update({
        status: "completed",
        completed_at: completedAt,
        last_error: null,
        completion_status: "pending",
      }).eq("id", request.id);

      await log(sb, {
        request_id: request.id, signer_id: null, claim_id: claimId,
        stage: "request_completed", status: "ok",
        message: `All ${allSigners!.length} signers completed — "${request.document_name}"`,
        payload: { signer_count: allSigners!.length },
      });

      // Attempt PDF flattening
      try {
        if (!claimId) {
          throw new Error("Cannot generate final PDF: claim_id is missing on the signature request");
        }

        const flattenedBytes = await generateFlattenedPdf(sb, request, allSigners!);

        // Upload to storage
        const blob = new Blob([flattenedBytes], { type: "application/pdf" });

        const { error: uploadError } = await sb.storage
          .from("claim-files")
          .upload(`signed/${claimId}/${request.id}-final.pdf`, blob, {
            contentType: "application/pdf",
            upsert: true,
          });

        if (uploadError) {
          throw new Error(`Upload failed: ${uploadError.message}`);
        }

        const storagePath = `signed/${claimId}/${request.id}-final.pdf`;

        await sb.from("signature_requests").update({
          final_pdf_path: storagePath,
          completion_status: "completed",
        }).eq("id", request.id);

        // Attach to claim files
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
            file_path: storagePath,
            file_type: "application/pdf",
          });
        }

        // Claim timeline
        await sb.from("claim_updates").insert({
          claim_id: claimId,
          content: `✅ All signatures completed for "${request.document_name}" — signed PDF generated`,
          update_type: "esign",
        });

        await log(sb, {
          request_id: request.id, signer_id: null, claim_id: claimId,
          stage: "pdf_flattened", status: "ok",
          message: "Final signed PDF generated and uploaded",
          payload: { final_pdf_path: storagePath },
        });
      } catch (completionErr) {
        const errMsg = completionErr instanceof Error ? completionErr.message : "Unknown error";
        console.error("PDF flattening error:", errMsg);

        await sb.from("signature_requests").update({
          completion_status: "failed",
          last_error: `PDF generation failed: ${errMsg}`,
        }).eq("id", request.id);

        await log(sb, {
          request_id: request.id, signer_id: null, claim_id: claimId,
          stage: "completion_failed", status: "error",
          message: `PDF flattening failed: ${errMsg}`,
          payload: null,
        });

        // Still log timeline entry — signatures are captured
        await sb.from("claim_updates").insert({
          claim_id: claimId,
          content: `⚠️ Signatures completed for "${request.document_name}" but PDF generation failed — retry available`,
          update_type: "esign",
        });
      }
    } else {
      await sb.from("signature_requests").update({ status: "in_progress" }).eq("id", request.id);
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
