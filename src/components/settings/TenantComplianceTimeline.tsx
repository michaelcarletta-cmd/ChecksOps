import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock3, ShieldCheck } from "lucide-react";

type TimelineEventType =
  | "Tenant Created"
  | "KYB Completed"
  | "Moov Connected"
  | "Bank Verified"
  | "User Added"
  | "TOTP Enrolled"
  | "Terms Accepted"
  | "Financial Access Granted"
  | "Compliance Review"
  | "Permission Changed"
  | "Restriction Applied"
  | "Restriction Resolved";

export interface TenantComplianceTimelineEvent {
  id: string;
  type: TimelineEventType;
  title: string;
  detail?: string;
  occurredAt: string;
  actor?: string;
}

interface TenantComplianceTimelineProps {
  tenantId: string;
  tenantName: string;
  events?: TenantComplianceTimelineEvent[];
}

export function TenantComplianceTimeline({ tenantId, tenantName, events = [] }: TenantComplianceTimelineProps) {
  const orderedEvents = [...events].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock3 className="h-4 w-4" /> Compliance Timeline
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Chronological security and compliance history for {tenantName}.</p>
          </div>
          <Badge variant="outline">{orderedEvents.length} events</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {orderedEvents.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <ShieldCheck className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">No compliance timeline events yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              AWS will supply tenant-scoped compliance events for {tenantId}. This view does not create or alter audit evidence.
            </p>
          </div>
        ) : (
          <div className="space-y-0">
            {orderedEvents.map((event, index) => (
              <div key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                {index < orderedEvents.length - 1 && <div className="absolute left-[7px] top-5 h-[calc(100%-8px)] w-px bg-border" />}
                <div className="relative mt-1 h-4 w-4 shrink-0 rounded-full border-2 border-primary bg-background" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{event.title}</p>
                    <Badge variant="secondary" className="text-[10px]">{event.type}</Badge>
                  </div>
                  {event.detail && <p className="mt-1 text-xs text-muted-foreground">{event.detail}</p>}
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    <span>{new Date(event.occurredAt).toLocaleString()}</span>
                    {event.actor && <span>By {event.actor}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
