import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClaimMicrotask, isOverdueMicrotask } from "@/services/claimOperationsService";
import { Zap, Ban, Clock } from "lucide-react";

interface NeedsActionStripProps {
  tasks: (ClaimMicrotask & { claim_number?: string; policyholder_name?: string })[];
}

export function NeedsActionStrip({ tasks }: NeedsActionStripProps) {
  const navigate = useNavigate();

  if (tasks.length === 0) return null;

  return (
    <Card className="p-3 border-red-500/30 bg-red-50/50 dark:bg-red-950/20">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="h-4 w-4 text-red-500" />
        <span className="text-sm font-semibold text-foreground">Needs Action Now</span>
        <Badge variant="destructive" className="text-xs">{tasks.length}</Badge>
      </div>
      <div className="space-y-1.5">
        {tasks.slice(0, 5).map(task => {
          const overdue = isOverdueMicrotask(task);
          return (
            <div
              key={task.id}
              className="flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/50 rounded px-2 py-1 transition-colors"
              onClick={() => navigate(`/claims/${task.claim_id}`)}
            >
              {task.is_blocking ? (
                <Ban className="h-3 w-3 text-orange-500 shrink-0" />
              ) : (
                <Zap className="h-3 w-3 text-red-500 shrink-0" />
              )}
              <span className="truncate flex-1 text-foreground">{task.title}</span>
              {task.claim_number && (
                <span className="text-xs text-muted-foreground shrink-0">#{task.claim_number}</span>
              )}
              {overdue && (
                <Clock className="h-3 w-3 text-red-500 shrink-0" />
              )}
            </div>
          );
        })}
        {tasks.length > 5 && (
          <p className="text-xs text-muted-foreground pl-2">
            + {tasks.length - 5} more action items
          </p>
        )}
      </div>
    </Card>
  );
}
