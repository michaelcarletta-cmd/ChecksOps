import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Download, Copy, FileText, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import type { CanonicalTimelineEvent } from "@/hooks/useCanonicalTimeline";

interface TimelineExportProps {
  events: CanonicalTimelineEvent[];
  claimNumber?: string;
}

export const TimelineExport = ({ events, claimNumber }: TimelineExportProps) => {
  const [open, setOpen] = useState(false);

  const grouped = events.reduce<Record<string, CanonicalTimelineEvent[]>>((acc, e) => {
    const day = e.occurred_at?.split("T")[0] || "Unknown";
    (acc[day] = acc[day] || []).push(e);
    return acc;
  }, {});

  const sortedDays = Object.keys(grouped).sort();

  const badgeText = (event: CanonicalTimelineEvent): string => {
    const tags: string[] = [];
    if (event.is_verified) tags.push("Verified");
    if (event.date_source === "document_extracted") tags.push("Doc-backed");
    if (event.is_manual) tags.push("Manual");
    if (event.derived) tags.push("Derived");
    return tags.join(", ");
  };

  const buildPlainText = (): string => {
    const lines: string[] = [];
    lines.push(`CLAIM CHRONOLOGY${claimNumber ? ` — ${claimNumber}` : ""}`);
    lines.push(`Generated: ${new Date().toISOString().split("T")[0]}`);
    lines.push(`Total events: ${events.length}`);
    lines.push("");

    for (const day of sortedDays) {
      lines.push(`=== ${day} ===`);
      for (const e of grouped[day]) {
        const time = format(parseISO(e.occurred_at), "h:mm a");
        const badges = badgeText(e);
        const confidence = typeof e.date_confidence === "number"
          ? ` (${Math.round(e.date_confidence * 100)}% confidence)`
          : "";
        lines.push(`  ${time} | ${e.event_type.replace(/_/g, " ").toUpperCase()}`);
        lines.push(`    ${e.summary || "No summary"}`);
        if (badges) lines.push(`    [${badges}]`);
        if (e.date_evidence) lines.push(`    Evidence: ${e.date_evidence}`);
        if (e.verification_basis) lines.push(`    Basis: ${e.verification_basis}${confidence}`);
        if (e.actor) lines.push(`    Actor: ${e.actor}`);
        if (e.source_table) lines.push(`    Source: ${e.source_table}${e.source_row_id ? ` (${e.source_row_id})` : ""}`);
        lines.push("");
      }
    }
    return lines.join("\n");
  };

  const buildCSV = (): string => {
    const headers = [
      "Date", "Time", "Event Type", "Summary", "Actor",
      "Importance", "Verified", "Doc-backed", "Manual", "Derived",
      "Date Source", "Confidence", "Evidence", "Verification Basis",
      "Source Table", "Supports Escalation", "Supports Rebuttal",
    ];
    const rows = events
      .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
      .map((e) => [
        e.occurred_at?.split("T")[0] || "",
        format(parseISO(e.occurred_at), "h:mm a"),
        e.event_type,
        `"${(e.summary || "").replace(/"/g, '""')}"`,
        e.actor || "",
        String(e.importance_score ?? ""),
        e.is_verified ? "Yes" : "No",
        e.date_source === "document_extracted" ? "Yes" : "No",
        e.is_manual ? "Yes" : "No",
        e.derived ? "Yes" : "No",
        e.date_source || "",
        typeof e.date_confidence === "number" ? `${Math.round(e.date_confidence * 100)}%` : "",
        e.date_evidence || "",
        e.verification_basis || "",
        e.source_table || "",
        e.supports_escalation ? "Yes" : "No",
        e.supports_rebuttal ? "Yes" : "No",
      ]);
    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  };

  const handleCopyText = () => {
    navigator.clipboard.writeText(buildPlainText());
    toast.success("Chronology copied to clipboard");
  };

  const handleDownloadCSV = () => {
    const blob = new Blob([buildCSV()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chronology${claimNumber ? `-${claimNumber}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
  };

  const handleDownloadText = () => {
    const blob = new Blob([buildPlainText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chronology${claimNumber ? `-${claimNumber}` : ""}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Text file downloaded");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
          <Download className="h-3 w-3" />
          Export Chronology
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-primary" />
            Export Claim Chronology
            {claimNumber && <Badge variant="secondary" className="text-xs">{claimNumber}</Badge>}
          </DialogTitle>
        </DialogHeader>
        <div className="flex gap-2 mb-3">
          <Button size="sm" variant="outline" className="text-xs gap-1" onClick={handleCopyText}>
            <Copy className="h-3 w-3" /> Copy Text
          </Button>
          <Button size="sm" variant="outline" className="text-xs gap-1" onClick={handleDownloadText}>
            <Download className="h-3 w-3" /> Download .txt
          </Button>
          <Button size="sm" variant="outline" className="text-xs gap-1" onClick={handleDownloadCSV}>
            <Download className="h-3 w-3" /> Download .csv
          </Button>
        </div>
        <ScrollArea className="h-[50vh] border rounded-md">
          <div className="p-4 space-y-4">
            {sortedDays.map((day) => (
              <div key={day}>
                <div className="font-medium text-xs text-muted-foreground mb-2 sticky top-0 bg-background py-1">
                  {day}
                </div>
                <div className="space-y-2 pl-3 border-l-2 border-border">
                  {grouped[day].map((event) => (
                    <div key={event.id} className="text-xs space-y-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium">
                          {format(parseISO(event.occurred_at), "h:mm a")}
                        </span>
                        <Badge variant="outline" className="text-[9px]">
                          {event.event_type.replace(/_/g, " ")}
                        </Badge>
                        {event.is_verified && (
                          <Badge variant="outline" className="text-[8px] border-emerald-400/50 text-emerald-600">
                            <CheckCircle2 className="h-2 w-2 mr-0.5" />Verified
                          </Badge>
                        )}
                        {event.date_source === "document_extracted" && (
                          <Badge variant="outline" className="text-[8px] border-blue-400/50 text-blue-600">
                            Doc-backed
                          </Badge>
                        )}
                        {event.is_manual && (
                          <Badge variant="secondary" className="text-[8px]">Manual</Badge>
                        )}
                        {event.derived && (
                          <Badge variant="outline" className="text-[8px] border-muted-foreground/30 text-muted-foreground">
                            Derived
                          </Badge>
                        )}
                      </div>
                      <p>{event.summary || "No summary"}</p>
                      {(event.date_evidence || event.verification_basis) && (
                        <div className="text-muted-foreground">
                          {event.verification_basis && <span>Basis: {event.verification_basis}</span>}
                          {event.date_evidence && <span className="ml-2">Evidence: {event.date_evidence}</span>}
                          {typeof event.date_confidence === "number" && (
                            <span className="ml-2">({Math.round(event.date_confidence * 100)}%)</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default TimelineExport;
