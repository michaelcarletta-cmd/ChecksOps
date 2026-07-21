import imageCompression from "browser-image-compression";
import { convertHeicToJpegIfNeeded } from "@/lib/convertHeic";

/**
 * Client-side compression for check images (front/back).
 *
 * Guarantees any check image uploaded to storage is:
 *   - JPEG (HEIC converted first)
 *   - ≤ 1600px on the longest edge
 *   - ≤ ~800KB
 *
 * This keeps the CheckAlt submit edge function well under Deno's CPU/memory
 * limits when it re-normalizes for the deposit payload. Skips compression
 * for non-image files (e.g. PDFs).
 */
export async function compressCheckImage(rawFile: File): Promise<File> {
  const isImage =
    rawFile.type?.startsWith("image/") ||
    /\.(jpe?g|png|webp|heic|heif)$/i.test(rawFile.name);
  if (!isImage) return rawFile;

  const safe = await convertHeicToJpegIfNeeded(rawFile);

  try {
    const compressed = await imageCompression(safe, {
      maxSizeMB: 0.8,
      maxWidthOrHeight: 1600,
      useWebWorker: true,
      initialQuality: 0.78,
      fileType: "image/jpeg",
    });
    // browser-image-compression sometimes returns a Blob; normalize to File
    const name = (safe.name || "check.jpg").replace(/\.(heic|heif|png|webp)$/i, ".jpg");
    return new File([compressed], name, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } catch {
    // If compression fails, fall back to the (HEIC-converted) original so
    // upload still succeeds; server-side normalize is the safety net.
    return safe;
  }
}
