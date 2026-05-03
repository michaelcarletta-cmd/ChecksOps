import { cn } from "@/lib/utils";
import logoDark from "@/assets/checksops-logo-dark.png";
import logoLight from "@/assets/checksops-logo-light.png";

interface CheckOpsLogoProps {
  className?: string;
  /** Render the light-background variant (blue + black). Defaults to dark-bg variant (blue + white). */
  variant?: "dark" | "light";
  /** Kept for backwards compatibility — wordmark is part of the image, this prop is ignored. */
  showWordmark?: boolean;
  /** Kept for backwards compatibility (ignored — image is pre-colored to brand palette). */
  accentClassName?: string;
  checkClassName?: string;
  ringClassName?: string;
}

/**
 * ChecksOps brand mark — image-based wordmark with crosshair "O".
 * The blue matches the project's primary token; "ps" is white on dark
 * surfaces (default) and black on light surfaces.
 */
export function CheckOpsLogo({
  className,
  variant = "dark",
}: CheckOpsLogoProps) {
  const src = variant === "light" ? logoLight : logoDark;
  return (
    <img
      src={src}
      alt="ChecksOps"
      className={cn("inline-block w-auto h-[1.6em] select-none", className)}
      draggable={false}
    />
  );
}
