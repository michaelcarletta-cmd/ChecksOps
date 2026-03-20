import React from "react";
import { ClaimPhotoGrid } from "@/components/photos/ClaimPhotoGrid";
import { ClaimPhotoUploader } from "@/components/photos/ClaimPhotoUploader";
import { useClaimPhotos } from "@/hooks/useClaimPhotos";

type ClaimPhotosTabProps = {
  claimId: string;
};

export default function ClaimPhotosTab({ claimId }: ClaimPhotosTabProps) {
  const { data: photos = [], isLoading, refetch } = useClaimPhotos(claimId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">Photos</h3>
        <ClaimPhotoUploader claimId={claimId} onUploaded={() => refetch()} />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-[4/3] rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : (
        <ClaimPhotoGrid photos={photos} />
      )}
    </div>
  );
}
