import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

let render: ((svg: string) => Promise<Uint8Array>) | null = null;
try {
  const resvg = await import("https://deno.land/x/resvg_wasm@0.2.0/mod.ts");
  render = resvg.render;
} catch (e) {
  console.warn("[COMPOSITE] resvg_wasm not available, will use SVG fallback:", e);
}

// Lazy-load imagescript only when needed (keeps cold-start fast).
let imageScriptPromise: Promise<any> | null = null;
async function loadImageScript(): Promise<any> {
  if (!imageScriptPromise) {
    imageScriptPromise = import("https://deno.land/x/imagescript@1.2.17/mod.ts")
      .catch((e) => {
        console.warn("[COMPOSITE] imagescript not available, downscale disabled:", e);
        return null;
      });
  }
  return imageScriptPromise;
}

/**
 * If the source back image exceeds MAX_RASTER_PIXELS, decode it, resize so the
 * pixel count fits under the cap, and re-encode as JPEG. This keeps the
 * compositor on the rasterized-PNG path (clean, flattened endorsement) instead
 * of the SVG fallback (which embeds the full-res JPEG and renders awkwardly
 * when the viewer scales it down).
 */
async function maybeDownscaleForRaster(
  bytes: Uint8Array,
  width: number,
  height: number,
  maxPixels: number,
  maxLongEdge: number,
): Promise<{ bytes: Uint8Array; width: number; height: number; downscaled: boolean }> {
  const pixels = width * height;
  const longest = Math.max(width, height);
  if (pixels <= maxPixels && longest <= maxLongEdge) {
    return { bytes, width, height, downscaled: false };
  }

  const lib = await loadImageScript();
  if (!lib) {
    return { bytes, width, height, downscaled: false };
  }

  try {
    const pixelRatio = Math.sqrt(maxPixels / pixels);
    const edgeRatio = maxLongEdge / longest;
    const ratio = Math.min(1, pixelRatio, edgeRatio);
    const targetW = Math.max(1, Math.floor(width * ratio));
    const targetH = Math.max(1, Math.floor(height * ratio));

    const decoded = await lib.Image.decode(bytes);
    decoded.resize(targetW, targetH);
    const encoded = await decoded.encodeJPEG(85);

    console.log(
      `[COMPOSITE] downscaled back image ${width}x${height} (${pixels}px) -> ${targetW}x${targetH} (${targetW * targetH}px), ${bytes.length}B -> ${encoded.length}B`,
    );

    return { bytes: encoded, width: targetW, height: targetH, downscaled: true };
  } catch (e) {
    console.warn("[COMPOSITE] downscale failed, falling back to original:", e);
    return { bytes, width, height, downscaled: false };
  }
}

async function maybeNormalizeSignatureDataUrl(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ dataUrl: string; normalized: boolean }> {
  const lib = await loadImageScript();
  if (!lib) {
    return { dataUrl: `data:${contentType};base64,${uint8ToBase64(bytes)}`, normalized: false };
  }

  try {
    const decoded = await lib.Image.decode(bytes);
    const originalWidth = decoded.width;
    const originalHeight = decoded.height;
    const pixels = decoded.width * decoded.height;
    const longest = Math.max(decoded.width, decoded.height);

    if (pixels <= MAX_SIGNATURE_PIXELS && longest <= MAX_SIGNATURE_LONG_EDGE) {
      return { dataUrl: `data:${contentType};base64,${uint8ToBase64(bytes)}`, normalized: false };
    }

    const pixelRatio = Math.sqrt(MAX_SIGNATURE_PIXELS / pixels);
    const edgeRatio = MAX_SIGNATURE_LONG_EDGE / longest;
    const ratio = Math.min(1, pixelRatio, edgeRatio);
    const targetW = Math.max(1, Math.floor(decoded.width * ratio));
    const targetH = Math.max(1, Math.floor(decoded.height * ratio));

    decoded.resize(targetW, targetH);
    const encoded = await decoded.encodePNG();
    console.log(
      `[COMPOSITE] normalized signature asset ${originalWidth}x${originalHeight} (${pixels}px) -> ${targetW}x${targetH} (${targetW * targetH}px), ${bytes.length}B -> ${encoded.length}B`,
    );

    return { dataUrl: `data:image/png;base64,${uint8ToBase64(encoded)}`, normalized: true };
  } catch (e) {
    console.warn("[COMPOSITE] signature normalization skipped:", e);
    return { dataUrl: `data:${contentType};base64,${uint8ToBase64(bytes)}`, normalized: false };
  }
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
// Keep endorsement compositing aligned with the CheckAlt submitter's 1200px
// longest-edge normalization without changing CheckAlt's own sizing pipeline.
// This avoids edge CPU kills on large phone captures while still producing a
// raster JPEG/PNG that CheckAlt can decode and compress normally.
const MAX_RASTER_LONG_EDGE = 1200;
const MAX_RASTER_PIXELS = 1_200_000;
const MAX_SIGNATURE_LONG_EDGE = 600;
const MAX_SIGNATURE_PIXELS = 180_000;

type OverrideShape = {
  xPct: number;
  yPct: number;
  scale: number;
  rotationDeg: number;
  showPayToOrder: boolean;
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
  const userScale = requestedScale || 1;

  // Match src/lib/endorsementFit.ts: prefer a preset that leaves ~35% of the
  // zone free so the user can actually move the endorsement around.
  const PLACEMENT_HEADROOM = 0.65;
  let basePreset: LayoutPreset | null = null;
  for (const preset of PRESETS) {
    const measured = measurePreset(signerCount, preset);
    if (measured.estimatedHeight <= zoneHeightPx * PLACEMENT_HEADROOM) {
      basePreset = preset;
      break;
    }
  }
  if (!basePreset) {
    for (const preset of PRESETS) {
      const measured = measurePreset(signerCount, preset);
      if (measured.estimatedHeight <= zoneHeightPx) {
        basePreset = preset;
        break;
      }
    }
  }
  if (!basePreset) basePreset = PRESETS[PRESETS.length - 1];

  // Bake user scale into all dimensions (matches src/lib/endorsementFit.ts exactly)
  const scaled: LayoutPreset = {
    ...basePreset,
    fontSize: Math.round(basePreset.fontSize * userScale),
    lineGap: Math.round(basePreset.lineGap * userScale),
    rowGap: Math.round(basePreset.rowGap * userScale),
    signatureHeight: Math.round(basePreset.signatureHeight * userScale),
    scale: userScale,
  };

  console.log("[COMPOSITE] fitLayout", {
    basePreset: basePreset.fontSize,
    userScale,
    scaledFontSize: scaled.fontSize,
    presetSigHeight: basePreset.signatureHeight,
    bakedSigHeight: scaled.signatureHeight,
  });

  return measurePreset(signerCount, scaled);
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
    const { checkId, overrideData } = await req.json();
    if (!checkId) throw new Error("checkId is required");
    if (overrideData) {
      console.log("[COMPOSITE] overrideData supplied in request body:", JSON.stringify(overrideData));
    }

    console.log(`[COMPOSITE] check id: ${checkId}`);

    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("id, back_image_path, front_image_path, check_number, carrier_name, amount, endorsement_override, tenant_id")
      .eq("id", checkId)
      .single();

    if (checkErr || !check) throw new Error(`Check not found: ${checkErr?.message}`);
    
    // Fetch tenant name for branding
    let companyName = "Freedom Adjustment";
    if (check.tenant_id) {
      const { data: tenant } = await supabase
        .from("tenants")
        .select("name")
        .eq("id", check.tenant_id)
        .maybeSingle();
      if (tenant?.name) {
        companyName = tenant.name;
      }
    }

    if (!check.back_image_path) throw new Error("No back image to composite onto");

    let backImagePath = check.back_image_path as string;
    if (backImagePath.includes("_endorsed")) {
      const { data: compositeAudits } = await supabase
        .from("check_audit_log")
        .select("event_data, created_at")
        .eq("check_id", checkId)
        .eq("event_type", "endorsement_signatures_composited")
        .order("created_at", { ascending: false })
        .limit(25);

      const matchingAudit = (compositeAudits ?? []).find((audit: any) => {
        const eventData = audit?.event_data ?? {};
        return eventData.endorsed_back_image_path === backImagePath ||
          eventData.composited_path === backImagePath ||
          eventData.composited_back_path === backImagePath;
      });

      const auditData = (matchingAudit?.event_data ?? compositeAudits?.[0]?.event_data ?? null) as {
        original_back_image_path?: string;
        original_back_path?: string;
      } | null;

      const recoveredOriginalPath =
        await recoverOriginalBackImagePath(supabase, backImagePath) ??
        auditData?.original_back_image_path ??
        auditData?.original_back_path ??
        null;

      if (recoveredOriginalPath) {
        backImagePath = recoveredOriginalPath;
      } else {
        throw new Error("Current back image path points to an endorsed artifact and no original source path could be recovered");
      }
    }

    console.log(`[COMPOSITE] back image path: ${backImagePath}`);

    const overrideForAllowText = (overrideData ?? check.endorsement_override) as Partial<OverrideShape> | null;
    const allowTextOnly = Boolean(
      overrideForAllowText?.showPayToOrder,
    );

    // ── Strict endorsement fetch ──
    const { data: fetchedEndorsements, error: endErr } = await supabase
      .from("check_endorsements")
      .select("id, payee_name, payee_type, status, signed_at, signature_image_url, signature_method, check_id, check_payees!check_endorsements_payee_id_fkey(endorsement_image_path)")
      .eq("check_id", checkId)
      .eq("status", "signed")
      .not("signature_image_url", "is", null)
      .order("created_at", { ascending: true });

    if (endErr) throw new Error(`Failed to load endorsements: ${endErr.message}`);
    const endorsements = (fetchedEndorsements ?? []).filter((e: any) => {
      const method = (e.signature_method ?? "").toLowerCase();
      return method !== "internal" && method !== "manual";
    });
    if (!endorsements?.length && !allowTextOnly) {
      return await restoreOriginalBackImage(
        supabase,
        checkId,
        check.back_image_path,
        backImagePath,
        "no_visible_signatures",
      );
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

    const rawBytes = new Uint8Array(await imgBlob.arrayBuffer());
    const rawDims = detectImageDimensions(rawBytes);
    console.log(`[COMPOSITE] detected source image dimensions: ${rawDims.width}x${rawDims.height}`);

    // Downscale oversized captures so the compositor stays on the rasterized-PNG
    // path. The original full-res image in storage is left untouched — only the
    // copy fed into the SVG/PNG composite is resized.
    const downscaled = await maybeDownscaleForRaster(
      rawBytes,
      rawDims.width,
      rawDims.height,
      MAX_RASTER_PIXELS,
      MAX_RASTER_LONG_EDGE,
    );
    const originalBytes = downscaled.bytes;
    const imgWidth = downscaled.width;
    const imgHeight = downscaled.height;
    if (downscaled.downscaled) {
      console.log(`[COMPOSITE] using downscaled dimensions: ${imgWidth}x${imgHeight}`);
    }

    // Prefer overrideData from request body (avoids DB replication lag right after save).
    const rawOverride = (overrideData ?? check.endorsement_override ?? null) as Partial<OverrideShape> | null;
    console.log(
      `[COMPOSITE] raw override source=${overrideData ? "request-body" : "db"}:`,
      JSON.stringify(rawOverride),
    );
    const appliedOverride: OverrideShape = {
      xPct: rawOverride?.xPct ?? ENDORSEMENT_LEFT_PCT,
      yPct: rawOverride?.yPct ?? 0.5,
      scale: rawOverride?.scale ?? 1,
      rotationDeg: rawOverride?.rotationDeg ?? 0,
      showPayToOrder: rawOverride?.showPayToOrder ?? false,
    };
    console.log("[COMPOSITE] applied override (with defaults):", JSON.stringify(appliedOverride));
    console.log(`[COMPOSITE][DEBUG] checkId=${checkId} | userScale=${appliedOverride.scale} | xPct=${appliedOverride.xPct} | yPct=${appliedOverride.yPct} | rotDeg=${appliedOverride.rotationDeg}`);

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
          `[COMPOSITE] signature debug | payee=${endorsement.payee_name} | method=${endorsement.signature_method ?? "unknown"} | source=${describeSignatureRef(finalSignatureRef) ?? "typed-only"} | loaded=${signatureAssetLoaded}`,
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
      return lc.includes("freedom") || lc.includes("carletta") || lc.includes(companyName.toLowerCase());
    };

    const hasRenderableSignature = (endorsement: EndorsementRecord) => {
      const method = (endorsement.signature_method ?? "").toLowerCase();
      if (method === "internal" || method === "manual") return false;
      return Boolean(endorsement.resolvedSignatureImageUrl || endorsement.typedSignatureText);
    };

    const renderableEndorsements = resolvedEndorsements.filter(hasRenderableSignature);
    if (!renderableEndorsements.length && !appliedOverride.showPayToOrder) {
      return await restoreOriginalBackImage(
        supabase,
        checkId,
        check.back_image_path,
        backImagePath,
        "no_renderable_signatures",
      );
    }

    const clientEndorsements = renderableEndorsements.filter((e) => !isFreedomOrCarletta(e.payee_name));
    const companyEndorsements = renderableEndorsements.filter((e) => isFreedomOrCarletta(e.payee_name));
    const visibleCompanySignature = companyEndorsements[0];

    // ── Auto-fit layout — real bank endorsement zone ──
    const zoneTop = Math.floor(imgHeight * ZONE_TOP_PCT);
    const zoneBottom = Math.floor(imgHeight * ZONE_BOTTOM_PCT);
    const zoneHeight = zoneBottom - zoneTop;

    console.log("[COMPOSITE] appliedOverride", appliedOverride);

    let measured = fitLayout(renderableEndorsements.length, zoneHeight, appliedOverride.scale);
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

    // If still overflowing, iteratively reduce scale until the block fits the zone.
    // Caps at 0.5 to avoid unreadably small endorsements; if it still doesn't fit
    // there, we accept the smallest size and let the overflow check below decide.
    let safetyIters = 0;
    while (blockBottom > zoneBottom && (measured.scale ?? 1) > 0.5 && safetyIters < 40) {
      const adjustedScale = Math.max(0.5, (measured.scale ?? 1) - 0.05);
      measured = fitLayout(renderableEndorsements.length, zoneHeight, adjustedScale);
      blockHeight = measured.estimatedHeight;
      blockCenterY = Math.max(
        zoneTop + blockHeight / 2,
        Math.min(zoneBottom - blockHeight / 2, blockCenterY)
      );
      blockTop = Math.round(blockCenterY - blockHeight / 2);
      blockBottom = blockTop + blockHeight;
      safetyIters += 1;
    }
    if (safetyIters > 0) {
      console.log("[COMPOSITE] auto-shrunk scale to fit zone", {
        finalScale: measured.scale,
        iterations: safetyIters,
        originalScale: appliedOverride.scale,
      });
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
      signerCount: renderableEndorsements.length,
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
    // If we downscaled, the bytes are always JPEG; otherwise honor the source extension.
    const mimeType = downscaled.downscaled
      ? "image/jpeg"
      : backImagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

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
    if (appliedOverride.showPayToOrder) {
      if (compactText) {
        endorsementSvg += svgText(localCenterX, curY + fontSize, fontSize, "#111111", "bold", `Pay to ${companyName}`);
        curY += fontSize + fitLineGap;
        endorsementSvg += svgText(localCenterX, curY + fontSize, fontSize, "#111111", "bold", "Mobile Deposit Only");
        curY += fontSize + fitLineGap;
      } else {
        endorsementSvg += svgText(localCenterX, curY + fontSize, fontSize, "#111111", "bold", "Pay to the order of");
        curY += fontSize + fitLineGap;
        endorsementSvg += svgText(localCenterX, curY + companyFont, companyFont, "#111111", "bold", companyName);
        curY += companyFont + fitLineGap;
        endorsementSvg += svgText(localCenterX, curY + fontSize, fontSize, "#111111", "bold", "For Mobile Deposit Only");
        curY += fontSize + fitLineGap;
      }
    }

    if (appliedOverride.showPayToOrder || clientEndorsements.length > 0 || visibleCompanySignature) {
      endorsementSvg += `<line x1="0" y1="${curY}" x2="${blockWidth}" y2="${curY}" stroke="#111111" stroke-width="2" opacity="0.3"/>`;
      curY += sectionGap;
    }

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
          // Bake userScale into signature width (fitSigHeight is already baked)
          const baseSigWidth = Math.min(colWidth - 20, Math.round(imgHeight * 0.10));
          const sigWidth = Math.round(baseSigWidth * appliedOverride.scale);
          console.log(`[COMPOSITE][SIG-IMG] payee=${endorsement.payee_name} | baseSigWidth=${baseSigWidth} | bakedSigWidth=${sigWidth} | bakedSigHeight=${fitSigHeight} | userScale=${appliedOverride.scale}`);
          const sigFilterId = `blackInk_${endorsement.id.replace(/[^a-zA-Z0-9]/g, "")}`;
          endorsementSvg += `<defs><filter id="${sigFilterId}"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs>`;
          endorsementSvg += `<image href="${escHtml(endorsement.resolvedSignatureImageUrl)}" x="${Math.round(colCenterX - sigWidth / 2)}" y="${localY}" width="${sigWidth}" height="${fitSigHeight}" preserveAspectRatio="xMidYMid meet" filter="url(#${sigFilterId})"/>`;
          localY += fitSigHeight + fitRowGap;
        } else if (endorsement.typedSignatureText) {
          endorsementSvg += `<text x="${colCenterX}" y="${localY + byLineFont}" font-family="serif" font-size="${byLineFont}" fill="#111111" font-style="italic" text-anchor="middle">${escHtml(endorsement.typedSignatureText)}</text>`;
          localY += byLineFont + fitRowGap;
        }
        maxRowH = Math.max(maxRowH, localY - curY);
      }
      curY += maxRowH;
    }

    if (clientEndorsements.length > 0 && visibleCompanySignature) {
      curY += sectionGap;
    }

    // Footer: company + signature
    if (visibleCompanySignature) {
      endorsementSvg += svgText(localCenterX, curY + companyFont, companyFont, "#111111", "bold", companyName);
      curY += companyFont + fitLineGap;
    }

    if (visibleCompanySignature?.resolvedSignatureImageUrl) {
      const baseSigWidth = Math.min(blockWidth - 20, Math.round(imgHeight * 0.10));
      const sigWidth = Math.round(baseSigWidth * appliedOverride.scale);
      console.log(`[COMPOSITE][SIG-IMG-CO] bakedSigWidth=${sigWidth} | bakedSigHeight=${fitSigHeight} | userScale=${appliedOverride.scale}`);
      const coSigFilterId = `blackInkCo_${visibleCompanySignature.id.replace(/[^a-zA-Z0-9]/g, "")}`;
      endorsementSvg += `<defs><filter id="${coSigFilterId}"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs>`;
      endorsementSvg += `<image href="${escHtml(visibleCompanySignature.resolvedSignatureImageUrl)}" x="${Math.round(localCenterX - sigWidth / 2)}" y="${curY}" width="${sigWidth}" height="${fitSigHeight}" preserveAspectRatio="xMidYMid meet" filter="url(#${coSigFilterId})"/>`;
      curY += fitSigHeight + fitLineGap;
    } else if (visibleCompanySignature?.typedSignatureText) {
      endorsementSvg += `<text x="${localCenterX}" y="${curY + byLineFont}" font-family="serif" font-size="${byLineFont}" fill="#111111" font-style="italic" text-anchor="middle">${escHtml(companyName)}</text>`;
      curY += byLineFont + fitLineGap;
    }

    // ── Single placement transform: center-origin with rotation + scale ──
    const blockCenterX = Math.round(appliedOverride.xPct * imgWidth);
    const finalBlockWidth = blockWidth;
    const finalBlockHeight = Math.max(blockHeight, Math.ceil(curY));
    const scaleVal = 1; // scale is baked into font/signature sizes — no SVG transform needed
    const rotDeg = appliedOverride.rotationDeg || 0;

    const endorsementTransform = [
      `translate(${blockCenterX} ${blockCenterY})`,
      `rotate(${rotDeg})`,
      `translate(${-Math.round(finalBlockWidth / 2)} ${-Math.round(finalBlockHeight / 2)})`,
    ].join(" ");

    console.log("[COMPOSITE] final placement", {
      blockCenterX,
      blockCenterY,
      finalBlockWidth,
      finalBlockHeight,
      rotationDeg: rotDeg,
      userScale: appliedOverride.scale,
      bakedFontSize: measured.fontSize,
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

  const { error: updateErr } = await supabase
    .from("check_intake_items")
    .update({
      back_image_path: compositePath,
      updated_at: new Date().toISOString(),
    })
    .eq("id", checkId);

  if (updateErr) {
    throw new Error(`Failed to update check back image path: ${updateErr.message}`);
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
        signature_source: describeSignatureRef(e.finalSignatureRef),
        signature_asset_loaded: e.signatureAssetLoaded,
        typed_fallback_used: Boolean(e.typedSignatureText),
      })),
      db_path_update_committed: true,
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
    db_path_update_committed: true,
  });
}

async function restoreOriginalBackImage(
  supabase: any,
  checkId: string,
  currentBackImagePath: string,
  originalBackImagePath: string,
  reason: string,
) {
  const shouldUpdatePath = currentBackImagePath !== originalBackImagePath;

  if (shouldUpdatePath) {
    const { error: updateErr } = await supabase
      .from("check_intake_items")
      .update({
        back_image_path: originalBackImagePath,
        updated_at: new Date().toISOString(),
      })
      .eq("id", checkId);

    if (updateErr) {
      throw new Error(`Failed to restore original back image path: ${updateErr.message}`);
    }
  }

  await supabase.from("check_audit_log").insert({
    check_id: checkId,
    event_type: "endorsement_composite_cleared",
    event_description: "Restored original back image because no visible endorsement signatures remained",
    event_data: {
      previous_back_image_path: currentBackImagePath,
      restored_back_image_path: originalBackImagePath,
      reason,
      db_path_update_committed: shouldUpdatePath,
    },
  });

  console.log(`[COMPOSITE] restored original back image path: ${originalBackImagePath}`);

  return jsonResp({
    success: true,
    skipped: true,
    reason,
    original_back_image_path: originalBackImagePath,
    endorsed_back_image_path: originalBackImagePath,
    composited_path: originalBackImagePath,
    output_format: "restored_original",
    db_path_update_committed: shouldUpdatePath,
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
  if (signatureRef.startsWith("data:image/")) {
    const parsed = parseImageDataUrl(signatureRef);
    if (!parsed) return signatureRef;
    return (await maybeNormalizeSignatureDataUrl(parsed.bytes, parsed.contentType)).dataUrl;
  }

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

  if (!blob) throw new Error(`Signature asset was empty: ${signatureRef}`);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const contentType = blob.type || inferImageContentType(signatureRef);
  return (await maybeNormalizeSignatureDataUrl(bytes, contentType)).dataUrl;
}

function parseImageDataUrl(value: string): { contentType: string; bytes: Uint8Array } | null {
  const match = value.match(/^data:(image\/[^;,]+);base64,(.+)$/s);
  if (!match) return null;

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return { contentType: match[1], bytes };
}

function describeSignatureRef(value: string | null | undefined) {
  if (!value) return null;
  if (value.startsWith("data:image/")) return "inline-data-url";
  if (isHttpUrl(value)) return "remote-url";
  return value;
}

function inferImageContentType(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function recoverOriginalBackImagePath(supabase: any, endorsedPath: string): Promise<string | null> {
  const { directory, fileName } = splitStoragePath(endorsedPath);
  const originalBaseName = stripEndorsedSuffix(fileName);

  if (!originalBaseName || originalBaseName === fileName) {
    return null;
  }

  const { data: siblingFiles, error } = await supabase.storage
    .from("claim-files")
    .list(directory, {
      limit: 100,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) {
    console.warn(`[COMPOSITE] failed to inspect sibling files for original back image recovery: ${error.message}`);
    return null;
  }

  const candidates = (siblingFiles ?? [])
    .map((entry: { name?: string | null }) => entry.name ?? "")
    .filter((name: string) => Boolean(name) && !name.includes("/") && !/_endorsed(?:_\d+)?\.[^.]+$/i.test(name))
    .filter((name: string) => stripFileExtension(name) === originalBaseName)
    .sort((a: string, b: string) => fileExtensionPriority(a) - fileExtensionPriority(b));

  if (!candidates.length) {
    console.warn(`[COMPOSITE] could not infer original back image from endorsed path: ${endorsedPath}`);
    return null;
  }

  const recoveredPath = joinStoragePath(directory, candidates[0]);
  console.log(`[COMPOSITE] recovered original back image path via storage listing: ${recoveredPath}`);
  return recoveredPath;
}

function splitStoragePath(path: string) {
  const normalized = path.replace(/^\/+/, "");
  const lastSlashIndex = normalized.lastIndexOf("/");
  if (lastSlashIndex === -1) {
    return { directory: "", fileName: normalized };
  }

  return {
    directory: normalized.slice(0, lastSlashIndex),
    fileName: normalized.slice(lastSlashIndex + 1),
  };
}

function joinStoragePath(directory: string, fileName: string) {
  return directory ? `${directory}/${fileName}` : fileName;
}

function stripEndorsedSuffix(fileName: string) {
  return fileName.replace(/_endorsed(?:_\d+)?\.[^.]+$/i, "");
}

function stripFileExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function fileExtensionPriority(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const priority = ["jpg", "jpeg", "png", "webp", "svg"];
  const index = priority.indexOf(ext);
  return index === -1 ? priority.length : index;
}
