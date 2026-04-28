import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import type { LossDraftAuditEntry } from "@/hooks/queries/useLossDraft";

interface Props {
  audit: LossDraftAuditEntry[];
}

export function LossDraftAuditTab({ audit }: Props) {
  return (
    <ScrollArea className="h-full min-h-0">
      <div className="p-4 space-y-2">
        {audit.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No audit events yet.</p>
        ) : (
          audit.map(a => (
            <div key={a.id} className="border-l-2 border-accent pl-3 py-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[9px]">
                  {a.action.replace(/_/g, " ")}
                </Badge>
                {a.amount != null && (
                  <span className="text-[10px] font-medium">
                    ${a.amount.toLocaleString()}
                  </span>
                )}
              </div>
              {a.notes && (
                <p className="text-[10px] text-muted-foreground">{a.notes}</p>
              )}
              <p className="text-[10px] text-muted-foreground">
                {format(new Date(a.created_at), "MMM d 'at' h:mm a")}
              </p>
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  );
}
