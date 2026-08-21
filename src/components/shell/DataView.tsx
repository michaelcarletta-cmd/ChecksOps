import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { useIsMobile } from "@/hooks/use-mobile";
import { TableSkeleton, ListSkeleton } from "./Skeletons";
import { cn } from "@/lib/utils";

export interface DataColumn<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Applied to the desktop <TableHead>. */
  headerClassName?: string;
  /** Applied to the desktop <TableCell>. */
  className?: string;
  /** Rendered as the card title on mobile instead of a label/value row. */
  primary?: boolean;
  /** Rendered in the card's top-right action slot on mobile. */
  action?: boolean;
  /** Skip this column entirely on mobile cards. */
  hideOnMobile?: boolean;
  /** Label used on mobile when it should differ from the header. */
  mobileLabel?: React.ReactNode;
}

interface DataViewProps<T> {
  rows: T[];
  columns: DataColumn<T>[];
  getRowId: (row: T) => string;
  loading?: boolean;
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  /** Highlighted row (e.g. the selected item in a split pane). */
  selectedId?: string | null;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
  /** Force one presentation regardless of viewport. */
  variant?: "auto" | "table" | "cards";
}

/**
 * One column definition, two presentations:
 * a table on desktop and a stacked card list on mobile.
 * Never scrolls the page horizontally — wide tables scroll inside their own container.
 */
export function DataView<T>({
  rows,
  columns,
  getRowId,
  loading,
  empty = "Nothing to show yet.",
  onRowClick,
  selectedId,
  rowClassName,
  className,
  variant = "auto",
}: DataViewProps<T>) {
  const isMobile = useIsMobile();
  const asCards = variant === "cards" || (variant === "auto" && isMobile);

  if (loading) {
    return asCards ? <ListSkeleton rows={4} /> : <TableSkeleton rows={6} cols={columns.length} />;
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-8 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }

  if (asCards) {
    const primary = columns.find((c) => c.primary) ?? columns[0];
    const actions = columns.filter((c) => c.action);
    const details = columns.filter(
      (c) => c !== primary && !c.action && !c.hideOnMobile,
    );

    return (
      <div className={cn("space-y-2", className)}>
        {rows.map((row) => {
          const id = getRowId(row);
          return (
            <Card
              key={id}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                "min-w-0 space-y-3 p-3",
                onRowClick && "cursor-pointer transition-colors active:bg-accent/40",
                selectedId === id && "border-primary/60 bg-accent/30",
                rowClassName?.(row),
              )}
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0 flex-1 break-anywhere text-sm font-medium">
                  {primary.cell(row)}
                </div>
                {actions.length > 0 && (
                  <div
                    className="flex shrink-0 items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {actions.map((c) => (
                      <React.Fragment key={c.id}>{c.cell(row)}</React.Fragment>
                    ))}
                  </div>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                {details.map((c) => (
                  <div key={c.id} className="min-w-0">
                    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {c.mobileLabel ?? c.header}
                    </dt>
                    <dd
                      className="mt-0.5 min-w-0 break-anywhere text-sm"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.cell(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          );
        })}
      </div>
    );
  }

  return (
    <div className={cn("table-scroll w-full min-w-0", className)}>
      <Table className="w-full text-xs">
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.id} className={c.headerClassName}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const id = getRowId(row);
            return (
              <TableRow
                key={id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                data-state={selectedId === id ? "selected" : undefined}
                className={cn(onRowClick && "cursor-pointer", rowClassName?.(row))}
              >
                {columns.map((c) => (
                  <TableCell key={c.id} className={cn("align-top", c.className)}>
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
