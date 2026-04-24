import { cn } from "@/lib/utils";

interface CheckOpsLogoProps {
  className?: string;
  /** Show wordmark next to the mark */
  showWordmark?: boolean;
  /** Override accent color for the crosshair ticks and "Ops" text (defaults to primary blue) */
  accentClassName?: string;
  /** Override color for "Check" text (defaults to white) */
  checkClassName?: string;
  /** Override color for the outer crosshair ring (defaults to muted grey) */
  ringClassName?: string;
}

/**
 * ChecksOps brand mark.
 * The "O" in Ops is rendered as a crosshair/reticle — the visual metaphor for
 * precision targeting of every check moving through the pipeline.
 *
 * Default palette: white "Checks", blue "Ops", grey outer ring, blue ticks.
 */
export function CheckOpsLogo({
  className,
  showWordmark = true,
  accentClassName = "text-primary",
  checkClassName = "text-white",
  ringClassName = "text-muted-foreground",
}: CheckOpsLogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2 leading-none", className)}>
      {/* Crosshair mark */}
      <svg
        viewBox="0 0 40 40"
        className={cn("h-[1.1em] w-[1.1em] shrink-0", ringClassName)}
        aria-hidden="true"
      >
        {/* Outer ring — muted grey */}
        <circle
          cx="20"
          cy="20"
          r="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
        />
        {/* Crosshair ticks & center dot — primary blue */}
        <g className={accentClassName}>
          <line x1="20" y1="1" x2="20" y2="9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <line x1="20" y1="31" x2="20" y2="39" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <line x1="1" y1="20" x2="9" y2="20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <line x1="31" y1="20" x2="39" y2="20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          {/* Center dot */}
          <circle cx="20" cy="20" r="2.2" fill="currentColor" />
        </g>
      </svg>

      {showWordmark && (
        <span className="font-bold tracking-tight">
          <span className={checkClassName}>Check</span>
          <span className={accentClassName}>Ops</span>
        </span>
      )}
    </span>
  );
}
