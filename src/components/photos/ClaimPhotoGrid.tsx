import React, { memo, useMemo, useState } from "react";
import { OptimizedImage } from "@/components/ui/OptimizedImage";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export type ClaimPhoto = {
  id: string;
  file_path: string;
  file_name: string;
  description?: string | null;
  created_at?: string | null;
};

function getPublicUrl(filePath: string): string {
  const { data } = supabase.storage.from("claim-photos").getPublicUrl(filePath);
  return data.publicUrl;
}

type ClaimPhotoGridProps = {
  photos: ClaimPhoto[];
};

const PAGE_SIZE = 24;

const PhotoCard = memo(function PhotoCard({
  photo,
  onOpen,
}: {
  photo: ClaimPhoto;
  onOpen: (photo: ClaimPhoto) => void;
}) {
  return (
    <div
      className="cursor-pointer rounded-lg overflow-hidden border border-border shadow-sm hover:shadow-md transition-shadow"
      onClick={() => onOpen(photo)}
    >
      <OptimizedImage publicUrl={getPublicUrl(photo.file_path)} alt={photo.description || "Claim photo"} preset="card" />
      {photo.description ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground truncate">
          {photo.description}
        </p>
      ) : null}
    </div>
  );
});

export function ClaimPhotoGrid({ photos }: ClaimPhotoGridProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<ClaimPhoto | null>(null);

  const visiblePhotos = useMemo(
    () => photos.slice(0, visibleCount),
    [photos, visibleCount]
  );

  const canLoadMore = visibleCount < photos.length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {visiblePhotos.map((photo) => (
          <PhotoCard key={photo.id} photo={photo} onOpen={setSelected} />
        ))}
      </div>

      {canLoadMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
          >
            Load more photos
          </Button>
        </div>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div
            className="relative max-w-4xl w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <OptimizedImage
              publicUrl={getPublicUrl(selected.file_path)}
              alt={selected.description || "Claim photo"}
              preset="modal"
              aspectClassName="aspect-auto max-h-[80vh]"
            />
            <div className="flex items-center justify-between mt-3 px-1">
              <p className="text-sm text-white/80 truncate">
                {selected.description || "Claim photo"}
              </p>
              <Button
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/20"
                onClick={() => setSelected(null)}
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
