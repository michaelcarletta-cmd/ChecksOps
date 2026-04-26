import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import type { LossDraftRelease } from "@/hooks/queries/useLossDraft";

interface Props {
  releases: LossDraftRelease[];
}

export function LossDraftReleasesTab({ releases }: Props) {
  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-3">
        {releases.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No draws requested yet.</p>
        ) : (
          releases.map(r => (
            <div key={r.id} className="border rounded-lg p-2 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Draw #{r.draw_number}</p>
                <Badge variant="outline" className="text-[10px]">
                  {r.status}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-1 text-[10px]">
                <div>
                  <span className="text-muted-foreground">Requested: </span>
                  ${r.amount_requested.toLocaleString()}
                </div>
                <div>
                  <span className="text-muted-foreground">Released: </span>
                  <span className="text-emerald-400">
                    ${(r.amount_released ?? 0).toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Holdback: </span>
                  <span className="text-red-400">
                    ${(r.holdback_amount ?? 0).toLocaleString()}
                  </span>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Requested {format(new Date(r.requested_at), "MMM d")}
                {r.released_at && ` · Released ${format(new Date(r.released_at), "MMM d")}`}
              </p>
              {r.notes && <p className="text-[10px] italic">{r.notes}</p>}
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  );
}
