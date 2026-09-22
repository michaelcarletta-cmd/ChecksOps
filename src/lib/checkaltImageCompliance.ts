/**
 * Browser CheckAlt FinCapture RDC API image-compliance helpers.
 * Constants must stay aligned with aws/.../checkalt-image-compliance.mjs.
 * JPEG API path only. No TIFF / ICL conversion.
 */

export const CHECKALT_IMAGE_ERROR = "CHECKALT_IMAGE_COMPLIANCE_FAILED";
export const CHECKALT_CANVAS_WIDTH = 1920;
export const CHECKALT_CANVAS_HEIGHT = 1080;
export const CHECKALT_MIN_BYTES = 25 * 1024;
export const CHECKALT_MAX_COMPLIANT_BYTES = 300 * 1024;
export const CHECKALT_ABSOLUTE_MAX_BYTES = 1024 * 1024;
export const CHECKALT_MIN_SOURCE_LONG_EDGE = 1200;
export const CHECKALT_ARTIFACT_SUFFIX = ".checkalt.jpg";
export const CHECKALT_MIN_JPEG_QUALITY = 0.5;

export const CHECKALT_PAD = {
  strategy: "contain" as const,
  fill: "#FFFFFF",
  canvasWidth: CHECKALT_CANVAS_WIDTH,
  canvasHeight: CHECKALT_CANVAS_HEIGHT,
  allowUpscale: false,
};

export const CHECKALT_OUTPUT_METADATA = {
  writeJfifDpi: false,
  dpi: 200,
  preserveCameraExif: false,
};

export const CHECKALT_VENDOR_PENDING = {
  canvasInterpretation: "exact_api_jpeg_canvas" as const,
  padStrategy: CHECKALT_PAD.strategy,
  allowUpscale: CHECKALT_PAD.allowUpscale,
  maxBytesIsHardLimit: true,
  writeJfifDpi: CHECKALT_OUTPUT_METADATA.writeJfifDpi,
  iclConversionInApiPath: false,
  objectiveReadabilityMetric: null,
};

const QUALITY_LADDER = [0.82, 0.74, 0.66, 0.58, CHECKALT_MIN_JPEG_QUALITY];

export const normalizeClaimRel = (path: string | null | undefined) =>
  String(path || "").split("?")[0].replace(/^\/+/, "").trim();

export const isCheckAltArtifactPath = (path: string | null | undefined) =>
  /\.checkalt\.jpe?g$/i.test(normalizeClaimRel(path));

export const toCheckAltPath = (path: string | null | undefined) => {
  const raw = normalizeClaimRel(path);
  if (!raw) return null;
  if (isCheckAltArtifactPath(raw)) return raw;
  if (/\.(jpe?g|png|webp|svg)$/i.test(raw)) {
    return raw.replace(/\.(jpe?g|png|webp|svg)$/i, CHECKALT_ARTIFACT_SUFFIX);
  }
  return `${raw}${CHECKALT_ARTIFACT_SUFFIX}`;
};

export type CheckAltSideReport = {
  pass: boolean;
  side: "front" | "rear";
  reason: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  prepared: boolean;
};

export type CheckAltComplianceStatus = {
  front: CheckAltSideReport;
  rear: CheckAltSideReport;
  overall: "PASS" | "FAIL";
};

export const complianceReasonFor = (
  side: "front" | "rear",
  info: { present: boolean; jpeg: boolean; width: number; height: number; bytes: number },
) => {
  if (!info.present) return `${side}_missing`;
  if (!info.jpeg) return `${side}_invalid_jpeg`;
  if (info.width !== CHECKALT_CANVAS_WIDTH || info.height !== CHECKALT_CANVAS_HEIGHT) {
    return `${side}_dimensions`;
  }
  if (info.bytes < CHECKALT_MIN_BYTES) return `${side}_too_small`;
  if (info.bytes > CHECKALT_ABSOLUTE_MAX_BYTES || info.bytes > CHECKALT_MAX_COMPLIANT_BYTES) {
    return `${side}_too_large`;
  }
  return null;
};

export const evaluateCheckAltImageCompliance = (
  info: { present: boolean; jpeg: boolean; width: number; height: number; bytes: number },
  side: "front" | "rear",
): CheckAltSideReport => {
  const reason = complianceReasonFor(side, info);
  return {
    pass: !reason,
    side,
    reason,
    width: info.width || null,
    height: info.height || null,
    bytes: info.bytes || 0,
    prepared: Boolean(info.present && info.jpeg),
  };
};

const hasJpegMagic = async (blob: Blob) => {
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
};

export async function measureBlob(blob: Blob | null | undefined) {
  if (!blob || blob.size === 0) {
    return { present: false, jpeg: false, width: 0, height: 0, bytes: 0 };
  }
  const jpeg = await hasJpegMagic(blob);
  if (!jpeg) {
    return { present: true, jpeg: false, width: 0, height: 0, bytes: blob.size };
  }
  try {
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return {
      present: true,
      jpeg: true,
      width: dims.width,
      height: dims.height,
      bytes: blob.size,
    };
  } catch {
    return { present: true, jpeg: false, width: 0, height: 0, bytes: blob.size };
  }
}

const blobToCanvas = async (blob: Blob) => {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("canvas_unavailable");
  }
  if (bitmap.height > bitmap.width) {
    canvas.width = bitmap.height;
    canvas.height = bitmap.width;
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(bitmap, 0, 0);
  } else {
    ctx.drawImage(bitmap, 0, 0);
  }
  bitmap.close?.();
  return canvas;
};

const canvasToJpeg = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("jpeg_encode_failed"))),
      "image/jpeg",
      quality,
    );
  });

export async function normalizeBlobToCheckAltCanvas(
  blob: Blob,
  pad = CHECKALT_PAD,
): Promise<{ ok: true; blob: Blob; width: number; height: number } | { ok: false; error: string; message: string }> {
  const source = await blobToCanvas(blob);
  const longest = Math.max(source.width, source.height);
  if (longest < CHECKALT_MIN_SOURCE_LONG_EDGE) {
    return {
      ok: false,
      error: "source_too_small",
      message: "Source check is too small to build a readable 1920x1080 image. Reupload a clearer photo.",
    };
  }

  let scale = Math.min(pad.canvasWidth / source.width, pad.canvasHeight / source.height);
  if (!pad.allowUpscale) scale = Math.min(1, scale);
  const drawW = Math.max(1, Math.round(source.width * scale));
  const drawH = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = pad.canvasWidth;
  canvas.height = pad.canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, error: "canvas_unavailable", message: "Could not prepare the CheckAlt image." };
  ctx.fillStyle = pad.fill;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const x = Math.floor((pad.canvasWidth - drawW) / 2);
  const y = Math.floor((pad.canvasHeight - drawH) / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, source.width, source.height, x, y, drawW, drawH);

  let last: Blob | null = null;
  for (const quality of QUALITY_LADDER) {
    if (quality < CHECKALT_MIN_JPEG_QUALITY) {
      return {
        ok: false,
        error: "quality_floor",
        message: "Minimum approved JPEG quality reached. Fail compliance rather than degrading further.",
      };
    }
    last = await canvasToJpeg(canvas, quality);
    if (last.size < CHECKALT_MIN_BYTES) {
      return {
        ok: false,
        error: "too_small",
        message: "JPEG is under 25KB at the current quality. Fail compliance rather than fabricating detail.",
      };
    }
    if (last.size <= CHECKALT_MAX_COMPLIANT_BYTES) {
      return { ok: true, blob: last, width: pad.canvasWidth, height: pad.canvasHeight };
    }
  }
  if (!last) return { ok: false, error: "encode_failed", message: "Could not encode the CheckAlt JPEG." };
  return {
    ok: false,
    error: "too_large",
    message: "Minimum approved JPEG quality still exceeds 300KB. Fail compliance rather than degrading further.",
  };
}

export const emptySide = (side: "front" | "rear"): CheckAltSideReport => ({
  pass: false,
  side,
  reason: `${side}_missing`,
  width: null,
  height: null,
  bytes: 0,
  prepared: false,
});

/** Source image exists but the official 1920×1080 `.checkalt.jpg` sibling does not. */
export const unpreparedSide = (
  side: "front" | "rear",
  bytes = 0,
): CheckAltSideReport => ({
  pass: false,
  side,
  reason: `${side}_unprepared`,
  width: null,
  height: null,
  bytes,
  prepared: false,
});

export const isRasterClaimPath = (path: string | null | undefined) =>
  !!path && /\.(jpe?g|png|webp)$/i.test(normalizeClaimRel(path));

/**
 * Official artifact missing: `_missing` only when no source bytes exist.
 * A present source is `_unprepared` — never treat that as front_missing/rear_missing.
 */
export const reportOfficialMissing = (
  side: "front" | "rear",
  sourcePresent: boolean,
  bytes = 0,
): CheckAltSideReport => (sourcePresent ? unpreparedSide(side, bytes) : emptySide(side));

export const combineCheckAltCompliance = (
  front: CheckAltSideReport,
  rear: CheckAltSideReport,
): CheckAltComplianceStatus => ({
  front,
  rear,
  overall: front.pass && rear.pass ? "PASS" : "FAIL",
});
