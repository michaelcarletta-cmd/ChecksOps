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

    // Endorsement zone: LEFT strip of check back, rotated 90° CCW
    // This matches standard bank endorsement placement (vertical strip on left)
    const ezStripWidth = Math.round(imgWidth * 0.28); // left 28% of check
    const ezStripHeight = imgHeight;
    
    // All endorsement content is rendered inside a rotated group
    // Rotation: 90° CCW around the center of the strip
    const stripCenterX = ezStripWidth / 2;
    const stripCenterY = ezStripHeight / 2;

    // Inside the rotated group, we layout top-to-bottom (which becomes left-to-right on check)
    // After rotation, the "width" available = ezStripHeight, "height" available = ezStripWidth
    const contentWidth = ezStripHeight - 40; // padding
    let curY = 20; // start position inside rotated space
    let endorsementSvg = "";

    // --- Restrictive endorsement legend ---
    const centerX = contentWidth / 2 + 20;
    endorsementSvg += `<text x="${centerX}" y="${curY + 16}" font-family="Arial, sans-serif" font-size="14" fill="#1e293b" font-weight="bold" text-anchor="middle">Pay to the order of</text>`;
    curY += 24;
    endorsementSvg += `<text x="${centerX}" y="${curY + 18}" font-family="Arial, sans-serif" font-size="18" fill="#1e293b" font-weight="bold" text-anchor="middle">Freedom Adjustment</text>`;
    curY += 28;
    endorsementSvg += `<text x="${centerX}" y="${curY + 14}" font-family="Arial, sans-serif" font-size="14" fill="#1e293b" font-weight="bold" text-anchor="middle">For Mobile Deposit Only</text>`;
    curY += 24;
    endorsementSvg += `<text x="${centerX}" y="${curY + 18}" font-family="Arial, sans-serif" font-size="18" fill="#1e293b" font-weight="bold" text-anchor="middle">Freedom Adjustment</text>`;
    curY += 30;

    // --- Separator ---
    endorsementSvg += `<line x1="20" y1="${curY}" x2="${contentWidth + 20}" y2="${curY}" stroke="#94a3b8" stroke-width="1"/>`;
    curY += 14;

    // --- Render endorsement signatures ---
    const insured = endorsements.filter((e: EndorsementRecord) =>
      e.payee_type !== "company" && e.payee_type !== "public_adjuster"
    );
    const company = endorsements.filter((e: EndorsementRecord) =>
      e.payee_type === "company" || e.payee_type === "public_adjuster"
    );
    const ordered = [...insured, ...company];

    for (const e of ordered) {
      // Signature
      if (e.signature_image_url && e.signature_image_url.startsWith("data:image/")) {
        const sigWidth = Math.min(contentWidth - 40, 300);
        endorsementSvg += `<image href="${escHtml(e.signature_image_url)}" x="20" y="${curY}" width="${sigWidth}" height="44" preserveAspectRatio="xMinYMid meet"/>`;
        curY += 48;
      } else if (e.signature_image_url && e.signature_image_url.startsWith("typed:")) {
        const typedName = e.signature_image_url.slice(6);
        endorsementSvg += `<text x="${centerX}" y="${curY + 20}" font-family="'Brush Script MT', cursive, serif" font-size="24" fill="#1e293b" text-anchor="middle">${escHtml(typedName)}</text>`;
        curY += 28;
      } else if (e.status === "waived") {
        endorsementSvg += `<text x="${centerX}" y="${curY + 12}" font-family="Arial, sans-serif" font-size="10" fill="#94a3b8" font-style="italic" text-anchor="middle">${escHtml(e.payee_name)} — Waived</text>`;
        curY += 16;
      } else {
        // Pending or no signature yet — show name placeholder
        endorsementSvg += `<text x="${centerX}" y="${curY + 16}" font-family="Arial, sans-serif" font-size="14" fill="#1e293b" text-anchor="middle">${escHtml(e.payee_name)}</text>`;
        curY += 20;
        endorsementSvg += `<text x="${centerX}" y="${curY + 10}" font-family="Arial, sans-serif" font-size="10" fill="#64748b" font-style="italic" text-anchor="middle">signature</text>`;
        curY += 16;
      }

      curY += 8;
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
