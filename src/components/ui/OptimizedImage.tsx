import React, { useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { buildOptimizedImageUrl, ImageSizePreset } from "@/lib/storageImage";

type OptimizedImageProps = {
  publicUrl: string;
  alt?: string;
  className?: string;
  preset?: ImageSizePreset;
  aspectClassName?: string;
  onClick?: () => void;
};

export function OptimizedImage({
  publicUrl,
  alt = "",
  className = "",
  preset = "card",
  aspectClassName = "aspect-[4/3]",
  onClick,
}: OptimizedImageProps) {
  const [loaded, setLoaded] = useState(false);
  const { ref, inView } = useInView({
    triggerOnce: true,
    rootMargin: "300px 0px",
  });

  const lowRes = useMemo(
    () => buildOptimizedImageUrl(publicUrl, "thumb"),
    [publicUrl]
  );

  const mainSrc = useMemo(
    () => buildOptimizedImageUrl(publicUrl, preset),
    [publicUrl, preset]
  );

  return (
    <div
      ref={ref}
      className={`relative overflow-hidden bg-muted ${aspectClassName} ${className}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <img
        src={lowRes}
        alt={alt}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
          loaded ? "opacity-0" : "opacity-100"
        } blur-sm`}
        loading="lazy"
      />
      {inView && (
        <img
          src={mainSrc}
          alt={alt}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          onLoad={() => setLoaded(true)}
          loading="lazy"
        />
      )}
    </div>
  );
}
