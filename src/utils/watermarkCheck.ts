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

        // Draw original image
        ctx.drawImage(img, 0, 0);

        // Configure VOID watermark — tiled across entire image
        const fontSize = Math.max(img.width, img.height) * 0.12;
        ctx.font = `bold ${fontSize}px Arial, sans-serif`;
        ctx.fillStyle = "rgba(255, 0, 0, 0.28)";
        ctx.strokeStyle = "rgba(180, 0, 0, 0.18)";
        ctx.lineWidth = Math.max(2, fontSize * 0.03);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Rotate and tile VOID across the entire surface
        ctx.save();
        ctx.translate(img.width / 2, img.height / 2);
        ctx.rotate(-Math.PI / 6); // -30 degrees

        const stepX = fontSize * 2.2;
        const stepY = fontSize * 1.4;
        const diagonal = Math.sqrt(img.width ** 2 + img.height ** 2);

        for (let y = -diagonal; y < diagonal; y += stepY) {
          for (let x = -diagonal; x < diagonal; x += stepX) {
            ctx.strokeText("VOID", x, y);
            ctx.fillText("VOID", x, y);
          }
        }
        ctx.restore();

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
