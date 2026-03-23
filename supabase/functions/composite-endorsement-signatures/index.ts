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

const BOTTOM_ZONE_LIMIT = 0.75;
const ENDORSEMENT_TOP_PCT = 0.10;
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
  check_payees?: { endorsement_image_path?: string | null } | { endorsement_image_path?: string | null }[] | null;
  resolvedSignatureImageUrl?: string | null;
  typedSignatureText?: string | null;
  finalSignatureRef?: string | null;
  signatureAssetLoaded?: boolean;
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

    const { data: endorsements, error: endErr } = await supabase
      .from("check_endorsements")
      .select("id, payee_name, payee_type, status, signed_at, signature_image_url, signature_method, check_payees!check_endorsements_payee_id_fkey(endorsement_image_path)")
      .eq("check_id", checkId)
      .in("status", ["signed", "waived"])
      .order("created_at", { ascending: true });

    if (endErr) throw new Error(`Failed to load endorsements: ${endErr.message}`);
    if (!endorsements?.length) {
      console.log("[COMPOSITE] No signed endorsements to composite");
      return jsonResp({ success: true, skipped: true, reason: "no_endorsements" });
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
      yPct: rawOverride?.yPct ?? ENDORSEMENT_TOP_PCT,
      scale: rawOverride?.scale ?? 1,
      rotationDeg: rawOverride?.rotationDeg ?? 0,
    };
    console.log(`[COMPOSITE] applying override: ${JSON.stringify(appliedOverride)}`);

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
          `[COMPOSITE] signature debug | payee=${endorsement.payee_name} | method=${endorsement.signature_method ?? "unknown"} | client/owner source=${finalSignatureRef ?? "typed-only"} | asset loaded=${signatureAssetLoaded}`,
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

    console.log(`[COMPOSITE] client signature path/url: ${JSON.stringify(clientEndorsements.map((e) => ({ payee: e.payee_name, source: e.finalSignatureRef, method: e.signature_method, loaded: e.signatureAssetLoaded })) )}`);
    console.log(`[COMPOSITE] owner signature path/url: ${JSON.stringify(companyEndorsements.map((e) => ({ payee: e.payee_name, source: e.finalSignatureRef, method: e.signature_method, loaded: e.signatureAssetLoaded })) )}`);

    const maxEndorsementY = Math.floor(imgHeight * BOTTOM_ZONE_LIMIT);
    const pixelCount = imgWidth * imgHeight;
    const originalBase64 = uint8ToBase64(originalBytes);
    const mimeType = backImagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    const ezLeftPad = Math.round(imgWidth * appliedOverride.xPct);
    const ezTopPad = Math.round(imgHeight * appliedOverride.yPct);
    const ezContentWidth = Math.round(imgWidth * ENDORSEMENT_WIDTH_PCT * appliedOverride.scale);

    const baseFont = Math.max(8, Math.round(imgHeight * 0.013 * appliedOverride.scale));
    const headerFont = Math.max(8, Math.round(baseFont * 0.9));
    const companyFont = Math.max(9, Math.round(baseFont * 1.2));
    const bodyFont = Math.max(8, Math.round(baseFont * 0.95));
    const byLineFont = Math.max(8, Math.round(baseFont * 1.0));
    const sigHeight = Math.max(14, Math.round(baseFont * 2.2));
    const lineGap = Math.max(2, Math.round(baseFont * 0.4));
    const sectionGap = Math.max(3, Math.round(baseFont * 0.8));

    let endorsementSvg = "";
    const centerX = ezLeftPad + Math.round(ezContentWidth / 2);
    let curY = ezTopPad;

    // Compute center of endorsement block for center-origin rotation
    const endorsementCenterX = ezLeftPad + Math.round(ezContentWidth / 2);
    const endorsementCenterY = ezTopPad + Math.round((imgHeight * 0.22 * appliedOverride.scale) / 2);
    const rotationTransform = appliedOverride.rotationDeg !== 0
      ? `transform="rotate(${appliedOverride.rotationDeg}, ${endorsementCenterX}, ${endorsementCenterY})"`
      : "";

    endorsementSvg += svgText(centerX, curY + headerFont, headerFont, "#111111", "bold", "Pay to the order of");
    curY += headerFont + lineGap;
    endorsementSvg += svgText(centerX, curY + companyFont, companyFont, "#111111", "bold", "Freedom Adjustment");
    curY += companyFont + lineGap;
    endorsementSvg += svgText(centerX, curY + bodyFont, bodyFont, "#111111", "bold", "For Mobile Deposit Only");
    curY += bodyFont + sectionGap;
    endorsementSvg += `<line x1="${ezLeftPad}" y1="${curY}" x2="${ezLeftPad + ezContentWidth}" y2="${curY}" stroke="#111111" stroke-width="2" opacity="0.3"/>`;
    curY += sectionGap;

    for (const endorsement of clientEndorsements) {
      if (endorsement.resolvedSignatureImageUrl) {
        endorsementSvg += svgText(centerX, curY + byLineFont, byLineFont, "#111111", "normal", endorsement.payee_name);
        curY += byLineFont + lineGap;
        const sigWidth = Math.min(ezContentWidth - 20, Math.round(imgHeight * 0.10));
        const sigFilterId = `blackInk_${endorsement.id.replace(/[^a-zA-Z0-9]/g, "")}`;
        endorsementSvg += `<defs><filter id="${sigFilterId}"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs>`;
        endorsementSvg += `<image href="${escHtml(endorsement.resolvedSignatureImageUrl)}" x="${centerX - sigWidth / 2}" y="${curY}" width="${sigWidth}" height="${sigHeight}" preserveAspectRatio="xMidYMid meet" filter="url(#${sigFilterId})"/>`;
        curY += sigHeight + lineGap;
      } else if (endorsement.typedSignatureText) {
        endorsementSvg += `<text x="${centerX}" y="${curY + byLineFont}" font-family="serif" font-size="${byLineFont}" fill="#111111" font-style="italic" text-anchor="middle">${escHtml(endorsement.typedSignatureText)}</text>`;
        curY += byLineFont + lineGap;
      } else if (endorsement.status === "waived") {
        endorsementSvg += svgText(centerX, curY + bodyFont, bodyFont, "#111111", "normal", `${endorsement.payee_name} — Waived`, "italic");
        curY += bodyFont + lineGap;
      } else {
        endorsementSvg += svgText(centerX, curY + byLineFont, byLineFont, "#111111", "normal", endorsement.payee_name);
        curY += byLineFont + lineGap;
      }
      curY += sectionGap;
    }

    curY += sectionGap;
    endorsementSvg += svgText(centerX, curY + companyFont, companyFont, "#111111", "bold", "Freedom Adjustment");
    curY += companyFont + lineGap;
    endorsementSvg += svgText(centerX, curY + byLineFont, byLineFont, "#111111", "normal", "By: Michael Carletta");
    curY += byLineFont + lineGap;

    const companySignature = companyEndorsements.find((e) => e.resolvedSignatureImageUrl || e.typedSignatureText);
    if (companySignature?.resolvedSignatureImageUrl) {
      const sigWidth = Math.min(ezContentWidth - 20, Math.round(imgHeight * 0.10));
      const coSigFilterId = `blackInkCo_${companySignature.id.replace(/[^a-zA-Z0-9]/g, "")}`;
      endorsementSvg += `<defs><filter id="${coSigFilterId}"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs>`;
      endorsementSvg += `<image href="${escHtml(companySignature.resolvedSignatureImageUrl)}" x="${centerX - sigWidth / 2}" y="${curY}" width="${sigWidth}" height="${sigHeight}" preserveAspectRatio="xMidYMid meet" filter="url(#${coSigFilterId})"/>`;
      curY += sigHeight + lineGap;
    } else if (companySignature?.typedSignatureText) {
      endorsementSvg += `<text x="${centerX}" y="${curY + byLineFont}" font-family="serif" font-size="${byLineFont}" fill="#111111" font-style="italic" text-anchor="middle">${escHtml(companySignature.typedSignatureText)}</text>`;
      curY += byLineFont + lineGap;
    }

    if (curY > maxEndorsementY) {
      const msg = `SAFETY REJECTION: Endorsement block extends to Y=${curY} which exceeds the bank restricted zone limit at Y=${maxEndorsementY}`;
      console.error(`[COMPOSITE] ${msg}`);
      return jsonResp({ success: false, error: msg, safety_rejected: true, endorsement_bottom_y: curY, max_allowed_y: maxEndorsementY, image_height: imgHeight }, 400);
    }

    if (ezLeftPad + ezContentWidth > imgWidth) {
      const msg = `SAFETY REJECTION: Endorsement width (${ezLeftPad + ezContentWidth}px) exceeds image width (${imgWidth}px).`;
      console.error(`[COMPOSITE] ${msg}`);
      return jsonResp({ success: false, error: msg, safety_rejected: true }, 400);
    }

    const compositeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}">
  <defs>
    <clipPath id="checkBounds">
      <rect x="0" y="0" width="${imgWidth}" height="${imgHeight}"/>
    </clipPath>
  </defs>
  <image href="data:${mimeType};base64,${originalBase64}" x="0" y="0" width="${imgWidth}" height="${imgHeight}" preserveAspectRatio="none"/>
  <g clip-path="url(#checkBounds)" ${rotationTransform}>
    ${endorsementSvg}
  </g>
</svg>`;

    if (pixelCount > MAX_RASTER_PIXELS || !render) {
      const reason = !render ? "resvg_unavailable" : `oversized (${pixelCount} px > ${MAX_RASTER_PIXELS})`;
      console.log(`[COMPOSITE] compositor/export succeeded via svg_fallback (${reason})`);
      return await uploadAndFinalize(
        supabase,
        backImagePath,
        checkId,
        resolvedEndorsements,
        new Blob([compositeSvg], { type: "image/svg+xml" }),
        "image/svg+xml",
        "_endorsed.svg",
        imgWidth,
        imgHeight,
        curY,
        maxEndorsementY,
        appliedOverride,
      );
    }

    try {
      const pngBytes = await render(compositeSvg);
      console.log(`[COMPOSITE] compositor/export succeeded via rasterized_png (${pngBytes.length} bytes)`);
      return await uploadAndFinalize(
        supabase,
        backImagePath,
        checkId,
        resolvedEndorsements,
        new Blob([toArrayBuffer(pngBytes)], { type: "image/png" }),
        "image/png",
        "_endorsed.png",
        imgWidth,
        imgHeight,
        curY,
        maxEndorsementY,
        appliedOverride,
      );
    } catch (renderErr) {
      console.error(`[COMPOSITE] PNG rasterization failed, falling back to SVG: ${renderErr}`);
      return await uploadAndFinalize(
        supabase,
        backImagePath,
        checkId,
        resolvedEndorsements,
        new Blob([compositeSvg], { type: "image/svg+xml" }),
        "image/svg+xml",
        "_endorsed.svg",
        imgWidth,
        imgHeight,
        curY,
        maxEndorsementY,
        appliedOverride,
      );
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[COMPOSITE] ERROR: ${msg}`);
    return jsonResp({ success: false, error: msg }, 400);
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
      endorsement_ids: endorsements.map((endorsement) => endorsement.id),
      overlay_coordinates: appliedOverride,
      image_dimensions: { width: imgWidth, height: imgHeight },
      pixel_count: pixelCount,
      endorsement_bottom_y: endorsementBottomY,
      max_allowed_y: maxAllowedY,
      output_format: renderMode,
      signature_debug: endorsements.map((endorsement) => ({
        payee_name: endorsement.payee_name,
        signature_method: endorsement.signature_method,
        signature_source: endorsement.finalSignatureRef,
        signature_asset_loaded: endorsement.signatureAssetLoaded,
        typed_fallback_used: Boolean(endorsement.typedSignatureText),
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
  console.log(`[COMPOSITE] storage upload succeeded: true`);
  console.log(`[COMPOSITE] signed URL generation succeeded: ${!signedUrlErr}`);

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
        if (bytes[offset] !== 0xFF) {
          offset++;
          continue;
        }
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
  } catch {
    // no-op
  }
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
  return isRealSignatureRef(linkedPayee?.endorsement_image_path) ? linkedPayee.endorsement_image_path : null;
}

function resolvePreferredSignatureRefs(record: EndorsementRecord) {
  const methodClass = classifySignatureMethod(record.signature_method);
  const currentSignatureRef = isRealSignatureRef(record.signature_image_url) ? record.signature_image_url : null;
  const legacyStoredSignatureRef = extractLegacyPayeeSignaturePath(record);

  const savedDrawnSignatureUrl =
    legacyStoredSignatureRef ||
    ((methodClass === "drawn" || methodClass === "unknown") && currentSignatureRef ? currentSignatureRef : null);

  const savedUploadedSignatureUrl =
    savedDrawnSignatureUrl
      ? null
      : methodClass === "uploaded" && currentSignatureRef
        ? currentSignatureRef
        : null;

  const typedSignatureText =
    !savedDrawnSignatureUrl &&
    !savedUploadedSignatureUrl &&
    isTypedSignatureRef(record.signature_image_url)
      ? record.signature_image_url.slice(6)
      : null;

  return {
    savedDrawnSignatureUrl,
    savedUploadedSignatureUrl,
    typedSignatureText,
  };
}

async function loadSignatureDataUrl(supabase: any, signatureRef: string): Promise<string | null> {
  if (signatureRef.startsWith("data:image/")) return signatureRef;

  let blob: Blob | null = null;

  if (isHttpUrl(signatureRef)) {
    const response = await fetch(signatureRef);
    if (!response.ok) {
      throw new Error(`Failed to fetch signature asset: HTTP ${response.status}`);
    }
    blob = await response.blob();
  } else {
    const { data, error } = await supabase.storage.from("claim-files").download(signatureRef);
    if (error || !data) {
      throw new Error(`Failed to download signature asset: ${error?.message ?? signatureRef}`);
    }
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
