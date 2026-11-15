import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ReportExportKind = "xlsx" | "pdf";

/** A small "Export" menu with Excel and PDF (recipient report and drill-down, owner 2026-11-15). */
export function ReportExportMenu({
  onExport,
  busy,
  disabled,
  label,
}: {
  onExport: (kind: ReportExportKind) => void;
  /** The format being prepared, or null. */
  busy: ReportExportKind | null;
  disabled?: boolean;
  /** Accessible name of the trigger, e.g. "Export Per-Recipient Detail". */
  label: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 text-xs" disabled={disabled || !!busy} aria-label={label}>
          <Download className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {busy ? "Preparing…" : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        <DropdownMenuItem className="text-sm" onSelect={() => onExport("xlsx")}>
          <FileSpreadsheet className="mr-2 h-4 w-4" aria-hidden="true" />Excel (.xlsx)
        </DropdownMenuItem>
        <DropdownMenuItem className="text-sm" onSelect={() => onExport("pdf")}>
          <FileText className="mr-2 h-4 w-4" aria-hidden="true" />PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
