import { createClient } from "npm:@supabase/supabase-js@2.39.3";
let render: ((svg: string) => Promise<Uint8Array>) | null = null;
try {
  const resvg = await import("https://deno.land/x/resvg_wasm@0.2.0/mod.ts");
  render = resvg.render;
} catch (e) {
  console.warn("[COMPOSITE] resvg_wasm not available, will use SVG fallback:", e);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Composite endorsement signatures onto the back of a check image.
 * Produces a single FLATTENED PNG at the original check resolution.
 * Endorsements are rendered directly ON the check image in the
 * upper-left endorsement zone. A hard safety check prevents any
 * endorsement content from overlapping the bank's restricted bottom zone.
 *
 * Input: { checkId: string }
 */

// Bank restricted zone: endorsements must stay above 75% of image height.
// Below that is the "DO NOT WRITE BELOW THIS LINE" area.
const BOTTOM_ZONE_LIMIT = 0.75;

// Endorsement placement (anchored to image/check bounds)
const ENDORSEMENT_TOP_PCT = 0.10;
const ENDORSEMENT_LEFT_PCT = 0.18;
const ENDORSEMENT_WIDTH_PCT = 0.55;

// Rasterizing very large images can exceed edge runtime memory.
// For oversized checks we save a composited SVG fallback directly.
const MAX_RASTER_PIXELS = 8_000_000;

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

    // Resolve a clean source image path without mutating DB source fields.
    // If current path is already an endorsed artifact, recover the true original
    // from the earliest composite audit entry.
    let backImagePath = check.back_image_path;
    if (backImagePath.includes("_endorsed")) {
      const { data: firstCompositeAudit } = await supabase
        .from("check_audit_log")
        .select("event_data")
        .eq("check_id", checkId)
        .eq("event_type", "endorsement_signatures_composited")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const auditData = (firstCompositeAudit?.event_data ?? null) as {
        original_back_image_path?: string;
        original_back_path?: string;
      } | null;

      const recoveredOriginalPath =
        auditData?.original_back_image_path ??
        auditData?.original_back_path ??
        null;

      if (recoveredOriginalPath) {
        console.log(`[COMPOSITE] Re-compositing from recovered original source path: ${recoveredOriginalPath}`);
        backImagePath = recoveredOriginalPath;
      } else {
        throw new Error("Current back image path points to an endorsed artifact and no original source path could be recovered");
      }
    }

    console.log(`[COMPOSITE] original image path: ${backImagePath}`);

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

    // Compute the maximum Y the endorsement block can reach
    const maxEndorsementY = Math.floor(imgHeight * BOTTOM_ZONE_LIMIT);
    const pixelCount = imgWidth * imgHeight;
    console.log(`[COMPOSITE] width/height: ${imgWidth}x${imgHeight}`);
    console.log(`[COMPOSITE] pixel count: ${pixelCount}`);

    // 5. Build endorsement overlay INSIDE the check image bounds
    const originalBase64 = uint8ToBase64(originalBytes);
    const mimeType = backImagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    // Endorsement zone anchored to the check body (not page/container)
    // Matches UI overlay coordinates for consistent final deposit output.
    const ezLeftPad = Math.round(imgWidth * ENDORSEMENT_LEFT_PCT);
    const ezTopPad = Math.round(imgHeight * ENDORSEMENT_TOP_PCT);
    const ezContentWidth = Math.round(imgWidth * ENDORSEMENT_WIDTH_PCT);

    // Scale font sizes relative to actual check image width for consistent
    // rendering across any resolution (2000px scans, 4000px phone photos, etc.)
    const headerFont = Math.max(14, Math.round(imgWidth * 0.018));
    const companyFont = Math.max(18, Math.round(imgWidth * 0.025));
    const bodyFont = headerFont;
    const sigNameFont = Math.max(18, Math.round(imgWidth * 0.028));
    const sigHeight = Math.max(40, Math.round(imgWidth * 0.06));

    let curY = ezTopPad;
    let endorsementSvg = "";

    const centerX = ezLeftPad + ezContentWidth / 2;

    // --- Restrictive endorsement legend ---
    // "Pay to the order of" — base header
    endorsementSvg += svgText(centerX, curY + headerFont, headerFont, "#111111", "bold", "Pay to the order of");
    curY += Math.round(headerFont * 1.3);
    // "Freedom Adjustment" — 1.3x header (company payee)
    endorsementSvg += svgText(centerX, curY + companyFont, companyFont, "#111111", "bold", "Freedom Adjustment");
    curY += Math.round(companyFont * 1.25);
    // "For Mobile Deposit Only" — same as header
    endorsementSvg += svgText(centerX, curY + bodyFont, bodyFont, "#111111", "bold", "For Mobile Deposit Only");
    curY += Math.round(bodyFont * 1.4);

    // --- Separator ---
    endorsementSvg += `<line x1="${ezLeftPad}" y1="${curY}" x2="${ezLeftPad + ezContentWidth}" y2="${curY}" stroke="#111111" stroke-width="2" opacity="0.3"/>`;
    curY += Math.round(imgWidth * 0.008);

    // --- Render endorsement signatures ---
    // Separate client/insured endorsements from Freedom/Carletta
    const isFreedomOrCarletta = (name: string) => {
      const lc = name.toLowerCase();
      return lc.includes("freedom") || lc.includes("carletta");
    };
    const clientEndorsements = endorsements.filter((e: EndorsementRecord) => !isFreedomOrCarletta(e.payee_name));
    const companyEndorsements = endorsements.filter((e: EndorsementRecord) => isFreedomOrCarletta(e.payee_name));

    // --- Client signatures first (most prominent — sigNameFont) ---
    for (const e of clientEndorsements) {
      if (e.signature_image_url && e.signature_image_url.startsWith("data:image/")) {
        endorsementSvg += svgText(centerX, curY + sigNameFont, sigNameFont, "#111111", "normal", e.payee_name);
        curY += Math.round(sigNameFont * 1.2);
        const sigWidth = Math.min(ezContentWidth - 20, Math.round(imgWidth * 0.22));
        // Use a feColorMatrix filter to force signature image to solid black
        const sigFilterId = `blackInk_${e.id.replace(/[^a-zA-Z0-9]/g, "")}`;
        endorsementSvg += `<defs><filter id="${sigFilterId}"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs>`;
        endorsementSvg += `<image href="${escHtml(e.signature_image_url)}" x="${centerX - sigWidth / 2}" y="${curY}" width="${sigWidth}" height="${sigHeight}" preserveAspectRatio="xMidYMid meet" filter="url(#${sigFilterId})"/>`;
        curY += sigHeight + Math.round(imgWidth * 0.003);
      } else if (e.signature_image_url && e.signature_image_url.startsWith("typed:")) {
        const typedName = e.signature_image_url.slice(6);
        endorsementSvg += `<text x="${centerX}" y="${curY + sigNameFont}" font-family="serif" font-size="${sigNameFont}" fill="#111111" font-style="italic" text-anchor="middle">${escHtml(typedName)}</text>`;
        curY += Math.round(sigNameFont * 1.3);
      } else if (e.status === "waived") {
        endorsementSvg += svgText(centerX, curY + bodyFont, bodyFont, "#111111", "normal", `${e.payee_name} — Waived`, "italic");
        curY += Math.round(bodyFont * 1.3);
      } else {
        endorsementSvg += svgText(centerX, curY + sigNameFont, sigNameFont, "#111111", "normal", e.payee_name);
        curY += Math.round(sigNameFont * 1.2);
        endorsementSvg += svgText(centerX, curY + bodyFont, bodyFont, "#111111", "normal", "signature", "italic");
        curY += Math.round(bodyFont * 1.3);
      }
      curY += Math.round(imgWidth * 0.005);
    }

    // --- Freedom Adjustment / By: Michael Carletta — always grouped last ---
    if (companyEndorsements.length > 0 || true) {
      curY += Math.round(imgWidth * 0.004); // extra spacing before company block
      endorsementSvg += svgText(centerX, curY + companyFont, companyFont, "#111111", "bold", "Freedom Adjustment");
      curY += Math.round(companyFont * 1.2);
      endorsementSvg += svgText(centerX, curY + sigNameFont, sigNameFont, "#111111", "normal", "By: Michael Carletta");
      curY += Math.round(sigNameFont * 1.2);
      // Render the signature from whichever company endorsement has one
      const sigEntry = companyEndorsements.find((e) => e.signature_image_url);
      if (sigEntry?.signature_image_url?.startsWith("data:image/")) {
        const sigWidth = Math.min(ezContentWidth - 20, Math.round(400 * scaleFactor));
        // Force signature to black ink using feColorMatrix
        const coSigFilterId = `blackInkCo_${sigEntry.id.replace(/[^a-zA-Z0-9]/g, "")}`;
        endorsementSvg += `<defs><filter id="${coSigFilterId}"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs>`;
        endorsementSvg += `<image href="${escHtml(sigEntry.signature_image_url)}" x="${centerX - sigWidth / 2}" y="${curY}" width="${sigWidth}" height="${sigHeight}" preserveAspectRatio="xMidYMid meet" filter="url(#${coSigFilterId})"/>`;
        curY += sigHeight + Math.round(6 * scaleFactor);
      } else if (sigEntry?.signature_image_url?.startsWith("typed:")) {
        const typedName = sigEntry.signature_image_url.slice(6);
        endorsementSvg += `<text x="${centerX}" y="${curY + sigNameFont}" font-family="serif" font-size="${sigNameFont}" fill="#111111" font-style="italic" text-anchor="middle">${escHtml(typedName)}</text>`;
        curY += Math.round(sigNameFont * 1.3);
      }
      curY += Math.round(10 * scaleFactor);
    }

    // ──── HARD SAFETY CHECK ────
    // Reject if the endorsement block would overlap the bank's restricted bottom zone
    if (curY > maxEndorsementY) {
      const msg = `SAFETY REJECTION: Endorsement block extends to Y=${curY} which exceeds the bank restricted zone limit at Y=${maxEndorsementY} (${Math.round(BOTTOM_ZONE_LIMIT * 100)}% of ${imgHeight}px image height). Reduce endorsement count or increase image resolution.`;
      console.error(`[COMPOSITE] ${msg}`);
      return jsonResp({
        success: false,
        error: msg,
        safety_rejected: true,
        endorsement_bottom_y: curY,
        max_allowed_y: maxEndorsementY,
        image_height: imgHeight,
      }, 400);
    }

    console.log(`[COMPOSITE] Endorsement block ends at Y=${curY}, limit=${maxEndorsementY} — PASS`);

    // 6. Validate endorsement block fits within image bounds
    if (ezLeftPad + ezContentWidth > imgWidth) {
      const msg = `SAFETY REJECTION: Endorsement width (${ezLeftPad + ezContentWidth}px) exceeds image width (${imgWidth}px).`;
      console.error(`[COMPOSITE] ${msg}`);
      return jsonResp({ success: false, error: msg, safety_rejected: true }, 400);
    }

    // 7. Build the intermediate SVG for rasterization.
    // The endorsement is a child of a <clipPath> that constrains it
    // strictly to the check image rectangle — nothing can render outside.
    const compositeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" 
     width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}">
  <defs>
    <clipPath id="checkBounds">
      <rect x="0" y="0" width="${imgWidth}" height="${imgHeight}"/>
    </clipPath>
  </defs>
  <image href="data:${mimeType};base64,${originalBase64}" 
         x="0" y="0" width="${imgWidth}" height="${imgHeight}" 
         preserveAspectRatio="none"/>
  <g clip-path="url(#checkBounds)">
    ${endorsementSvg}
  </g>
</svg>`;

    // 7. Flatten SVG → PNG at original resolution using resvg WASM.
    // For very large images or when resvg is unavailable, use SVG fallback.
    if (pixelCount > MAX_RASTER_PIXELS || !render) {
      const reason = !render ? "resvg_unavailable" : `oversized (${pixelCount} px > ${MAX_RASTER_PIXELS})`;
      console.log(`[COMPOSITE] rasterized vs svg-fallback mode: svg_fallback (${reason})`);
      return await uploadAndFinalize(
        supabase,
        check,
        backImagePath,
        checkId,
        endorsements,
        new Blob([compositeSvg], { type: "image/svg+xml" }),
        "image/svg+xml",
        "_endorsed.svg",
        imgWidth,
        imgHeight,
        curY,
        maxEndorsementY,
      );
    }

    let pngBytes: Uint8Array;
    try {
      console.log("[COMPOSITE] rasterized vs svg-fallback mode: rasterized_png");
      pngBytes = await render(compositeSvg);
      console.log(`[COMPOSITE] Rasterized to PNG: ${pngBytes.length} bytes`);
    } catch (renderErr) {
      console.error(`[COMPOSITE] PNG rasterization failed, falling back to SVG: ${renderErr}`);
      return await uploadAndFinalize(supabase, check, backImagePath, checkId, endorsements,
        new Blob([compositeSvg], { type: "image/svg+xml" }), "image/svg+xml", "_endorsed.svg",
        imgWidth, imgHeight, curY, maxEndorsementY);
    }

    // 8. Upload flattened PNG
    return await uploadAndFinalize(supabase, check, backImagePath, checkId, endorsements,
      new Blob([pngBytes], { type: "image/png" }), "image/png", "_endorsed.png",
      imgWidth, imgHeight, curY, maxEndorsementY);

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[COMPOSITE] ERROR: ${msg}`);
    return jsonResp({ success: false, error: msg }, 400);
  }
});

/* ------------------------------------------------------------------ */
/*  Upload + finalize helper                                           */
/* ------------------------------------------------------------------ */

async function uploadAndFinalize(
  supabase: ReturnType<typeof createClient>,
  check: { id: string; back_image_path: string },
  backImagePath: string,
  checkId: string,
  endorsements: EndorsementRecord[],
  blob: Blob,
  contentType: string,
  suffix: string,
  imgWidth: number,
  imgHeight: number,
  endorsementBottomY: number,
  maxAllowedY: number,
) {
  const compositePath = backImagePath.replace(/(\.[^.]+)$/, suffix);
  const renderMode = suffix.includes("png") ? "rasterized_png" : "svg_fallback";
  const pixelCount = imgWidth * imgHeight;

  const { error: uploadErr } = await supabase.storage
    .from("claim-files")
    .upload(compositePath, blob, { contentType, upsert: true });

  if (uploadErr) {
    console.error(`[COMPOSITE] generated output path (failed upload): ${compositePath}`);
    console.error("[COMPOSITE] DB path update committed: false");
    throw new Error(`Failed to upload composite: ${uploadErr.message}`);
  }

  // IMPORTANT: never overwrite source path on check_intake_items.
  // Keep source image references untouched even after successful composition.
  const dbPathUpdateCommitted = false;
  const overlayCoordinates = {
    top_percent: Math.round(ENDORSEMENT_TOP_PCT * 100),
    left_percent: Math.round(ENDORSEMENT_LEFT_PCT * 100),
    width_percent: Math.round(ENDORSEMENT_WIDTH_PCT * 100),
  };

  await supabase.from("check_audit_log").insert({
    check_id: checkId,
    event_type: "endorsement_signatures_composited",
    event_description: `Composited ${endorsements.length} endorsement(s) as ${renderMode} at ${imgWidth}x${imgHeight}`,
    event_data: {
      original_back_image_path: backImagePath,
      original_back_path: backImagePath,
      endorsed_back_image_path: compositePath,
      composited_back_path: compositePath,
      endorsement_count: endorsements.length,
      endorsement_ids: endorsements.map((e: { id: string }) => e.id),
      placement: "upper_left_on_image",
      overlay_coordinates: overlayCoordinates,
      image_dimensions: { width: imgWidth, height: imgHeight },
      pixel_count: pixelCount,
      endorsement_bottom_y: endorsementBottomY,
      max_allowed_y: maxAllowedY,
      output_format: renderMode,
      db_path_update_committed: dbPathUpdateCommitted,
    },
  });

  const { data: signedUrlData } = await supabase.storage
    .from("claim-files")
    .createSignedUrl(compositePath, 3600);
  const compositedSignedUrl = signedUrlData?.signedUrl ?? null;

  console.log(`[COMPOSITE] original image path: ${backImagePath}`);
  console.log(`[COMPOSITE] generated output path: ${compositePath}`);
  console.log(`[COMPOSITE] rasterized vs svg-fallback mode: ${renderMode}`);
  console.log(`[COMPOSITE] DB path update committed: ${dbPathUpdateCommitted}`);
  console.log(`[COMPOSITE] Done — saved to ${compositePath} (${imgWidth}x${imgHeight})`);

  return jsonResp({
    success: true,
    original_back_image_path: backImagePath,
    endorsed_back_image_path: compositePath,
    composited_path: compositePath,
    composited_signed_url: compositedSignedUrl,
    endorsement_count: endorsements.length,
    output_format: renderMode,
    overlay_coordinates: overlayCoordinates,
    image_dimensions: { width: imgWidth, height: imgHeight },
    pixel_count: pixelCount,
    db_path_update_committed: dbPathUpdateCommitted,
  });
}

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

function svgText(
  x: number, y: number, size: number, fill: string,
  weight: string, text: string, style?: string,
): string {
  const styleAttr = style ? ` font-style="${style}"` : "";
  return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="middle"${styleAttr}>${escHtml(text)}</text>`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Avoid O(n²) string concatenation for large images (can trigger edge memory limits).
  const chunkSize = 0x8000;
  const binaryChunks: string[] = [];

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binaryChunks.push(String.fromCharCode(...chunk));
  }

  return btoa(binaryChunks.join(""));
}

/**
 * Detect image dimensions from binary headers (JPEG / PNG).
 * Falls back to 1200×800 if detection fails.
 */
function detectImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const fallback = { width: 1200, height: 800 };
  try {
    // PNG: IHDR chunk at bytes 16-23
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (width > 0 && height > 0 && width < 20000 && height < 20000) return { width, height };
    }
    // JPEG: scan for SOF marker
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let offset = 2;
      while (offset < bytes.length - 8) {
        if (bytes[offset] !== 0xFF) { offset++; continue; }
        const marker = bytes[offset + 1];
        if (marker >= 0xC0 && marker <= 0xC3) {
          const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
          const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
          if (width > 0 && height > 0 && width < 20000 && height < 20000) return { width, height };
        }
        const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 2 + segLen;
      }
    }
  } catch { /* fall through */ }
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
