import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Composite endorsement signatures onto the back of a check image.
 * Triggered automatically when all endorsements are complete.
 *
 * Input: { checkId: string }
 *
 * Flow:
 * 1. Load check + endorsements
 * 2. Download the back check image
 * 3. Draw endorsement signatures onto the image using Canvas
 * 4. Upload the composited image back to storage
 * 5. Update check_intake_items.back_image_path
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
      .download(check.back_image_path);

    if (dlErr || !imgBlob) throw new Error(`Cannot download back image: ${dlErr?.message}`);

    const originalBytes = new Uint8Array(await imgBlob.arrayBuffer());

    // 4. Build the composite SVG overlay
    const overlaySvg = buildEndorsementOverlaySvg(endorsements, check.check_number, check.carrier_name);

    // 5. Use the SVG-on-image compositing approach:
    //    Create a new SVG that embeds the original image + endorsement overlay
    const originalBase64 = uint8ToBase64(originalBytes);
    const mimeType = check.back_image_path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    // Determine image dimensions (use reasonable defaults for check images)
    const imgWidth = 1200;
    const imgHeight = 800;
    const overlayHeight = 300;
    const totalHeight = imgHeight + overlayHeight;

    const compositeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" 
     width="${imgWidth}" height="${totalHeight}" viewBox="0 0 ${imgWidth} ${totalHeight}">
  <!-- Original back check image -->
  <image href="data:${mimeType};base64,${originalBase64}" 
         x="0" y="0" width="${imgWidth}" height="${imgHeight}" 
         preserveAspectRatio="xMidYMid meet"/>
  
  <!-- Endorsement overlay area -->
  <rect x="0" y="${imgHeight}" width="${imgWidth}" height="${overlayHeight}" fill="#ffffff"/>
  <line x1="20" y1="${imgHeight + 10}" x2="${imgWidth - 20}" y2="${imgHeight + 10}" stroke="#334155" stroke-width="2"/>
  <text x="${imgWidth / 2}" y="${imgHeight + 35}" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#1e293b">ENDORSEMENTS</text>
  
  ${overlaySvg}
</svg>`;

    // 6. Upload composited image
    const compositePath = check.back_image_path.replace(
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
      event_description: `Darwin composited ${endorsements.length} endorsement signature(s) onto back of check`,
      event_data: {
        original_back_path: check.back_image_path,
        composited_back_path: compositePath,
        endorsement_count: endorsements.length,
        endorsement_ids: endorsements.map((e: { id: string }) => e.id),
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

function buildEndorsementOverlaySvg(
  endorsements: EndorsementRecord[],
  checkNumber: string | null,
  carrierName: string | null
): string {
  const baseY = 800; // matches imgHeight
  let blocks = "";

  endorsements.forEach((e, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = col === 0 ? 40 : 620;
    const y = baseY + 50 + row * 120;

    // Signature rendering
    let sigElement: string;
    if (e.signature_image_url && e.signature_image_url.startsWith("data:image/")) {
      sigElement = `<image href="${escHtml(e.signature_image_url)}" x="${x}" y="${y + 20}" width="240" height="50" preserveAspectRatio="xMidYMid meet"/>`;
    } else if (e.signature_image_url && e.signature_image_url.startsWith("typed:")) {
      const typedName = e.signature_image_url.slice(6);
      sigElement = `<text x="${x}" y="${y + 55}" font-family="'Brush Script MT', cursive, serif" font-size="24" fill="#1e293b">${escHtml(typedName)}</text>`;
    } else if (e.status === "waived") {
      sigElement = `<text x="${x}" y="${y + 50}" font-family="Arial, sans-serif" font-size="11" fill="#94a3b8" font-style="italic">Waived</text>`;
    } else {
      sigElement = "";
    }

    const signedDate = e.signed_at ? new Date(e.signed_at).toLocaleDateString("en-US") : "";

    blocks += `
      <text x="${x}" y="${y + 12}" font-family="Arial, sans-serif" font-size="11" fill="#64748b">${escHtml(e.payee_name)} (${escHtml(e.payee_type?.replace(/_/g, " "))})</text>
      ${sigElement}
      <line x1="${x}" y1="${y + 75}" x2="${x + 240}" y2="${y + 75}" stroke="#94a3b8" stroke-width="0.5"/>
      <text x="${x + 250}" y="${y + 55}" font-family="Arial, sans-serif" font-size="10" fill="#94a3b8">${escHtml(signedDate)}</text>
    `;
  });

  return blocks;
}
