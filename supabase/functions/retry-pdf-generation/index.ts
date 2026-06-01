import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
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

// ---------------------------------------------------------------------------
// Standalone signed certificate for non-PDF originals
// ---------------------------------------------------------------------------
async function generateSignedCertificatePdf(
  request: any,
  allSigners: any[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let page = pdfDoc.addPage([612, 792]);
  let y = 792 - 60;

  page.drawText("Certificate of Signature Completion", {
    x: 50, y, size: 18, font: helveticaBold, color: rgb(0.1, 0.1, 0.1),
  });
  y -= 30;
  page.drawText(`Document: ${request.document_name || "Untitled"}`, {
    x: 50, y, size: 11, font: helvetica, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 18;
  page.drawText(`Completed: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, {
    x: 50, y, size: 11, font: helvetica, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 30;
  page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: rgb(0.7, 0.7, 0.7) });
  y -= 30;

  for (const signer of allSigners) {
    page.drawText(signer.signer_name || "Unknown Signer", {
      x: 50, y, size: 13, font: helveticaBold, color: rgb(0.1, 0.1, 0.1),
    });
    y -= 18;
    if (signer.signed_at) {
      page.drawText(`Signed: ${new Date(signer.signed_at).toLocaleString("en-US")}`, {
        x: 60, y, size: 10, font: helvetica, color: rgb(0.3, 0.3, 0.3),
      });
      y -= 16;
    }

    const fieldValues = signer.field_values || {};
    for (const [, fieldEntry] of Object.entries(fieldValues)) {
      const field = fieldEntry as any;
      if (!field) continue;
      if (field.field_type === "signature" && field.value?.startsWith("data:")) {
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
        page.drawText(`${label}: ${String(field.value)}`, { x: 60, y, size: 10, font: helvetica, color: rgb(0.3, 0.3, 0.3) });
        y -= 16;
      }
    }
    y -= 20;
    if (y < 80) { page = pdfDoc.addPage([612, 792]); y = 792 - 60; }
  }
  return await pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Flatten signatures onto original PDF
// ---------------------------------------------------------------------------
async function generateFlattenedPdf(
  sb: any,
  request: any,
  allSigners: any[],
): Promise<Uint8Array> {
  const { data: fileData, error: downloadErr } = await sb.storage
    .from("claim-files")
    .download(request.document_path);

  if (downloadErr || !fileData) {
    throw new Error(`Failed to download document: ${downloadErr?.message || "not found"}`);
  }

  const pdfBytes = await fileData.arrayBuffer();
  const headerBytes = new Uint8Array(pdfBytes.slice(0, 5));
  const headerStr = String.fromCharCode(...headerBytes);

  if (headerStr !== "%PDF-") {
    return await generateSignedCertificatePdf(request, allSigners);
  }

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const signer of allSigners) {
    const fieldValues = signer.field_values || {};
    for (const [, fieldEntry] of Object.entries(fieldValues)) {
      const field = fieldEntry as any;
      if (!field) continue;
      const pageIndex = (field.page || 1) - 1;
      const pages = pdfDoc.getPages();
      if (pageIndex < 0 || pageIndex >= pages.length) continue;
      const page = pages[pageIndex];
      const pageHeight = page.getHeight();
      const pageWidth = page.getWidth();
      const x = (field.x / 100) * pageWidth;
      const y = pageHeight - ((field.y / 100) * pageHeight) - ((field.height || 5) / 100) * pageHeight;
      const w = (field.width / 100) * pageWidth;
      const h = ((field.height || 5) / 100) * pageHeight;

      if (field.field_type === "signature" && field.value?.startsWith("data:")) {
        try {
          const base64Data = field.value.split(",")[1];
          if (!base64Data) continue;
          const imgBytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
          let embeddedImage;
          if (field.value.includes("image/png")) {
            embeddedImage = await pdfDoc.embedPng(imgBytes);
          } else {
            try { embeddedImage = await pdfDoc.embedPng(imgBytes); } catch { embeddedImage = await pdfDoc.embedJpg(imgBytes); }
          }
          const aspectRatio = embeddedImage.width / embeddedImage.height;
          const drawH = Math.min(h, w / aspectRatio);
          const drawW = drawH * aspectRatio;
          page.drawImage(embeddedImage, { x, y: y + (h - drawH), width: drawW, height: drawH });
        } catch {
          page.drawText("[Signature on file]", { x, y: y + h / 2 - 5, size: 10, font: helvetica, color: rgb(0.3, 0.3, 0.3) });
        }
      } else if ((field.field_type === "date" || field.field_type === "text") && field.value) {
        page.drawText(String(field.value), { x, y: y + h / 2 - 5, size: 11, font: helvetica, color: rgb(0, 0, 0) });
      } else if (field.field_type === "checkbox") {
        const boxSize = Math.min(h * 0.7, w * 0.7, 14);
        const boxX = x + 2;
        const boxY = y + (h - boxSize) / 2;
        page.drawRectangle({ x: boxX, y: boxY, width: boxSize, height: boxSize, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1.2, color: rgb(1, 1, 1) });
        if (field.value) {
          const margin = boxSize * 0.2;
          const lx = boxX + margin; const ly = boxY + margin;
          const rx = boxX + boxSize - margin; const ry = boxY + boxSize - margin;
          const midX = boxX + boxSize * 0.38; const midY = boxY + margin;
          page.drawLine({ start: { x: lx, y: ly + (ry - ly) * 0.5 }, end: { x: midX, y: midY }, thickness: 1.8, color: rgb(0.1, 0.4, 0.1) });
          page.drawLine({ start: { x: midX, y: midY }, end: { x: rx, y: ry }, thickness: 1.8, color: rgb(0.1, 0.4, 0.1) });
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
    const { requestId } = await req.json();
    if (!requestId) return respond({ ok: false, error: "Missing requestId" }, 400);

    const { data: request, error: reqErr } = await sb
      .from("signature_requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (reqErr || !request) return respond({ ok: false, error: "Request not found" }, 404);
    if (request.status !== "completed") return respond({ ok: false, error: "Request is not completed" }, 400);

    const { data: allSigners, error: signersErr } = await sb
      .from("signature_signers")
      .select("id, status, field_values, signing_order, signer_name, signed_at")
      .eq("signature_request_id", requestId);

    if (signersErr) return respond({ ok: false, error: signersErr.message }, 500);

    await sb.from("signature_requests").update({ completion_status: "pending", last_error: null }).eq("id", requestId);

    const claimId = request.claim_id;
    const checkIntakeItemId = request.check_intake_item_id;
    if (!claimId && !checkIntakeItemId) {
      throw new Error("Signature request is not linked to a claim or check");
    }

    const flattenedBytes = await generateFlattenedPdf(sb, request, allSigners || []);
    const blob = new Blob([flattenedBytes], { type: "application/pdf" });

    const storagePath = claimId
      ? `signed/${claimId}/${requestId}-final.pdf`
      : `check-intake/${checkIntakeItemId}/files/${requestId}-final.pdf`;

    const { error: uploadError } = await sb.storage
      .from("claim-files")
      .upload(storagePath, blob, { contentType: "application/pdf", upsert: true });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    await sb.from("signature_requests").update({
      final_pdf_path: storagePath,
      completion_status: "completed",
      last_error: null,
    }).eq("id", requestId);

    const signedFileName = `SIGNED - ${request.document_name}`;

    if (claimId) {
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
    } else if (checkIntakeItemId) {
      const { data: existingCheckFile } = await sb
        .from("check_files")
        .select("id")
        .eq("signature_request_id", requestId)
        .maybeSingle();

      if (!existingCheckFile) {
        await sb.from("check_files").insert({
          check_intake_item_id: checkIntakeItemId,
          file_name: `${signedFileName}.pdf`,
          file_path: storagePath,
          file_type: "application/pdf",
          file_size: flattenedBytes.byteLength,
          category: "signed_dtp",
          source: "system",
          signature_request_id: requestId,
        });
      }
    }

    return respond({ ok: true, final_pdf_path: storagePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Retry PDF generation error:", message);
    return respond({ ok: false, error: message }, 500);
  }
});
