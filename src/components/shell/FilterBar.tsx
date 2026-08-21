import React from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  placeholder?: string;
  /** Selects, toggles, date pickers — wrap on mobile. */
  children?: React.ReactNode;
  /** Right-aligned actions (export, add). */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Consistent search + filter row. Full-width input on mobile, inline on desktop.
 */
export function FilterBar({
  search,
  onSearchChange,
  placeholder = "Search…",
  children,
  actions,
  className,
}: FilterBarProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center", className)}>
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder}
          className="h-10 w-full pl-9 pr-9"
          aria-label={placeholder}
        />
        {search && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear search"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
            onClick={() => onSearchChange("")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">{actions}</div>
      )}
    </div>
  );
}
