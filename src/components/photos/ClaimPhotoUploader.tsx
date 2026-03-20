import React, { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { uploadCompressedImage } from "@/lib/imageUpload";

type ClaimPhotoUploaderProps = {
  claimId: string;
  onUploaded?: () => void;
};

export function ClaimPhotoUploader({
  claimId,
  onUploaded,
}: ClaimPhotoUploaderProps) {
  const [uploading, setUploading] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;

    setUploading(true);

    try {
      for (const file of Array.from(files)) {
        const result = await uploadCompressedImage(file, "claim-photos", claimId);

        const { error } = await supabase.from("claim_photos").insert({
          claim_id: claimId,
          file_path: result.path,
          file_name: result.fileName,
          file_size: result.size,
          description: file.name,
        });

        if (error) throw error;
      }

      onUploaded?.();
    } finally {
      setUploading(false);
    }
  }

  return (
    <label className="inline-flex cursor-pointer items-center rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-accent transition-colors">
      {uploading ? "Uploading..." : "Upload photos"}
      <input
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </label>
  );
}
