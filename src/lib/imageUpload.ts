import imageCompression from "browser-image-compression";
import { supabase } from "@/integrations/supabase/client";
import { convertHeicToJpegIfNeeded } from "@/lib/convertHeic";

export type UploadedImageResult = {
  path: string;
  publicUrl: string;
  fileName: string;
  size: number;
};

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

export async function uploadCompressedImage(
  file: File,
  bucket: string,
  folder = "photos"
): Promise<UploadedImageResult> {
  const safeFile = await convertHeicToJpegIfNeeded(file);

  const compressed = await imageCompression(safeFile, {
    maxSizeMB: 1,
    maxWidthOrHeight: 1800,
    useWebWorker: true,
    initialQuality: 0.72,
    fileType: safeFile.type || "image/jpeg",
  });

  const originalName = compressed.name || file.name || "image.jpg";
  const ext = (originalName.split(".").pop() || "jpg").toLowerCase();
  const fileName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const path = `${folder}/${sanitizeFileName(fileName)}`;

  const { error } = await supabase.storage.from(bucket).upload(path, compressed, {
    cacheControl: "31536000",
    upsert: false,
    contentType: compressed.type || "image/jpeg",
  });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);

  return {
    path,
    publicUrl: data.publicUrl,
    fileName,
    size: compressed.size,
  };
}
