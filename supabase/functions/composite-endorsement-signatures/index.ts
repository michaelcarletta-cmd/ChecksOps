import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Composite endorsement signatures onto the back of a check image.
 * Endorsements are rendered DIRECTLY ON the check image in the
 * upper-left endorsement zone, following the natural orientation
 * of the uploaded image. Output is a single flattened SVG ready
 * for mobile deposit — no watermark, no background boxes.
 *
 * Input: { checkId: string }
 */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { checkId } = await req.json();
    if (!checkId) throw new Error("checkId is required");

    console.log(`[COMPOSITE] Starting for check ${checkId}`);

    // 1. Get check details
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("id, back_image_path, front_image_path, check_number, carrier_name, amount")
      .eq("id", checkId)
      .single();

    if (checkErr || !check) throw new Error(`Check not found: ${checkErr?.message}`);
    if (!check.back_image_path) throw new Error("No back image to composite onto");

    // Support re-compositing: if back_image_path is already an _endorsed.svg,
    // look up the original path from the audit log
    let backImagePath = check.back_image_path;
    if (backImagePath.includes("_endorsed")) {
      const { data: auditEntry } = await supabase
        .from("check_audit_log")
        .select("event_data")
        .eq("check_id", checkId)
        .eq("event_type", "endorsement_signatures_composited")
        .order("created_at", { ascending: true })
        .limit(1)
        .single();
      
      const originalPath = (auditEntry?.event_data as any)?.original_back_path;
      if (originalPath) {
        console.log(`[COMPOSITE] Re-compositing: using original path ${originalPath}`);
        backImagePath = originalPath;
        await supabase.from("check_intake_items")
          .update({ back_image_path: originalPath })
          .eq("id", checkId);
      } else {
        console.log("[COMPOSITE] WARNING: Could not find original back image path in audit log, using current path");
      }
    }

    // 2. Get signed endorsements
    const { data: endorsements, error: endErr } = await supabase
      .from("check_endorsements")
      .select("id, payee_name, payee_type, status, signed_at, signature_image_url, signature_method")
      .eq("check_id", checkId)
      .in("status", ["signed", "waived"])
      .order("created_at", { ascending: true });

    if (endErr) throw new Error(`Failed to load endorsements: ${endErr.message}`);
    if (!endorsements?.length) {
      console.log("[COMPOSITE] No signed endorsements to composite");
      return jsonResp({ success: true, skipped: true, reason: "no_endorsements" });
    }

    // 3. Download the original back image
    const { data: imgBlob, error: dlErr } = await supabase.storage
      .from("claim-files")
      .download(backImagePath);

    if (dlErr || !imgBlob) throw new Error(`Cannot download back image: ${dlErr?.message}`);

    const originalBytes = new Uint8Array(await imgBlob.arrayBuffer());

    // 4. Detect actual image dimensions from the binary data
    const dims = detectImageDimensions(originalBytes);
    const imgWidth = dims.width;
    const imgHeight = dims.height;
    console.log(`[COMPOSITE] Detected image dimensions: ${imgWidth}x${imgHeight}`);

    // 5. Build endorsement overlay INSIDE the check image bounds
    const originalBase64 = uint8ToBase64(originalBytes);
    const mimeType = backImagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    // Endorsement zone: upper-left area of the check back
    // Positioned well within the image bounds so it appears ON the check
    const ezLeftPad = Math.round(imgWidth * 0.03);
    const ezTopPad = Math.round(imgHeight * 0.05);
    const ezContentWidth = Math.round(imgWidth * 0.35);

    // Scale font sizes relative to image dimensions
    const scaleFactor = Math.min(imgWidth / 1200, imgHeight / 800);
    const baseFontLg = Math.round(18 * scaleFactor);
    const baseFontMd = Math.round(14 * scaleFactor);
    const baseFontSm = Math.round(10 * scaleFactor);
    const sigHeight = Math.round(44 * scaleFactor);

    let curY = ezTopPad;
    let endorsementSvg = "";

    const centerX = ezLeftPad + ezContentWidth / 2;

    // --- Restrictive endorsement legend ---
    endorsementSvg += `<text x="${centerX}" y="${curY + baseFontMd}" font-family="Arial, sans-serif" font-size="${baseFontMd}" fill="#1e293b" font-weight="bold" text-anchor="middle">Pay to the order of</text>`;
    curY += Math.round(baseFontMd * 1.7);
    endorsementSvg += `<text x="${centerX}" y="${curY + baseFontLg}" font-family="Arial, sans-serif" font-size="${baseFontLg}" fill="#1e293b" font-weight="bold" text-anchor="middle">Freedom Adjustment</text>`;
    curY += Math.round(baseFontLg * 1.5);
    endorsementSvg += `<text x="${centerX}" y="${curY + baseFontMd}" font-family="Arial, sans-serif" font-size="${baseFontMd}" fill="#1e293b" font-weight="bold" text-anchor="middle">For Mobile Deposit Only</text>`;
    curY += Math.round(baseFontMd * 1.7);
    endorsementSvg += `<text x="${centerX}" y="${curY + baseFontLg}" font-family="Arial, sans-serif" font-size="${baseFontLg}" fill="#1e293b" font-weight="bold" text-anchor="middle">Freedom Adjustment</text>`;
    curY += Math.round(baseFontLg * 1.7);

    // --- Separator ---
    endorsementSvg += `<line x1="${ezLeftPad}" y1="${curY}" x2="${ezLeftPad + ezContentWidth}" y2="${curY}" stroke="#94a3b8" stroke-width="1"/>`;
    curY += Math.round(14 * scaleFactor);

    // --- Render endorsement signatures ---
    const insured = endorsements.filter((e: EndorsementRecord) =>
      e.payee_type !== "company" && e.payee_type !== "public_adjuster"
    );
    const company = endorsements.filter((e: EndorsementRecord) =>
      e.payee_type === "company" || e.payee_type === "public_adjuster"
    );
    const ordered = [...insured, ...company];

    for (const e of ordered) {
      if (e.signature_image_url && e.signature_image_url.startsWith("data:image/")) {
        const sigWidth = Math.min(ezContentWidth - 20, Math.round(300 * scaleFactor));
        endorsementSvg += `<image href="${escHtml(e.signature_image_url)}" x="${ezLeftPad}" y="${curY}" width="${sigWidth}" height="${sigHeight}" preserveAspectRatio="xMinYMid meet"/>`;
        curY += sigHeight + Math.round(4 * scaleFactor);
      } else if (e.signature_image_url && e.signature_image_url.startsWith("typed:")) {
        const typedName = e.signature_image_url.slice(6);
        const typedSize = Math.round(24 * scaleFactor);
        endorsementSvg += `<text x="${centerX}" y="${curY + typedSize}" font-family="'Brush Script MT', cursive, serif" font-size="${typedSize}" fill="#1e293b" text-anchor="middle">${escHtml(typedName)}</text>`;
        curY += Math.round(typedSize * 1.2);
      } else if (e.status === "waived") {
        endorsementSvg += `<text x="${centerX}" y="${curY + baseFontSm}" font-family="Arial, sans-serif" font-size="${baseFontSm}" fill="#94a3b8" font-style="italic" text-anchor="middle">${escHtml(e.payee_name)} — Waived</text>`;
        curY += Math.round(baseFontSm * 1.6);
      } else {
        endorsementSvg += `<text x="${centerX}" y="${curY + baseFontMd}" font-family="Arial, sans-serif" font-size="${baseFontMd}" fill="#1e293b" text-anchor="middle">${escHtml(e.payee_name)}</text>`;
        curY += Math.round(baseFontMd * 1.4);
        endorsementSvg += `<text x="${centerX}" y="${curY + baseFontSm}" font-family="Arial, sans-serif" font-size="${baseFontSm}" fill="#64748b" font-style="italic" text-anchor="middle">signature</text>`;
        curY += Math.round(baseFontSm * 1.6);
      }

      curY += Math.round(8 * scaleFactor);
    }

    // 6. Build final SVG — image fills entire canvas with preserveAspectRatio="none"
    //    so endorsements are guaranteed to be ON the check image, not beside it
    const compositeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" 
     width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}">
  <!-- Original back check image — stretched to fill entire SVG canvas -->
  <image href="data:${mimeType};base64,${originalBase64}" 
         x="0" y="0" width="${imgWidth}" height="${imgHeight}" 
         preserveAspectRatio="none"/>
  
  <!-- Endorsement overlay: rendered directly ON the check image, upper-left zone -->
  ${endorsementSvg}
</svg>`;

    // 7. Upload composited image
    const compositePath = backImagePath.replace(
      /(\.[^.]+)$/,
      "_endorsed.svg"
    );

    const { error: uploadErr } = await supabase.storage
      .from("claim-files")
      .upload(compositePath, new Blob([compositeSvg], { type: "image/svg+xml" }), {
        contentType: "image/svg+xml",
        upsert: true,
      });

    if (uploadErr) throw new Error(`Failed to upload composite: ${uploadErr.message}`);

    // 8. Update check with new back image path
    const { error: updateErr } = await supabase
      .from("check_intake_items")
      .update({
        back_image_path: compositePath,
        updated_at: new Date().toISOString(),
      })
      .eq("id", checkId);

    if (updateErr) throw new Error(`Failed to update check: ${updateErr.message}`);

    // 9. Audit log
    await supabase.from("check_audit_log").insert({
      check_id: checkId,
      event_type: "endorsement_signatures_composited",
      event_description: `Composited ${endorsements.length} endorsement signature(s) onto upper-left endorsement zone of check back (${imgWidth}x${imgHeight})`,
      event_data: {
        original_back_path: check.back_image_path,
        composited_back_path: compositePath,
        endorsement_count: endorsements.length,
        endorsement_ids: endorsements.map((e: { id: string }) => e.id),
        placement: "upper_left_on_image",
        image_dimensions: { width: imgWidth, height: imgHeight },
      },
    });

    console.log(`[COMPOSITE] Done — saved to ${compositePath} (${imgWidth}x${imgHeight})`);

    return jsonResp({
      success: true,
      composited_path: compositePath,
      endorsement_count: endorsements.length,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[COMPOSITE] ERROR: ${msg}`);
    return jsonResp({ success: false, error: msg }, 400);
  }
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function jsonResp(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escHtml(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Detect image dimensions from binary data by reading file headers.
 * Supports JPEG, PNG. Falls back to 1200x800 if detection fails.
 */
function detectImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const fallback = { width: 1200, height: 800 };

  try {
    // PNG: bytes 16-23 contain width (4 bytes) and height (4 bytes) in IHDR
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (width > 0 && height > 0 && width < 20000 && height < 20000) {
        return { width, height };
      }
    }

    // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let offset = 2;
      while (offset < bytes.length - 8) {
        if (bytes[offset] !== 0xFF) { offset++; continue; }
        const marker = bytes[offset + 1];
        // SOF0, SOF1, SOF2, SOF3
        if (marker >= 0xC0 && marker <= 0xC3) {
          const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
          const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
          if (width > 0 && height > 0 && width < 20000 && height < 20000) {
            return { width, height };
          }
        }
        const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 2 + segLen;
      }
    }
  } catch {
    // fall through to default
  }

  console.log("[COMPOSITE] Could not detect image dimensions, using fallback 1200x800");
  return fallback;
}

interface EndorsementRecord {
  id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signed_at: string | null;
  signature_image_url: string | null;
  signature_method: string | null;
}
