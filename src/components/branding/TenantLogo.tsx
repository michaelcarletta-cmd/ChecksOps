import { ReactNode, useState } from "react";

type Props = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallback?: ReactNode;
};

export function TenantLogo({ src, alt, className, fallback = null }: Props) {
  const [failed, setFailed] = useState(false);
  const url = typeof src === "string" ? src.trim() : "";
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

