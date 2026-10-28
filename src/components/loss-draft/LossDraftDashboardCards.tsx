import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

export type LossDraftFilter = "active" | "monitored" | "non_monitored";

interface Props {
  activeCount: number;
  monitoredCount: number;
  nonMonitoredCount: number;
  /** files in the current view (after the filter and the search) */
  visibleCount: number;
  /** unreleased funds of the files in the current view */
  visibleUnreleased: number;
  activeFilter: LossDraftFilter;
  onFilterChange: (f: LossDraftFilter) => void;
}

/*
 * Loss Draft's filter + one count/total line, in the same bar the other check
 * tabs use for their class filter (border-b, muted strip, count and total on
 * the right), instead of four large stat cards above the list.
 */
export function LossDraftFilterBar({
  activeCount,
  monitoredCount,
  nonMonitoredCount,
  visibleCount,
  visibleUnreleased,
  activeFilter,
  onFilterChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 bg-muted/30">
      <span className="text-[11px] font-medium text-muted-foreground tracking-wide">Files</span>
      <Select value={activeFilter} onValueChange={(v) => onFilterChange(v as LossDraftFilter)}>
        <SelectTrigger className="h-7 w-[220px] text-xs" aria-label="Loss draft filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active">All active files ({activeCount})</SelectItem>
          <SelectItem value="monitored">Monitored claims ({monitoredCount})</SelectItem>
          <SelectItem value="non_monitored">Non-monitored claims ({nonMonitoredCount})</SelectItem>
        </SelectContent>
      </Select>
      {activeFilter !== "active" && (
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onFilterChange("active")}>
          Clear
        </Button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          {visibleCount} file{visibleCount === 1 ? "" : "s"}
        </span>
        <span className="font-semibold tabular-nums text-foreground">
          Unreleased: ${visibleUnreleased.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
    </div>
  );
}
