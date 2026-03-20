export type ImageSizePreset = "thumb" | "card" | "modal" | "full";

export function buildOptimizedImageUrl(
  publicUrl: string,
  preset: ImageSizePreset = "card"
) {
  const url = new URL(publicUrl);

  switch (preset) {
    case "thumb":
      url.searchParams.set("width", "240");
      url.searchParams.set("quality", "45");
      break;
    case "card":
      url.searchParams.set("width", "480");
      url.searchParams.set("quality", "55");
      break;
    case "modal":
      url.searchParams.set("width", "1280");
      url.searchParams.set("quality", "68");
      break;
    case "full":
      url.searchParams.set("width", "1800");
      url.searchParams.set("quality", "78");
      break;
  }

  url.searchParams.set("format", "origin");
  return url.toString();
}
