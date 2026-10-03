import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, FileSearch } from "lucide-react";
import { format } from "date-fns";
import { MORTGAGE_DESK_RETURN_MESSAGE } from "@/lib/mortgageDeskReturn";

interface Props {
  completedAt?: string | null;
  returnedAt?: string | null;
  onReview?: () => void;
  onAcknowledge?: () => void;
  acknowledging?: boolean;
  compact?: boolean;
}

export function MortgageDeskReturnedBanner({
  completedAt,
  returnedAt,
  onReview,
  onAcknowledge,
  acknowledging,
  compact,
}: Props) {
  const when = returnedAt || completedAt;
  return (
    <div
      className={`rounded-md border border-amber-500/40 bg-amber-500/10 ${
        compact ? "p-2" : "p-3"
      } space-y-2`}
      data-testid="mortgage-desk-returned-banner"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className={`${compact ? "h-3.5 w-3.5" : "h-4 w-4"} text-amber-400 shrink-0 mt-0.5`} />
        <div className="min-w-0 space-y-1">
          <p className={`${compact ? "text-xs" : "text-sm"} font-semibold text-amber-100`}>
            Returned from Mortgage Desk · Action Required
          </p>
          <p className="text-[11px] text-amber-100/80">{MORTGAGE_DESK_RETURN_MESSAGE}</p>
          {when && (
            <p className="text-[10px] text-muted-foreground">
              Returned {format(new Date(when), "MMM d, yyyy h:mm a")}
            </p>
          )}
        </div>
      </div>
      {(onReview || onAcknowledge) && (
        <div className="flex flex-wrap gap-2">
          {onReview && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onReview}>
              <FileSearch className="h-3 w-3" />
              Review Returned File
            </Button>
          )}
          {onAcknowledge && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs gap-1"
              disabled={acknowledging}
              onClick={onAcknowledge}
            >
              <CheckCircle2 className="h-3 w-3" />
              Acknowledge returned work
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
