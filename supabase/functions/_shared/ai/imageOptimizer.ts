/**
 * Image optimizer for vision payloads.
 *
 * Phone cameras produce 3000–4000px JPEGs. Vision token cost scales with image
 * dimensions, so we resize before sending. Forensic analysis still gets enough
 * resolution; triage / classification gets the smallest viable size.
 *
 * Uses `imagescript` (pure Deno, no native deps).
 *
 * Cost impact: a 4000px phone photo at "high" detail can cost 5–10× a 1024px
 * photo at "low" detail for tasks where the model only needs to recognise
 * the subject (counts, classification, captioning).
 */
const IMAGESCRIPT_URL = "https://deno.land/x/imagescript@1.2.17/mod.ts";
let imagescript: any = null;
async function getImageScript() {
  if (!imagescript) imagescript = await import(IMAGESCRIPT_URL);
  return imagescript;
}

export type VisionMode = "triage" | "forensic";

export interface OptimizeResult {
  base64: string;
  mimeType: "image/jpeg";
  detail: "low" | "high";
  originalBytes: number;
  optimizedBytes: number;
  width: number;
  height: number;
  resized: boolean;
  durationMs: number;
}

const MAX_DIM: Record<VisionMode, number> = {
  triage: 1024,
  forensic: 2048,
};

const JPEG_QUALITY: Record<VisionMode, number> = {
  triage: 78,
  forensic: 88,
};

const DETAIL: Record<VisionMode, "low" | "high"> = {
  triage: "low",
  forensic: "high",
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Resize a base64 image so its longest edge ≤ MAX_DIM[mode], encode JPEG.
 * If the image is already smaller, return original bytes (still re-encoded
 * to JPEG so we get the `detail` flag right and a stable mime type).
 *
 * Returns the base64 + recommended `detail` flag for the OpenAI/Gemini
 * vision schema. Never throws — on any failure, returns the original input
 * unchanged so callers can keep working.
 */
export async function optimizeForVision(
  inputBase64: string,
  inputMime: string | undefined,
  mode: VisionMode,
): Promise<OptimizeResult> {
  const start = Date.now();
  const fallback = (reason: string): OptimizeResult => {
    if (reason) console.warn(`[imageOptimizer] fallback: ${reason}`);
    return {
      base64: inputBase64,
      mimeType: "image/jpeg",
      detail: DETAIL[mode],
      originalBytes: 0,
      optimizedBytes: 0,
      width: 0,
      height: 0,
      resized: false,
      durationMs: Date.now() - start,
    };
  };

  try {
    const bytes = base64ToBytes(inputBase64);
    const originalBytes = bytes.length;

    // Skip work for tiny inputs (< 80KB ≈ already small)
    if (originalBytes < 80_000) return fallback("input already small");

    const { Image } = await getImageScript();
    let img: any;
    try {
      img = await Image.decode(bytes);
    } catch (e) {
      return fallback(`decode failed: ${(e as Error).message}`);
    }

    const max = MAX_DIM[mode];
    const longest = Math.max(img.width, img.height);
    let resized = false;

    if (longest > max) {
      const scale = max / longest;
      const newW = Math.round(img.width * scale);
      const newH = Math.round(img.height * scale);
      img = img.resize(newW, newH);
      resized = true;
    }

    const outBytes: Uint8Array = await img.encodeJPEG(JPEG_QUALITY[mode]);
    const result: OptimizeResult = {
      base64: bytesToBase64(outBytes),
      mimeType: "image/jpeg",
      detail: DETAIL[mode],
      originalBytes,
      optimizedBytes: outBytes.length,
      width: img.width,
      height: img.height,
      resized,
      durationMs: Date.now() - start,
    };
    const ratio = result.originalBytes > 0
      ? Math.round((1 - result.optimizedBytes / result.originalBytes) * 100)
      : 0;
    console.log(
      `[imageOptimizer] mode=${mode} ${img.width}x${img.height} ` +
        `${Math.round(originalBytes / 1024)}KB → ${Math.round(result.optimizedBytes / 1024)}KB ` +
        `(-${ratio}%) detail=${result.detail} ${result.durationMs}ms`,
    );
    return result;
  } catch (e) {
    return fallback(`unexpected: ${(e as Error).message}`);
  }
}

/** Build a vision content-part block for OpenAI/Gemini chat schema. */
export function buildOptimizedImagePart(opt: OptimizeResult) {
  return {
    type: "image_url" as const,
    image_url: {
      url: `data:${opt.mimeType};base64,${opt.base64}`,
      detail: opt.detail,
    },
  };
}
