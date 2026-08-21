import React from "react";
import { cn } from "@/lib/utils";

type ShellWidth = "narrow" | "default" | "wide" | "full";

const widthClass: Record<ShellWidth, string> = {
  narrow: "max-w-3xl",
  default: "max-w-7xl",
  wide: "max-w-[1600px]",
  full: "max-w-none",
};

interface PageShellProps {
  children?: React.ReactNode;
  /**
   * narrow  – focused single-column flows (auth, forms, public pages)
   * default – standard operational pages
   * wide    – dense consoles that benefit from more space without stretching
   * full    – split-pane consoles that manage their own width
   */
  width?: ShellWidth;
  className?: string;
}

/**
 * Single source of truth for page width, horizontal gutters and vertical rhythm.
 * Pages should not re-declare `max-w-*` / `px-*` wrappers of their own.
 */
export function PageShell({ children, width = "default", className }: PageShellProps) {
  return (
    <div className={cn("mx-auto w-full min-w-0 space-y-6 pb-12", widthClass[width], className)}>
      {children}
    </div>
  );
}
