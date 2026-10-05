import { ReactNode, useEffect, useState } from "react";
import { brandingPublicUrl } from "@/lib/brandingPublicUrl";

type Props = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallback?: ReactNode;
  bucket?: "tenant-logos" | "company-branding";
};

export function TenantLogo({
  src,
  alt,
  className,
  fallback = null,
  bucket = "tenant-logos",
}: Props) {
  const [failed, setFailed] = useState(false);
  const url = brandingPublicUrl(src, bucket) || (typeof src === "string" ? src.trim() : "");
  useEffect(() => {
    setFailed(false);
  }, [url]);
  if (!url || failed) return <>{fallback}</>;
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

