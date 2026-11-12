import { CheckCircle2, Hourglass } from "lucide-react";
import { format } from "date-fns";

interface DepositStatusPanelProps {
  checkId: string;
  depositedAt: string | null;
  /** Ignored: the panel no longer shows who deposited the check. Kept so callers need not change. */
  depositedByTenantId?: string | null;
  lastUpdated?: string | null;
}

/**
 * Deposit status on the check Overview: whether the check is deposited and when. Owner 2026-11-12: show only the
 * status and the deposited date, not which organization deposited it.
 */
export function DepositStatusPanel({ checkId, depositedAt, lastUpdated }: DepositStatusPanelProps) {
  const isDeposited = !!depositedAt;

  return (
    <div
      className={
        "rounded-md border-l-4 px-3 py-2.5 text-sm transition-colors " +
        (isDeposited
          ? "bg-green-50 border-green-500 dark:bg-green-950/20"
          : "bg-slate-50 border-slate-300 dark:bg-slate-900/30 dark:border-slate-700")
      }
      data-checkid={checkId}
    >
      <div className="flex items-center gap-2 font-medium">
        {isDeposited ? (
          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
        ) : (
          <Hourglass className="h-4 w-4 text-slate-500 shrink-0" />
        )}
        <span className={isDeposited ? "text-green-800 dark:text-green-300" : "text-slate-700 dark:text-slate-300"}>
          Deposit Status
        </span>
      </div>
      <div className="mt-1 pl-6 flex flex-col gap-0.5 text-xs">
        {isDeposited ? (
          <>
            <span className="text-green-700 dark:text-green-400">
              Deposited on {format(new Date(depositedAt!), "MMM d, yyyy 'at' h:mm a")}
            </span>
          </>
        ) : (
          <>
            <span className="text-slate-600 dark:text-slate-400">⏳ Not yet deposited</span>
            {lastUpdated && (
              <span className="text-slate-500 dark:text-slate-500">
                Last updated: {format(new Date(lastUpdated), "MMM d, h:mm a")}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
