import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Composite endorsement signatures onto the back of a check image.
 * Endorsements are placed in the standard bank endorsement zone:
 * a horizontal strip across the TOP of the back of the check.
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
        // Reset the back_image_path to original before re-compositing
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

    // 4. Build the endorsement overlay in the CORRECT bank zone
    const originalBase64 = uint8ToBase64(originalBytes);
    const mimeType = backImagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    // Standard check image dimensions (landscape orientation)
    const imgWidth = 1200;
    const imgHeight = 800;

    // Bank endorsement zone: centered on the physical check body (not page margins)
    // Most mobile photos have the check centered with table/background around it.
    // This zone anchors endorsements over the check itself.
    const ezTopMargin = Math.round(imgHeight * 0.08);
    const ezLeftMargin = Math.round(imgWidth * 0.24);
    const ezContentWidth = Math.round(imgWidth * 0.52);

    let curY = ezTopMargin;
    let endorsementSvg = "";

    // --- Semi-transparent white background only over endorsement zone ---
    const ezHeight = Math.min(Math.round(imgHeight * 0.34), 280);
    endorsementSvg += `<rect x="${ezLeftMargin - 20}" y="${ezTopMargin - 12}" width="${ezContentWidth + 40}" height="${ezHeight}" fill="white" fill-opacity="0.9" rx="8"/>`;

    // --- Restrictive endorsement legend (centered in endorsement zone) ---
    const centerX = ezLeftMargin + ezContentWidth / 2;
    endorsementSvg += `<text x="${centerX}" y="${curY + 14}" font-family="Arial, sans-serif" font-size="12" fill="#1e293b" font-weight="bold" text-anchor="middle">Pay to the Order of</text>`;
    curY += 20;
    endorsementSvg += `<text x="${centerX}" y="${curY + 14}" font-family="Arial, sans-serif" font-size="15" fill="#1e293b" font-weight="bold" text-anchor="middle">Freedom Adjustment LLC</text>`;
    curY += 22;
    endorsementSvg += `<text x="${centerX}" y="${curY + 12}" font-family="Arial, sans-serif" font-size="12" fill="#1e293b" font-weight="bold" text-anchor="middle">For Mobile Deposit Only</text>`;
    curY += 20;
    endorsementSvg += `<text x="${centerX}" y="${curY + 14}" font-family="Arial, sans-serif" font-size="15" fill="#1e293b" font-weight="bold" text-anchor="middle">Freedom Adjustment LLC</text>`;
    curY += 22;

    // --- Separator ---
    endorsementSvg += `<line x1="${ezLeftMargin}" y1="${curY}" x2="${ezLeftMargin + ezContentWidth}" y2="${curY}" stroke="#94a3b8" stroke-width="1"/>`;
    curY += 10;

    // --- Render endorsement signatures horizontally across the zone ---
    // Sort: insured/client first, then company/PA last
    const insured = endorsements.filter((e: EndorsementRecord) =>
      e.payee_type !== "company" && e.payee_type !== "public_adjuster"
    );
    const company = endorsements.filter((e: EndorsementRecord) =>
      e.payee_type === "company" || e.payee_type === "public_adjuster"
    );
    const ordered = [...insured, ...company];

    // If few endorsements, stack vertically centered
    // If many, use a compact 2-column layout
    const useColumns = ordered.length > 3;
    const colWidth = useColumns ? (ezContentWidth / 2) - 10 : ezContentWidth;

    let col = 0;
    let colStartY = curY;

    for (const e of ordered) {
      const xOffset = useColumns ? ezLeftMargin + col * (colWidth + 20) : ezLeftMargin;

      // Label
      const label = e.payee_name + (e.payee_type ? ` (${e.payee_type.replace(/_/g, " ")})` : "");
      endorsementSvg += `<text x="${xOffset}" y="${curY + 10}" font-family="Arial, sans-serif" font-size="9" fill="#64748b">${escHtml(label)}</text>`;
      curY += 14;

      // Signature
      if (e.signature_image_url && e.signature_image_url.startsWith("data:image/")) {
        const sigWidth = Math.min(colWidth - 20, 280);
        endorsementSvg += `<image href="${escHtml(e.signature_image_url)}" x="${xOffset}" y="${curY}" width="${sigWidth}" height="36" preserveAspectRatio="xMinYMid meet"/>`;
        curY += 40;
      } else if (e.signature_image_url && e.signature_image_url.startsWith("typed:")) {
        const typedName = e.signature_image_url.slice(6);
        endorsementSvg += `<text x="${xOffset}" y="${curY + 16}" font-family="'Brush Script MT', cursive, serif" font-size="20" fill="#1e293b">${escHtml(typedName)}</text>`;
        curY += 24;
      } else if (e.status === "waived") {
        endorsementSvg += `<text x="${xOffset}" y="${curY + 10}" font-family="Arial, sans-serif" font-size="9" fill="#94a3b8" font-style="italic">Waived</text>`;
        curY += 14;
      } else {
        curY += 4;
      }

      // Date
      if (e.signed_at) {
        const d = new Date(e.signed_at).toLocaleDateString("en-US");
        endorsementSvg += `<text x="${xOffset}" y="${curY + 8}" font-family="Arial, sans-serif" font-size="8" fill="#94a3b8">${escHtml(d)}</text>`;
        curY += 12;
      }

      curY += 4;

      // Column logic
      if (useColumns) {
        col++;
        if (col >= 2) {
          col = 0;
          colStartY = curY;
        } else {
          curY = colStartY;
        }
      }
    }

    const compositeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" 
     width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}">
  <!-- Original back check image -->
  <image href="data:${mimeType};base64,${originalBase64}" 
         x="0" y="0" width="${imgWidth}" height="${imgHeight}" 
         preserveAspectRatio="xMidYMid meet"/>
  
  <!-- Bank endorsement zone: top horizontal strip -->
  ${endorsementSvg}
</svg>`;

    // 6. Upload composited image
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

    // 7. Update check with new back image path
    const { error: updateErr } = await supabase
      .from("check_intake_items")
      .update({
        back_image_path: compositePath,
        updated_at: new Date().toISOString(),
      })
      .eq("id", checkId);

    if (updateErr) throw new Error(`Failed to update check: ${updateErr.message}`);

    // 8. Audit log
    await supabase.from("check_audit_log").insert({
      check_id: checkId,
      event_type: "endorsement_signatures_composited",
      event_description: `Composited ${endorsements.length} endorsement signature(s) onto top endorsement zone of check back`,
      event_data: {
        original_back_path: check.back_image_path,
        composited_back_path: compositePath,
        endorsement_count: endorsements.length,
        endorsement_ids: endorsements.map((e: { id: string }) => e.id),
        placement: "top_horizontal_strip",
      },
    });

    console.log(`[COMPOSITE] Done — saved to ${compositePath}`);

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

interface EndorsementRecord {
  id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signed_at: string | null;
  signature_image_url: string | null;
  signature_method: string | null;
}
