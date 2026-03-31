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

// Real bank endorsement zone (bottom area of check back)
const ZONE_TOP_PCT = 0.15;
const ZONE_BOTTOM_PCT = 0.92;
const ENDORSEMENT_LEFT_PCT = 0.38;
const ENDORSEMENT_WIDTH_PCT = 0.22;
const MAX_RASTER_PIXELS = 8_000_000;

type OverrideShape = {
  xPct: number;
  yPct: number;
  scale: number;
  rotationDeg: number;
};

interface EndorsementRecord {
  id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signed_at: string | null;
  signature_image_url: string | null;
  signature_method: string | null;
  check_id: string;
  
  check_payees?: { endorsement_image_path?: string | null } | { endorsement_image_path?: string | null }[] | null;
  resolvedSignatureImageUrl?: string | null;
  typedSignatureText?: string | null;
  finalSignatureRef?: string | null;
  signatureAssetLoaded?: boolean;
}

// ── Auto-fit logic (matches src/lib/endorsementFit.ts) ──
type LayoutPreset = {
  fontSize: number;
  lineGap: number;
  rowGap: number;
  signatureHeight: number;
  columns: 1 | 2;
  compactText: boolean;
  scale: number;
};

type MeasuredLayout = LayoutPreset & { estimatedHeight: number };

const PRESETS: LayoutPreset[] = [
  { fontSize: 28, lineGap: 18, rowGap: 24, signatureHeight: 110, columns: 1, compactText: false, scale: 1 },
  { fontSize: 24, lineGap: 14, rowGap: 18, signatureHeight: 92, columns: 1, compactText: true, scale: 0.92 },
  { fontSize: 22, lineGap: 12, rowGap: 14, signatureHeight: 78, columns: 2, compactText: true, scale: 0.86 },
  { fontSize: 20, lineGap: 10, rowGap: 10, signatureHeight: 64, columns: 2, compactText: true, scale: 0.8 },
];

function measurePreset(signerCount: number, preset: LayoutPreset): MeasuredLayout {
  const headerLines = preset.compactText ? 2 : 3;
  const headerHeight = headerLines * (preset.fontSize + preset.lineGap);
  const rows = preset.columns === 2 ? Math.ceil(signerCount / 2) : signerCount;
  const perRow = preset.fontSize + 8 + preset.signatureHeight + preset.rowGap;
  const signerHeight = rows * perRow;
  const footerHeight = preset.fontSize + preset.lineGap + preset.signatureHeight + 20;
  return { ...preset, estimatedHeight: Math.ceil(headerHeight + signerHeight + footerHeight) };
}

function fitLayout(signerCount: number, zoneHeightPx: number, requestedScale: number): MeasuredLayout {
  for (const preset of PRESETS) {
    const measured = measurePreset(signerCount, { ...preset, scale: Math.min(preset.scale, requestedScale || 1) });
    if (measured.estimatedHeight <= zoneHeightPx) return measured;
  }
  return measurePreset(signerCount, { ...PRESETS[PRESETS.length - 1], scale: Math.min(PRESETS[PRESETS.length - 1].scale, requestedScale || 1) });
}

function chunkRows<T>(items: T[], cols: 1 | 2): T[][] {
  if (cols === 1) return items.map((i) => [i]);
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase: any = createClient(supabaseUrl, serviceKey);

  try {
    const { checkId } = await req.json();
    if (!checkId) throw new Error("checkId is required");

    console.log(`[COMPOSITE] check id: ${checkId}`);

    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("id, back_image_path, front_image_path, check_number, carrier_name, amount, endorsement_override")
      .eq("id", checkId)
      .single();

    if (checkErr || !check) throw new Error(`Check not found: ${checkErr?.message}`);
    if (!check.back_image_path) throw new Error("No back image to composite onto");

    let backImagePath = check.back_image_path as string;
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

      const recoveredOriginalPath = auditData?.original_back_image_path ?? auditData?.original_back_path ?? null;
      if (recoveredOriginalPath) {
        backImagePath = recoveredOriginalPath;
      } else {
        throw new Error("Current back image path points to an endorsed artifact and no original source path could be recovered");
      }
    }

    console.log(`[COMPOSITE] back image path: ${backImagePath}`);

    // ── Strict endorsement fetch ──
    const { data: fetchedEndorsements, error: endErr } = await supabase
      .from("check_endorsements")
      .select("id, payee_name, payee_type, status, signed_at, signature_image_url, signature_method, check_id, check_payees!check_endorsements_payee_id_fkey(endorsement_image_path)")
      .eq("check_id", checkId)
      .eq("status", "signed")
      .not("signature_image_url", "is", null)
      .order("created_at", { ascending: true });

    if (endErr) throw new Error(`Failed to load endorsements: ${endErr.message}`);
    const endorsements = (fetchedEndorsements ?? []).filter(
      (e: any) => (e.signature_method ?? "").toLowerCase() !== "internal",
    );
    if (!endorsements?.length) {
      return jsonResp({ success: false, error: "No valid signed endorsement assets found for this check.", code: "NO_SIGNED_ENDORSEMENTS", checkId }, 400);
    }

    const mismatch = endorsements.find((e: any) => e.check_id !== checkId);
    if (mismatch) {
      return jsonResp({ success: false, error: `Signer asset ${mismatch.id} does not belong to check ${checkId}.`, code: "ENDORSEMENT_CHECK_MISMATCH", checkId, badEndorsementId: mismatch.id }, 400);
    }

    // Validate all have signature assets
    const missingAsset = endorsements.find((e: any) => !e.signature_image_url);
    if (missingAsset) {
      return jsonResp({ success: false, error: `Invalid endorsement: missing signature asset for ${missingAsset.payee_name}.`, code: "MISSING_SIGNATURE_ASSET" }, 400);
    }

    console.log("[COMPOSITE] loading back image");
    const { data: imgBlob, error: dlErr } = await supabase.storage
      .from("claim-files")
      .download(backImagePath);

    if (dlErr || !imgBlob) throw new Error(`Cannot download back image: ${dlErr?.message}`);

    const originalBytes = new Uint8Array(await imgBlob.arrayBuffer());
    const dims = detectImageDimensions(originalBytes);
    const imgWidth = dims.width;
    const imgHeight = dims.height;
    console.log(`[COMPOSITE] detected image dimensions: ${imgWidth}x${imgHeight}`);

    const rawOverride = (check.endorsement_override ?? null) as Partial<OverrideShape> | null;
    const appliedOverride: OverrideShape = {
      xPct: rawOverride?.xPct ?? ENDORSEMENT_LEFT_PCT,
      yPct: rawOverride?.yPct ?? 0.5,
      scale: rawOverride?.scale ?? 1,
      rotationDeg: rawOverride?.rotationDeg ?? 0,
    };
    console.log(`[COMPOSITE] applying override: ${JSON.stringify(appliedOverride)}`);

    // ── Resolve signature assets ──
    const resolvedEndorsements = await Promise.all(
      (endorsements as EndorsementRecord[]).map(async (endorsement) => {
        const { savedDrawnSignatureUrl, savedUploadedSignatureUrl, typedSignatureText } =
          resolvePreferredSignatureRefs(endorsement);
        const finalSignatureRef = savedDrawnSignatureUrl || savedUploadedSignatureUrl || null;

        let resolvedSignatureImageUrl: string | null = null;
        let signatureAssetLoaded = false;

        if (finalSignatureRef) {
          resolvedSignatureImageUrl = await loadSignatureDataUrl(supabase, finalSignatureRef);
          signatureAssetLoaded = Boolean(resolvedSignatureImageUrl);
          if (!signatureAssetLoaded) {
            throw new Error(`Failed to load saved signature asset for ${endorsement.payee_name}`);
          }
        }

        console.log(
          `[COMPOSITE] signature debug | payee=${endorsement.payee_name} | method=${endorsement.signature_method ?? "unknown"} | source=${finalSignatureRef ?? "typed-only"} | loaded=${signatureAssetLoaded}`,
        );

        return {
          ...endorsement,
          resolvedSignatureImageUrl,
          typedSignatureText: finalSignatureRef ? null : typedSignatureText,
          finalSignatureRef,
          signatureAssetLoaded,
        } satisfies EndorsementRecord;
      }),
    );

    const isFreedomOrCarletta = (name: string) => {
      const lc = name.toLowerCase();
      return lc.includes("freedom") || lc.includes("carletta");
    };

    const clientEndorsements = resolvedEndorsements.filter((e) => !isFreedomOrCarletta(e.payee_name));
    const companyEndorsements = resolvedEndorsements.filter((e) => isFreedomOrCarletta(e.payee_name));

    // ── Auto-fit layout — real bank endorsement zone ──
    const zoneTop = Math.floor(imgHeight * ZONE_TOP_PCT);
    const zoneBottom = Math.floor(imgHeight * ZONE_BOTTOM_PCT);
    const zoneHeight = zoneBottom - zoneTop;

    console.log("[COMPOSITE] appliedOverride", appliedOverride);

    let measured = fitLayout(endorsements.length, zoneHeight, appliedOverride.scale);
    let blockHeight = measured.estimatedHeight;
    let blockCenterY = zoneTop + (appliedOverride.yPct * zoneHeight);
    let blockTop = Math.round(blockCenterY - blockHeight / 2);
    let blockBottom = blockTop + blockHeight;

    // Nudge up if slightly overflowing
    if (blockBottom > zoneBottom) {
      const overflow = blockBottom - zoneBottom;
      blockCenterY -= overflow;
      blockTop = Math.round(blockCenterY - blockHeight / 2);
      blockBottom = blockTop + blockHeight;
    }

    // Clamp inside zone
    blockCenterY = Math.max(
      zoneTop + blockHeight / 2,
      Math.min(zoneBottom - blockHeight / 2, blockCenterY)
    );
    blockTop = Math.round(blockCenterY - blockHeight / 2);
    blockBottom = blockTop + blockHeight;

    // If still overflowing, reduce scale slightly and recalc once
    if (blockBottom > zoneBottom) {
      const adjustedScale = Math.max(0.72, (measured.scale ?? 1) - 0.05);
      measured = fitLayout(endorsements.length, zoneHeight, adjustedScale);
      blockHeight = measured.estimatedHeight;
      blockCenterY = Math.max(
        zoneTop + blockHeight / 2,
        Math.min(zoneBottom - blockHeight / 2, blockCenterY)
      );
      blockTop = Math.round(blockCenterY - blockHeight / 2);
      blockBottom = blockTop + blockHeight;
    }

    console.log("[COMPOSITE] blockTop/blockBottom/zoneBottom", { blockTop, blockBottom, zoneBottom });

    const rejectDetails = {
      imageHeight: imgHeight,
      zoneTop,
      zoneBottom,
      zoneHeight,
      blockTop,
      blockHeight,
      blockBottom,
      signerCount: endorsements.length,
      columns: measured.columns,
      fontSize: measured.fontSize,
      signatureHeight: measured.signatureHeight,
      rowGap: measured.rowGap,
      compactText: measured.compactText,
      rotationDeg: appliedOverride.rotationDeg,
      scale: measured.scale,
      xPct: appliedOverride.xPct,
      yPct: appliedOverride.yPct,
    };

    console.log("[COMPOSITE] endorsement-fit", JSON.stringify(rejectDetails));

    if (blockTop < zoneTop || blockBottom > zoneBottom) {
      return jsonResp({
        success: false,
        error: `Endorsement block extends to y=${blockBottom} which exceeds the bank restricted zone limit at y=${zoneBottom}.`,
        code: "ENDORSEMENT_ZONE_OVERFLOW",
        details: rejectDetails,
      }, 400);
    }

    // ── Build SVG using fitted layout (LOCAL coordinates) ──
    const pixelCount = imgWidth * imgHeight;
    const originalBase64 = uint8ToBase64(originalBytes);
    const mimeType = backImagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    const blockWidth = Math.round(imgWidth * ENDORSEMENT_WIDTH_PCT);
    const { fontSize, lineGap: fitLineGap, rowGap: fitRowGap, signatureHeight: fitSigHeight, compactText } = measured;
    const companyFont = Math.max(9, Math.round(fontSize * 1.2));
    const byLineFont = fontSize;
    const sectionGap = Math.max(3, Math.round(fitLineGap * 2));
    const localCenterX = Math.round(blockWidth / 2);

    // Build endorsement block in LOCAL coordinates starting at 0,0
    let endorsementSvg = "";
    let curY = 0;

    // Header
    if (compactText) {
      endorsementSvg += svgText(localCenterX, curY + fontSize, fontSize, "#111111", "bold", "Pay to Freedom Adjustment");
      curY += fontSize + fitLineGap;
      endorsementSvg += svgText(localCenterX, curY + fontSize, fontSize, "#111111", "bold", "Mobile Deposit Only");
      curY += fontSize + fitLineGap;
    } else {
      endorsementSvg += svgText(localCenterX, curY + fontSize, fontSize, "#111111", "bold", "Pay to the order of");
      curY += fontSize + fitLineGap;
      endorsementSvg += svgText(localCenterX, curY + companyFont, companyFont, "#111111", "bold", "Freedom Adjustment");
      curY += companyFont + fitLineGap;
      endorsementSvg += svgText(localCenterX, curY + fontSize, fontSize, "#111111", "bold", "For Mobile Deposit Only");
      curY += fontSize + fitLineGap;
    }

    endorsementSvg += `<line x1="0" y1="${curY}" x2="${blockWidth}" y2="${curY}" stroke="#111111" stroke-width="2" opacity="0.3"/>`;
    curY += sectionGap;

    // Client endorsements (multi-column support)
    const signerRows = chunkRows(clientEndorsements, measured.columns);
    const colWidth = measured.columns === 2 ? Math.round(blockWidth / 2) : blockWidth;

    for (const row of signerRows) {
      let maxRowH = 0;
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const endorsement = row[colIdx];
        const colCenterX = measured.columns === 2
          ? colIdx * colWidth + Math.round(colWidth / 2)
          : localCenterX;

        let localY = curY;
        endorsementSvg += svgText(colCenterX, localY + byLineFont, byLineFont, "#111111", "normal", endorsement.payee_name);
        localY += byLineFont + fitLineGap;

        if (endorsement.resolvedSignatureImageUrl) {
          const sigWidth = Math.min(colWidth - 20, Math.round(imgHeight * 0.10));
          const sigFilterId = `blackInk_${endorsement.id.replace(/[^a-zA-Z0-9]/g, "")}`;
          endorsementSvg += `<defs><filter id="${sigFilterId}"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs>`;
          endorsementSvg += `<image href="${escHtml(endorsement.resolvedSignatureImageUrl)}" x="${Math.round(colCenterX - sigWidth / 2)}" y="${localY}" width="${sigWidth}" height="${fitSigHeight}" preserveAspectRatio="xMidYMid meet" filter="url(#${sigFilterId})"/>`;
          localY += fitSigHeight + fitRowGap;
        } else if (endorsement.typedSignatureText) {
          endorsementSvg += `<text x="${colCenterX}" y="${localY + byLineFont}" font-family="serif" font-size="${byLineFont}" fill="#111111" font-style="italic" text-anchor="middle">${escHtml(endorsement.typedSignatureText)}</text>`;
          localY += byLineFont + fitRowGap;
        } else {
          endorsementSvg += svgText(colCenterX, localY + byLineFont, byLineFont, "#111111", "normal", endorsement.payee_name);
          localY += byLineFont + fitRowGap;
        }
        maxRowH = Math.max(maxRowH, localY - curY);
      }
      curY += maxRowH;
    }

    curY += sectionGap;

    // Footer: company + owner
    endorsementSvg += svgText(localCenterX, curY + companyFont, companyFont, "#111111", "bold", "Freedom Adjustment");
    curY += companyFont + fitLineGap;
    endorsementSvg += svgText(localCenterX, curY + byLineFont, byLineFont, "#111111", "normal", "By: Michael Carletta");
    curY += byLineFont + fitLineGap;

    const companySignature = companyEndorsements.find((e) => e.resolvedSignatureImageUrl || e.typedSignatureText);
    if (companySignature?.resolvedSignatureImageUrl) {
      const sigWidth = Math.min(blockWidth - 20, Math.round(imgHeight * 0.10));
      const coSigFilterId = `blackInkCo_${companySignature.id.replace(/[^a-zA-Z0-9]/g, "")}`;
      endorsementSvg += `<defs><filter id="${coSigFilterId}"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs>`;
      endorsementSvg += `<image href="${escHtml(companySignature.resolvedSignatureImageUrl)}" x="${Math.round(localCenterX - sigWidth / 2)}" y="${curY}" width="${sigWidth}" height="${fitSigHeight}" preserveAspectRatio="xMidYMid meet" filter="url(#${coSigFilterId})"/>`;
      curY += fitSigHeight + fitLineGap;
    } else if (companySignature?.typedSignatureText) {
      endorsementSvg += `<text x="${localCenterX}" y="${curY + byLineFont}" font-family="serif" font-size="${byLineFont}" fill="#111111" font-style="italic" text-anchor="middle">${escHtml(companySignature.typedSignatureText)}</text>`;
      curY += byLineFont + fitLineGap;
    }

    // ── Single placement transform: center-origin with rotation + scale ──
    const blockCenterX = Math.round(appliedOverride.xPct * imgWidth);
    const finalBlockWidth = blockWidth;
    const finalBlockHeight = Math.max(blockHeight, Math.ceil(curY));
    const scaleVal = measured.scale || 1;
    const rotDeg = appliedOverride.rotationDeg || 0;

    const endorsementTransform = [
      `translate(${blockCenterX} ${blockCenterY})`,
      `rotate(${rotDeg})`,
      `scale(${scaleVal})`,
      `translate(${-Math.round(finalBlockWidth / 2)} ${-Math.round(finalBlockHeight / 2)})`,
    ].join(" ");

    console.log("[COMPOSITE] final placement", {
      blockCenterX,
      blockCenterY,
      finalBlockWidth,
      finalBlockHeight,
      rotationDeg: rotDeg,
      scale: scaleVal,
      xPct: appliedOverride.xPct,
      yPct: appliedOverride.yPct,
    });

    const compositeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}">
  <defs>
    <clipPath id="checkBounds">
      <rect x="0" y="0" width="${imgWidth}" height="${imgHeight}"/>
    </clipPath>
  </defs>
  <image href="data:${mimeType};base64,${originalBase64}" x="0" y="0" width="${imgWidth}" height="${imgHeight}" preserveAspectRatio="none"/>
  <g clip-path="url(#checkBounds)">
    <g transform="${endorsementTransform}">
      ${endorsementSvg}
    </g>
  </g>
</svg>`;
    if (pixelCount > MAX_RASTER_PIXELS || !render) {
      const reason = !render ? "resvg_unavailable" : `oversized (${pixelCount} px > ${MAX_RASTER_PIXELS})`;
      console.log(`[COMPOSITE] compositor/export succeeded via svg_fallback (${reason})`);
      return await uploadAndFinalize(supabase, backImagePath, checkId, resolvedEndorsements, new Blob([compositeSvg], { type: "image/svg+xml" }), "image/svg+xml", "_endorsed.svg", imgWidth, imgHeight, curY, zoneBottom, appliedOverride);
    }

    try {
      const pngBytes = await render(compositeSvg);
      console.log(`[COMPOSITE] compositor/export succeeded via rasterized_png (${pngBytes.length} bytes)`);
      return await uploadAndFinalize(supabase, backImagePath, checkId, resolvedEndorsements, new Blob([toArrayBuffer(pngBytes)], { type: "image/png" }), "image/png", "_endorsed.png", imgWidth, imgHeight, curY, zoneBottom, appliedOverride);
    } catch (renderErr) {
      console.error(`[COMPOSITE] PNG rasterization failed, falling back to SVG: ${renderErr}`);
      return await uploadAndFinalize(supabase, backImagePath, checkId, resolvedEndorsements, new Blob([compositeSvg], { type: "image/svg+xml" }), "image/svg+xml", "_endorsed.svg", imgWidth, imgHeight, curY, zoneBottom, appliedOverride);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[COMPOSITE] ERROR:", msg, error);
    return jsonResp({ success: false, error: msg, code: "COMPOSITE_FAILURE" }, 400);
  }
});

async function uploadAndFinalize(
  supabase: any,
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
  appliedOverride: OverrideShape,
) {
  const cacheBuster = Date.now();
  const compositePath = backImagePath.replace(/(\.[^.]+)$/, `_endorsed_${cacheBuster}${suffix.replace('_endorsed', '')}`);
  const renderMode = suffix.includes("png") ? "rasterized_png" : "svg_fallback";
  const pixelCount = imgWidth * imgHeight;

  const { error: uploadErr } = await supabase.storage
    .from("claim-files")
    .upload(compositePath, blob, { contentType, upsert: true });

  if (uploadErr) {
    console.error(`[COMPOSITE] final generated asset path (failed upload): ${compositePath}`);
    throw new Error(`Failed to upload composite: ${uploadErr.message}`);
  }

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
      endorsement_ids: endorsements.map((e) => e.id),
      overlay_coordinates: appliedOverride,
      image_dimensions: { width: imgWidth, height: imgHeight },
      pixel_count: pixelCount,
      endorsement_bottom_y: endorsementBottomY,
      max_allowed_y: maxAllowedY,
      output_format: renderMode,
      signature_debug: endorsements.map((e) => ({
        payee_name: e.payee_name,
        signature_method: e.signature_method,
        signature_source: e.finalSignatureRef,
        signature_asset_loaded: e.signatureAssetLoaded,
        typed_fallback_used: Boolean(e.typedSignatureText),
      })),
      db_path_update_committed: false,
    },
  });

  const { data: signedUrlData, error: signedUrlErr } = await supabase.storage
    .from("claim-files")
    .createSignedUrl(compositePath, 3600);
  if (signedUrlErr) {
    console.error(`[COMPOSITE] signed URL generation failed for ${compositePath}: ${signedUrlErr.message}`);
  }

  console.log(`[COMPOSITE] final generated asset path: ${compositePath}`);

  return jsonResp({
    success: true,
    original_back_image_path: backImagePath,
    endorsed_back_image_path: compositePath,
    composited_path: compositePath,
    composited_signed_url: signedUrlData?.signedUrl ?? null,
    endorsement_count: endorsements.length,
    output_format: renderMode,
    overlay_coordinates: appliedOverride,
    image_dimensions: { width: imgWidth, height: imgHeight },
    pixel_count: pixelCount,
    db_path_update_committed: false,
  });
}

function jsonResp(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escHtml(s: string | number | null | undefined) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function svgText(x: number, y: number, size: number, fill: string, weight: string, text: string, style?: string) {
  const styleAttr = style ? ` font-style="${style}"` : "";
  return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="middle"${styleAttr}>${escHtml(text)}</text>`;
}

function uint8ToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function detectImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const fallback = { width: 1200, height: 800 };
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (width > 0 && height > 0 && width < 20000 && height < 20000) return { width, height };
    }
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
  } catch { /* no-op */ }
  console.log("[COMPOSITE] Could not detect image dimensions, using fallback 1200x800");
  return fallback;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isTypedSignatureRef(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("typed:");
}

function isHttpUrl(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isRealSignatureRef(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !isTypedSignatureRef(value);
}

function classifySignatureMethod(method: string | null | undefined) {
  const normalized = method?.toLowerCase() ?? "";
  if (normalized.includes("upload")) return "uploaded";
  if (normalized.includes("type")) return "typed";
  if (normalized.includes("draw") || normalized.includes("portal") || normalized.includes("internal")) return "drawn";
  return "unknown";
}

function extractLegacyPayeeSignaturePath(record: EndorsementRecord) {
  const linkedPayee = record.check_payees;
  if (Array.isArray(linkedPayee)) {
    return linkedPayee.find((entry) => isRealSignatureRef(entry?.endorsement_image_path))?.endorsement_image_path ?? null;
  }
  return isRealSignatureRef((linkedPayee as any)?.endorsement_image_path) ? (linkedPayee as any).endorsement_image_path : null;
}

function resolvePreferredSignatureRefs(record: EndorsementRecord) {
  const methodClass = classifySignatureMethod(record.signature_method);
  const currentSignatureRef = isRealSignatureRef(record.signature_image_url) ? record.signature_image_url : null;
  const legacyStoredSignatureRef = extractLegacyPayeeSignaturePath(record);

  const savedDrawnSignatureUrl =
    legacyStoredSignatureRef ||
    ((methodClass === "drawn" || methodClass === "unknown") && currentSignatureRef ? currentSignatureRef : null);

  const savedUploadedSignatureUrl =
    savedDrawnSignatureUrl ? null
    : methodClass === "uploaded" && currentSignatureRef ? currentSignatureRef : null;

  const typedSignatureText =
    !savedDrawnSignatureUrl && !savedUploadedSignatureUrl && isTypedSignatureRef(record.signature_image_url)
      ? record.signature_image_url.slice(6)
      : null;

  return { savedDrawnSignatureUrl, savedUploadedSignatureUrl, typedSignatureText };
}

async function loadSignatureDataUrl(supabase: any, signatureRef: string): Promise<string | null> {
  if (signatureRef.startsWith("data:image/")) return signatureRef;

  let blob: Blob | null = null;

  if (isHttpUrl(signatureRef)) {
    const response = await fetch(signatureRef);
    if (!response.ok) throw new Error(`Failed to fetch signature asset: HTTP ${response.status}`);
    blob = await response.blob();
  } else {
    const { data, error } = await supabase.storage.from("claim-files").download(signatureRef);
    if (error || !data) throw new Error(`Failed to download signature asset: ${error?.message ?? signatureRef}`);
    blob = data;
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const contentType = blob.type || inferImageContentType(signatureRef);
  return `data:${contentType};base64,${uint8ToBase64(bytes)}`;
}

function inferImageContentType(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}
