/**
 * Deposit-image orientation helper.
 *
 * CheckAlt/Mitek image quality analysis (IQA) requires the check to be
 * LANDSCAPE — a sideways (portrait) photo of a check fails corner detection
 * and comes back as reject code 1680 "image unreadable", even when the photo
 * looks perfectly sharp to a human.
 *
 * This rotates any portrait-oriented check image 90° clockwise so the long
 * edge becomes horizontal before we compress and submit it.
 */
export async function ensureLandscape(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) return blob;

  if (bitmap.width >= bitmap.height) {
    bitmap.close?.();
    return blob;
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.height;
  canvas.height = bitmap.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return blob;
  }

  // Rotate 90° clockwise.
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const rotated: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
  );
  return rotated ?? blob;
}
