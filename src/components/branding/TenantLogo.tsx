import { ReactNode, useState } from "react";
import { resolveTenantAssetUrl, resolveTenantLogoUrl } from "@/lib/tenantLogoUrl";

type Props = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallback?: ReactNode;
  assetBucket?: "tenant-logos" | "company-branding";
  tenantId?: string | null;
};

export function TenantLogo({ src, alt, className, fallback = null, assetBucket, tenantId }: Props) {
  const [failed, setFailed] = useState(false);
  const resolved = assetBucket && assetBucket !== "tenant-logos"
    ? resolveTenantAssetUrl(src, assetBucket) || (typeof src === "string" ? src.trim() : "")
    : resolveTenantLogoUrl(src, undefined, tenantId) || (typeof src === "string" ? src.trim() : "");
  if (!resolved || failed) return <>{fallback}</>;
  return (
    <img
      src={resolved}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
