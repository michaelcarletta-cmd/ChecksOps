import React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Icon rendered next to the title (lucide icon element). */
  icon?: React.ReactNode;
  /** Primary/secondary actions. Wrap on mobile, right-aligned on desktop. */
  actions?: React.ReactNode;
  /** Optional row rendered under the header (tabs, filters, stats). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Consistent page header across every module.
 * Title truncates, description clamps to two lines, actions wrap on small screens.
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("min-w-0 space-y-3", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {icon && <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>}
          <div className="min-w-0">
            <h1 className="truncate-flex text-fluid-xl font-display font-semibold text-foreground">
              {title}
            </h1>
            {description && (
              <p className="truncate-2 text-fluid-sm mt-1 text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
        )}
      </div>
      {children}
    </header>
  );
}
