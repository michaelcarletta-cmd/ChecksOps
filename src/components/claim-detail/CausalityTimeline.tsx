import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CloudRain,
  FileText,
  Clock,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  Mail,
  Calendar,
  DollarSign,
  XCircle,
  Loader2,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { useCanonicalTimeline } from "@/hooks/useCanonicalTimeline";
import type { CanonicalTimelineEvent } from "@/hooks/useCanonicalTimeline";

interface CausalityTimelineProps {
  claimId: string;
  claim: any;
  deadlines?: any[];
}

interface CausalityEvent {
  id: string;
  date: Date;
  type: "loss" | "filed" | "inspection" | "communication" | "deadline" | "payment" | "denial" | "supplement" | "violation";
  title: string;
  description?: string;
  consequence?: string;
  violationType?: string;
  isNegative?: boolean;
  isPositive?: boolean;
  isVerified?: boolean;
  dateSource?: string | null;
}

const mapEventType = (e: CanonicalTimelineEvent): CausalityEvent["type"] => {
  const t = e.event_type;
  if (t === "loss_event") return "loss";
  if (t === "claim_created" || t === "fnol_received") return "filed";
  if (t === "inspection") return "inspection";
  if (t === "denial" || t === "denial_issued") return "denial";
  if (["payment", "payment_received", "payment_issued"].includes(t)) return "payment";
  if (t === "supplement") return "supplement";
  if (["communication", "email_sent", "claim_note"].includes(t)) return "communication";
  return "communication";
};

const isNegativeType = (type: CausalityEvent["type"]) =>
  type === "denial" || type === "violation";

const isPositiveType = (type: CausalityEvent["type"]) =>
  type === "payment";

export const CausalityTimeline = ({ claimId, claim, deadlines = [] }: CausalityTimelineProps) => {
  const { events: canonicalEvents, loading } = useCanonicalTimeline(claimId);

  const events = useMemo<CausalityEvent[]>(() => {
    const mapped: CausalityEvent[] = canonicalEvents.map((e) => {
      const type = mapEventType(e);
      return {
        id: e.id,
        date: new Date(e.occurred_at),
        type,
        title: e.summary || e.event_type.replace(/_/g, " "),
        description: e.actor ? `By ${e.actor}` : undefined,
        isNegative: isNegativeType(type),
        isPositive: isPositiveType(type),
        isVerified: e.is_verified,
        dateSource: e.date_source,
      };
    });

    // Add deadline violations from props
    deadlines.forEach((deadline) => {
      if (deadline.days_overdue && deadline.days_overdue > 0) {
        mapped.push({
          id: `deadline-${deadline.id}`,
          date: new Date(deadline.deadline_date),
          type: "violation",
          title: `${deadline.deadline_type} Deadline Missed`,
          description: `${deadline.days_overdue} days overdue`,
          consequence: deadline.bad_faith_potential ? "Bad faith indicator" : "Leverage opportunity",
          violationType: deadline.deadline_type,
          isNegative: true,
        });
      }
    });

    // Sort chronologically
    mapped.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Add causality chains — link violations back to triggers
    mapped.forEach((event, i) => {
      if (event.type === "violation" && !event.consequence) {
        const triggerEvent = mapped
          .slice(0, i)
          .reverse()
          .find((e) => e.type === "filed" || e.type === "inspection" || e.type === "loss");
        if (triggerEvent) {
          event.consequence = `Carrier violated deadline from ${format(triggerEvent.date, "MMM d")}`;
        }
      }
    });

    return mapped;
  }, [canonicalEvents, deadlines]);

  const getEventIcon = (type: CausalityEvent["type"]) => {
    switch (type) {
      case "loss": return <CloudRain className="h-4 w-4" />;
      case "filed": return <FileText className="h-4 w-4" />;
      case "inspection": return <Calendar className="h-4 w-4" />;
      case "communication": return <Mail className="h-4 w-4" />;
      case "deadline": return <Clock className="h-4 w-4" />;
      case "payment": return <DollarSign className="h-4 w-4" />;
      case "denial": return <XCircle className="h-4 w-4" />;
      case "violation": return <AlertTriangle className="h-4 w-4" />;
      default: return <CheckCircle2 className="h-4 w-4" />;
    }
  };

  const getEventColor = (event: CausalityEvent) => {
    if (event.isNegative) return "border-destructive bg-destructive/10";
    if (event.isPositive) return "border-success bg-success/10";
    if (event.type === "loss") return "border-primary bg-primary/10";
    if (event.type === "violation") return "border-warning bg-warning/10";
    return "border-border bg-muted/30";
  };

  const getIconColor = (event: CausalityEvent) => {
    if (event.isNegative || event.type === "denial") return "text-destructive";
    if (event.isPositive || event.type === "payment") return "text-success";
    if (event.type === "loss") return "text-primary";
    if (event.type === "violation") return "text-warning";
    return "text-muted-foreground";
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mr-2" />
        <span className="text-sm text-muted-foreground">Loading timeline...</span>
      </div>
    );
  }

  if (events.length === 0) {
    return <div className="text-center text-muted-foreground text-sm">No timeline events found</div>;
  }

  return (
    <ScrollArea className="h-[260px]">
      <div className="relative pl-6">
        <div className="absolute left-2 top-2 bottom-2 w-0.5 bg-border" />

        {events.map((event) => (
          <div key={event.id} className="relative mb-4 last:mb-0">
            <div className={cn(
              "absolute -left-4 w-4 h-4 rounded-full border-2 flex items-center justify-center bg-background",
              event.isNegative ? "border-destructive" : event.isPositive ? "border-success" : "border-primary"
            )}>
              <div className={cn(
                "w-2 h-2 rounded-full",
                event.isNegative ? "bg-destructive" : event.isPositive ? "bg-success" : "bg-primary"
              )} />
            </div>

            <div className={cn("ml-4 p-2 rounded-lg border text-xs", getEventColor(event))}>
              <div className="flex items-start gap-2">
                <div className={cn("mt-0.5 flex-shrink-0", getIconColor(event))}>
                  {getEventIcon(event.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{event.title}</span>
                    <span className="text-muted-foreground">{format(event.date, "MMM d, yyyy")}</span>
                    {event.isVerified && (
                      <Badge variant="outline" className="text-[8px] border-emerald-400/50 text-emerald-600">
                        Verified
                      </Badge>
                    )}
                    {event.dateSource === "document_extracted" && (
                      <Badge variant="outline" className="text-[8px] border-blue-400/50 text-blue-600">
                        Doc-backed
                      </Badge>
                    )}
                  </div>
                  {event.description && (
                    <p className="text-muted-foreground mt-0.5">{event.description}</p>
                  )}
                  {event.consequence && (
                    <div className="flex items-center gap-1 mt-1 text-primary font-medium">
                      <ArrowRight className="h-3 w-3" />
                      {event.consequence}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
};
