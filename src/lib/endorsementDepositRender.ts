/**
 * Client-side flattener that turns the original back-of-check image plus the
 * received signatures into a real raster JPEG that CheckAlt can consume.
 *
 * We do the render in the browser (canvas) instead of an edge function so we
 * never hit the memory ceiling that caused the previous "non-2xx" errors —
 * the browser has plenty of RAM to decode a 4MB phone photo. The output is a
 * flat JPEG blob that can be uploaded straight to storage.
 */
import {
  EndorsementOverride,
  clampEndorsementOverride,
} from "@/lib/endorsementLayout";
import { fitEndorsementLayout } from "@/lib/endorsementFit";

export const ENDORSEMENT_RENDERER_VERSION = "canvas-v2";

// Must match constants in EndorsementAdjuster.tsx preview.
export const ZONE_TOP_PCT = 0.15;
export const ZONE_BOTTOM_PCT = 0.92;
export const ENDORSEMENT_WIDTH_PCT = 0.22;
const MAX_LONG_EDGE = 1200;

export interface SignatureAsset {
  id: string;
  payee_name: string;
  signature_image_url: string | null;
  signature_method: string | null;
}

export interface DepositRenderInput {
  originalImageUrl: string;
  /**
   * Optional callback that returns a freshly-signed URL for the original back
   * image. If provided, the renderer will call it whenever the current URL
   * fails to fetch (e.g. signed-URL token expired) and retry the download.
   * This makes generation resilient to any TTL — nothing "expires" from the
   * user's perspective.
   */
  refreshOriginalUrl?: () => Promise<string | null>;
  override: EndorsementOverride;
  companyName: string;
  clientSignatures: SignatureAsset[];
  companySignature: SignatureAsset | null;
}

export interface DepositRenderResult {
  blob: Blob;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  bytes: number;
  rendererVersion: string;
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error(`Failed to fetch image ${url} (${res.status})`);
  return await res.blob();
}

async function decodeBlobToImage(blob: Blob, label: string): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to decode image ${label}`));
      img.src = objectUrl;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}

async function loadImage(
  url: string,
  refresh?: () => Promise<string | null>,
): Promise<HTMLImageElement> {
  // Fetch as a Blob first and load via object URL. This sidesteps the
  // "tainted cache" trap where a prior non-CORS <img> load poisons the
  // cache for subsequent crossOrigin fetches.
  try {
    const blob = await fetchAsBlob(url);
    return await decodeBlobToImage(blob, url);
  } catch (fetchErr) {
    // If the caller can re-mint the URL (signed-URL expiry), try once more
    // with a fresh one before giving up. Nothing should ever "expire" from
    // the user's perspective — they just click Generate.
    if (refresh) {
      try {
        const fresh = await refresh();
        if (fresh && fresh !== url) {
          const blob = await fetchAsBlob(fresh);
          return await decodeBlobToImage(blob, fresh);
        }
      } catch (refreshErr) {
        console.warn("[endorsementDepositRender] refresh retry failed", refreshErr);
      }
    }
    // Fallback to a direct crossOrigin <img> request in case fetch is
    // blocked for some exotic reason.
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(
          new Error(
            `Failed to load image ${url}: ${(fetchErr as Error)?.message ?? "unknown"}`,
          ),
        );
      img.src = url;
    });
  }
}

function fitLongEdge(w: number, h: number, target = MAX_LONG_EDGE) {
  const longest = Math.max(w, h);
  if (longest <= target) return { width: w, height: h };
  const r = target / longest;
  return { width: Math.round(w * r), height: Math.round(h * r) };
}

/**
 * CheckAlt's "Endorsement Presence" OCR scores ink density on the back image.
 * Anti-aliased pen strokes from the signature pad often land as light grey,
 * which scored a 1 against their 750 threshold. This re-inks any non-white
 * pixel to solid black at full alpha (geometry untouched) so the endorsement
 * reads as real ink.
 */
function inkifySignature(
  img: HTMLImageElement,
  drawW: number,
  drawH: number,
): CanvasImageSource {
  try {
    const w = Math.max(1, Math.round(drawW));
    const h = Math.max(1, Math.round(drawH));
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const octx = off.getContext("2d", { willReadFrequently: true });
    if (!octx) return img;
    octx.drawImage(img, 0, 0, w, h);
    const data = octx.getImageData(0, 0, w, h);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a < 24) {
        px[i + 3] = 0;
        continue;
      }
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (lum > 225) {
        // treat near-white as background
        px[i + 3] = 0;
        continue;
      }
      px[i] = 0;
      px[i + 1] = 0;
      px[i + 2] = 0;
      px[i + 3] = 255;
    }
    octx.putImageData(data, 0, 0);
    return off;
  } catch {
    return img;
  }
}

/**
 * Draws the endorsement block (pay-to text + client signatures + company sig)
 * around (0,0) at natural size, returns the block's bounding box height so
 * caller can center vertically.
 */

async function drawEndorsementBlock(
  ctx: CanvasRenderingContext2D,
  input: DepositRenderInput,
  blockWidth: number,
  fontSize: number,
  lineGap: number,
  rowGap: number,
  sigHeight: number,
  columns: 1 | 2,
  showPayToOrder: boolean,
  signatureBoxWidths: {
    client: number;
    company: number;
  },
): Promise<void> {
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  let cy = 0;
  const centerX = blockWidth / 2;

  if (showPayToOrder) {
    ctx.font = `600 ${fontSize}px Arial, sans-serif`;
    ctx.fillText("Pay to the order of", centerX, cy);
    cy += fontSize + lineGap;
    ctx.font = `700 ${Math.round(fontSize * 1.2)}px Arial, sans-serif`;
    ctx.fillText(input.companyName, centerX, cy);
    cy += Math.round(fontSize * 1.2) + lineGap;
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
    ctx.fillText("For Mobile Deposit Only", centerX, cy);
    cy += fontSize + rowGap;
  }

  // Client signatures
  const clientSigs = input.clientSignatures;
  const colWidth = columns === 2 ? blockWidth / 2 : blockWidth;
  for (let i = 0; i < clientSigs.length; i += columns) {
    const rowStart = cy;
    let rowMaxCy = cy;
    for (let c = 0; c < columns && i + c < clientSigs.length; c++) {
      const sig = clientSigs[i + c];
      const colCenterX = columns === 2 ? colWidth / 2 + c * colWidth : centerX;
      let subCy = rowStart;

      ctx.font = `700 ${fontSize}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(sig.payee_name, colCenterX, subCy);
      subCy += fontSize + lineGap * 0.5;

      const url = sig.signature_image_url ?? "";
      if (url && !url.startsWith("typed:")) {
        try {
          const img = await loadImage(url);
          const aspect = img.naturalWidth / img.naturalHeight || 3;
          const drawW = Math.min(signatureBoxWidths.client, sigHeight * aspect);
          const drawH = drawW / aspect;
          ctx.drawImage(
            inkifySignature(img, drawW, drawH),
            colCenterX - drawW / 2,
            subCy + Math.max(0, (sigHeight - drawH) / 2),
            drawW,
            drawH,
          );

          subCy += sigHeight + rowGap;
        } catch {
          // Fall back to typed name if image fails to load
          ctx.font = `italic 500 ${fontSize}px "Brush Script MT", cursive`;
          ctx.fillText(sig.payee_name, colCenterX, subCy);
          subCy += fontSize + rowGap;
        }
      } else {
        const typed = url.startsWith("typed:") ? url.slice(6) : sig.payee_name;
        ctx.font = `italic 500 ${fontSize}px "Brush Script MT", cursive`;
        ctx.fillText(typed, colCenterX, subCy);
        subCy += fontSize + rowGap;
      }
      if (subCy > rowMaxCy) rowMaxCy = subCy;
    }
    cy = rowMaxCy;
  }

  // Company signature at bottom
  if (input.companySignature) {
    ctx.font = `700 ${Math.round(fontSize * 1.2)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(input.companyName, centerX, cy);
    cy += Math.round(fontSize * 1.2) + lineGap;

    const url = input.companySignature.signature_image_url ?? "";
    if (url && !url.startsWith("typed:")) {
      try {
        const img = await loadImage(url);
        const aspect = img.naturalWidth / img.naturalHeight || 3;
        const drawW = Math.min(signatureBoxWidths.company, sigHeight * aspect);
        const drawH = drawW / aspect;
        ctx.drawImage(
          img,
          centerX - drawW / 2,
          cy + Math.max(0, (sigHeight - drawH) / 2),
          drawW,
          drawH,
        );
      } catch {
        ctx.font = `italic 500 ${fontSize}px "Brush Script MT", cursive`;
        ctx.fillText(input.companyName, centerX, cy);
      }
    } else {
      ctx.font = `italic 500 ${fontSize}px "Brush Script MT", cursive`;
      ctx.fillText(input.companyName, centerX, cy);
    }
  }
}

function estimateBlockHeight(
  input: DepositRenderInput,
  fontSize: number,
  lineGap: number,
  rowGap: number,
  sigHeight: number,
  columns: 1 | 2,
  showPayToOrder: boolean,
): number {
  let h = 0;
  if (showPayToOrder) {
    h += fontSize + lineGap;
    h += Math.round(fontSize * 1.2) + lineGap;
    h += fontSize + rowGap;
  }
  const rows = Math.ceil(input.clientSignatures.length / columns) || 0;
  h += rows * (fontSize + lineGap * 0.5 + sigHeight + rowGap);
  if (input.companySignature) {
    h += Math.round(fontSize * 1.2) + lineGap + sigHeight;
  }
  return h;
}

/**
 * Flattens the back-of-check + endorsements into a JPEG blob. Caller uploads
 * the returned blob to storage — this function does no network writes.
 */
export async function renderDepositImage(
  input: DepositRenderInput,
): Promise<DepositRenderResult> {
  const override = clampEndorsementOverride({
    ...input.override,
    xPct: input.override.xPct,
    yPct: input.override.yPct,
    scale: input.override.scale,
    rotationDeg: input.override.rotationDeg,
    showPayToOrder: input.override.showPayToOrder,
  });

  const backImg = await loadImage(input.originalImageUrl, input.refreshOriginalUrl);
  const natW = backImg.naturalWidth || backImg.width;
  const natH = backImg.naturalHeight || backImg.height;

  // Downscale to a sane output size so upload stays small and CheckAlt is happy.
  const { width: outW, height: outH } = fitLongEdge(natW, natH);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Solid white base — JPEG has no transparency, avoids black background on
  // any transparent source PNGs.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(backImg, 0, 0, outW, outH);

  // Layout — measure against the NATURAL image size (what the preview uses),
  // then scale all pixel dimensions by outH/natH so the final render matches
  // exactly what the user saw in the adjuster preview. Previously the preset
  // was computed on the downscaled output, causing text/signatures to render
  // much larger relative to the check than they appeared in the preview.
  const signerCount = Math.max(1, input.clientSignatures.length);
  const naturalSafeZoneHeightPx = (ZONE_BOTTOM_PCT - ZONE_TOP_PCT) * natH;
  const naturalPreset = fitEndorsementLayout({
    signerCount,
    zoneHeightPx: naturalSafeZoneHeightPx,
    requestedScale: override.scale || 1,
  });

  const renderScale = outH / natH;
  const preset = {
    ...naturalPreset,
    fontSize: naturalPreset.fontSize * renderScale,
    lineGap: naturalPreset.lineGap * renderScale,
    rowGap: naturalPreset.rowGap * renderScale,
    signatureHeight: naturalPreset.signatureHeight * renderScale,
  };

  const blockWidth = outW * ENDORSEMENT_WIDTH_PCT * (override.scale || 1);
  // Match the DOM preview exactly: signature images live inside a fixed
  // contain box whose width is capped by 10% of image height, then scaled by
  // the user control. The old renderer used `sigHeight * aspect`, which made
  // wide signature PNGs much larger in the generated JPEG than the preview.
  const unscaledBlockWidth = outW * ENDORSEMENT_WIDTH_PCT;
  const unscaledColumnWidth = preset.columns === 2 ? unscaledBlockWidth / 2 : unscaledBlockWidth;
  const naturalToOutputScale = outH / natH;
  const signatureScale = override.scale || 1;
  const signatureBoxWidths = {
    client:
      Math.min(
        Math.max(0, unscaledColumnWidth - 20 * naturalToOutputScale),
        outH * 0.1,
      ) * signatureScale,
    company:
      Math.min(
        Math.max(0, unscaledBlockWidth - 20 * naturalToOutputScale),
        outH * 0.1,
      ) * signatureScale,
  };
  const blockHeight = estimateBlockHeight(
    input,
    preset.fontSize,
    preset.lineGap,
    preset.rowGap,
    preset.signatureHeight,
    preset.columns,
    override.showPayToOrder,
  );

  // Convert normalized coords to output pixels — X is full-image, Y is safe-zone-relative.
  const safeZoneTopPx = ZONE_TOP_PCT * outH;
  const safeZoneHeightPx = (ZONE_BOTTOM_PCT - ZONE_TOP_PCT) * outH;
  const centerX = override.xPct * outW;
  let centerY = safeZoneTopPx + override.yPct * safeZoneHeightPx;

  // Clamp so the rotated block bounding-box stays inside the safe zone.
  const safeZoneBottomPx = ZONE_BOTTOM_PCT * outH;
  const halfH = blockHeight / 2;
  centerY = Math.max(safeZoneTopPx + halfH, Math.min(safeZoneBottomPx - halfH, centerY));

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(((override.rotationDeg || 0) * Math.PI) / 180);
  ctx.translate(-blockWidth / 2, -blockHeight / 2);

  await drawEndorsementBlock(
    ctx,
    input,
    blockWidth,
    preset.fontSize,
    preset.lineGap,
    preset.rowGap,
    preset.signatureHeight,
    preset.columns,
    override.showPayToOrder,
    signatureBoxWidths,
  );

  ctx.restore();

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob returned null"))),
      "image/jpeg",
      0.92,
    );
  });

  return {
    blob,
    mimeType: "image/jpeg",
    width: outW,
    height: outH,
    bytes: blob.size,
    rendererVersion: ENDORSEMENT_RENDERER_VERSION,
  };
}

/**
 * Guard called before we persist a deposit image path. Ensures the file we
 * generated is really a raster JPEG/PNG so CheckAlt won't reject it (SVG
 * rejection was the root cause of the last outage).
 */
export function isAcceptedDepositMime(mime: string): boolean {
  return mime === "image/jpeg" || mime === "image/png";
}
