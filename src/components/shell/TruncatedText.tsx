import React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface TruncatedTextProps {
  /** The full value. Rendered truncated, with the complete text available on hover/focus. */
  children: string | null | undefined;
  /** 1 = single-line ellipsis, 2/3 = line clamp. */
  lines?: 1 | 2 | 3;
  className?: string;
  /** Fallback when the value is empty. */
  placeholder?: string;
}

const clampClass = {
  1: "truncate-flex",
  2: "truncate-2",
  3: "truncate-3",
} as const;

/**
 * Identity fields (insured names, addresses, bank names, filenames, emails) rendered
 * with a consistent truncation rule and full-value access via tooltip.
 */
export function TruncatedText({
  children,
  lines = 1,
  className,
  placeholder = "—",
}: TruncatedTextProps) {
  const value = (children ?? "").trim();
  if (!value) return <span className={cn("text-muted-foreground", className)}>{placeholder}</span>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn(clampClass[lines], "block outline-none", className)}>
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs break-anywhere">
        {value}
      </TooltipContent>
    </Tooltip>
  );
}

/** Money / check numbers: never truncate, always aligned. */
export function NumericText({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("tabular-nums whitespace-nowrap", className)}>{children}</span>;
}
