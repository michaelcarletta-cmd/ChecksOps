import { ReactNode, useEffect, useState } from "react";
import { resolvePublicBrandingUrl } from "@/integrations/aws/storage";

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
  const url = resolvePublicBrandingUrl(src, bucket) || (typeof src === "string" ? src.trim() : "");
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
