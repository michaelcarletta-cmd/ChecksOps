import { ReactNode, useState } from "react";
import { resolveTenantLogoUrl } from "@/lib/tenantLogoUrl";

type Props = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallback?: ReactNode;
};

export function TenantLogo({ src, alt, className, fallback = null }: Props) {
  const [failed, setFailed] = useState(false);
  const url = resolveTenantLogoUrl(src) || "";
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

