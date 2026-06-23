/**
 * iPhone photos are commonly HEIC/HEIF, which most desktop browsers cannot
 * decode. If we let these through, canvas-based compression silently produces
 * a broken image, <img> tags refuse to render them, and the endorsement
 * compositor (imagescript) cannot decode them either — which is what caused
 * the Laffan check's back image to render as a messy SVG fallback.
 *
 * This helper detects HEIC/HEIF input and converts to JPEG in the browser
 * before anything downstream touches the file. Everything else (compression,
 * storage, viewer, compositor) then gets a normal JPEG.
 */

function looksLikeHeic(file: File): boolean {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return (
    type === "image/heic" ||
    type === "image/heif" ||
    type === "image/heic-sequence" ||
    type === "image/heif-sequence" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif")
  );
}

export async function convertHeicToJpegIfNeeded(file: File): Promise<File> {
  if (!file || !looksLikeHeic(file)) return file;

  try {
    // Dynamic import keeps the heic decoder out of the main bundle.
    const mod = await import("heic2any");
    const heic2any = (mod as any).default ?? (mod as any);

    const converted = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.9,
    });

    const blob: Blob = Array.isArray(converted) ? converted[0] : (converted as Blob);
    const newName = (file.name || "image").replace(/\.(heic|heif)$/i, "") + ".jpg";

    return new File([blob], newName, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } catch (err) {
    console.warn("[convertHeicToJpegIfNeeded] HEIC conversion failed, passing original file through", err);
    return file;
  }
}
