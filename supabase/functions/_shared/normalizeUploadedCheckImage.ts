// Shared server-side normalizer used at UPLOAD time (not deposit time).
//
// Goal: guarantee that no oversized check image ever lands in storage, so the
// deposit hot-path never has to re-encode a 5MB file (which is what trips the
// Deno edge "CPU Time exceeded" limit).
//
// Uploaded originals are ALWAYS preserved at "<base>.original.<ext>". The
// returned bytes/path/mime are the compressed variant that should be treated
// as the canonical *_image_path from that point on.
//
// This is deliberately independent from checkalt-prepare-image so we do not
// modify any CheckAlt image code.

import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

// Upload-time budget is looser than the CheckAlt deposit budget — it just has
// to keep bytes small enough that later processors never need to touch them.
const UPLOAD_MAX_DIM = 1600;
const UPLOAD_QUALITY = 78;
const UPLOAD_TARGET_BYTES = 700_000; // ~700KB target
const UPLOAD_HARD_MAX_BYTES = 1_100_000; // never leave a file larger than this
const MIN_DIM = 700;
const MIN_QUALITY = 45;

const COMPRESSIBLE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export interface NormalizedImage {
  bytes: Uint8Array;
  mime: string;
  compressed: boolean;
  originalBytes: number;
  finalBytes: number;
}

/**
 * Compress an image buffer to fit inside the upload budget. PDFs, HEIC and
 * anything else that can't be decoded pass through unchanged.
 */
export async function normalizeUploadedCheckImage(
  bytes: Uint8Array,
  mime: string,
): Promise<NormalizedImage> {
  const original = bytes.byteLength;
  const lower = (mime ?? "").toLowerCase();

  if (!COMPRESSIBLE_MIMES.has(lower)) {
    return { bytes, mime, compressed: false, originalBytes: original, finalBytes: original };
  }

  // Under target already — nothing to do.
  if (original <= UPLOAD_TARGET_BYTES) {
    return { bytes, mime, compressed: false, originalBytes: original, finalBytes: original };
  }

  try {
    let img = await Image.decode(bytes);
    const longest = Math.max(img.width, img.height);
    if (longest > UPLOAD_MAX_DIM) {
      const scale = UPLOAD_MAX_DIM / longest;
      img = img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
    }
    let quality = UPLOAD_QUALITY;
    let out: Uint8Array = await img.encodeJPEG(quality);

    while (out.length > UPLOAD_HARD_MAX_BYTES) {
      if (quality > MIN_QUALITY) {
        quality = Math.max(MIN_QUALITY, quality - 10);
      } else {
        const cur = Math.max(img.width, img.height);
        if (cur <= MIN_DIM) break;
        const next = Math.max(MIN_DIM, Math.round(cur * 0.8));
        const scale = next / cur;
        img = img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
      }
      out = await img.encodeJPEG(quality);
    }

    return {
      bytes: out,
      mime: "image/jpeg",
      compressed: true,
      originalBytes: original,
      finalBytes: out.length,
    };
  } catch (e) {
    // Never let compression failure block an upload — worst case the deposit
    // path's browser-side prep will handle it later.
    console.warn("[normalizeUploadedCheckImage] compression failed, using original:", (e as Error).message);
    return { bytes, mime, compressed: false, originalBytes: original, finalBytes: original };
  }
}

/**
 * Given an object path like "checks/foo/front.png", returns the sibling path
 * "<base>.original.<ext>" used to preserve the pre-compression upload.
 */
export function originalSiblingPath(objectPath: string): string {
  const m = objectPath.match(/^(.*)\.([A-Za-z0-9]+)$/);
  if (!m) return `${objectPath}.original`;
  return `${m[1]}.original.${m[2]}`;
}
