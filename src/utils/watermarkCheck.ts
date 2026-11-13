/**
 * Tiles a semi-transparent, rotated "VOID" across a canvas that already holds a check image.
 * Shared by the upload watermark below and the Mortgage Desk's on-screen check images
 * (owner 2026-11-13: "make sure the check images have void on it").
 */
export function drawVoidWatermark(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const fontSize = Math.max(width, height) * 0.12;
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  ctx.fillStyle = "rgba(255, 0, 0, 0.28)";
  ctx.strokeStyle = "rgba(180, 0, 0, 0.18)";
  ctx.lineWidth = Math.max(2, fontSize * 0.03);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Rotate and tile VOID across the entire surface
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-Math.PI / 6); // -30 degrees

  const stepX = fontSize * 2.2;
  const stepY = fontSize * 1.4;
  const diagonal = Math.sqrt(width ** 2 + height ** 2);

  for (let y = -diagonal; y < diagonal; y += stepY) {
    for (let x = -diagonal; x < diagonal; x += stepX) {
      ctx.strokeText("VOID", x, y);
      ctx.fillText("VOID", x, y);
    }
  }
  ctx.restore();
}

/**
 * Stamps a semi-transparent "VOID" watermark across a check image
 * to prevent fraudulent printing if the storage is compromised.
 * Returns a new File with the watermark baked in.
 */
export async function watermarkCheckImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(file); return; }

        // Draw original image, then the VOID watermark tiled across it
        ctx.drawImage(img, 0, 0);
        drawVoidWatermark(ctx, img.width, img.height);

        // Convert back to file
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return; }
            const watermarked = new File([blob], file.name, {
              type: "image/jpeg",
              lastModified: Date.now(),
            });
            resolve(watermarked);
          },
          "image/jpeg",
          0.92,
        );
      } catch (err) {
        console.error("Watermark failed, using original:", err);
        resolve(file); // never block upload
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      console.error("Failed to load image for watermark");
      resolve(file); // graceful fallback
    };

    img.src = url;
  });
}
