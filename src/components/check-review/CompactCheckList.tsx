import type { ReactNode, MouseEvent, FocusEvent } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { displayCase } from "@/lib/displayCase";

/*
 * Compact check list — the dense layout of the Review tab's Manual Review
 * Queue, shared by Review, Endorsing, Ready for Deposit, Deposited, Funds
 * Released and Funds Received so a tenant sees several checks per screen
 * without scrolling past a wide table. One group header per claim (or cash
 * job), then one small card per check: number + amount, one truncated line,
 * a row of pills, and an optional footer.
 */

export const COMPACT_LIST_SCROLL_CLASS = "max-h-none lg:h-[calc(100vh-460px)]";

export function formatCompactAmount(amount: number | null | undefined): string {
  return amount != null && Number.isFinite(Number(amount))
    ? `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
    : "—";
}

/** Short label for a check's funds class, as the lane tables used to show it. */
export function compactFundsTypeLabel(fundsType: string | null | undefined): string | null {
  if (!fundsType) return null;
  if (fundsType === "recoverable_depreciation") return "Rec. Dep.";
  if (fundsType === "overhead_and_profit") return "O&P";
  return fundsType;
}

export function CompactCheckListBody({ children }: { children: ReactNode }) {
  return <div className="space-y-2 p-2">{children}</div>;
}

export function CompactClaimGroupHeader({
  policyholderName,
  claimNumber,
  cashJob,
  count,
  noun = ["check", "checks"],
  details,
  leading,
}: {
  policyholderName: string;
  claimNumber: string;
  /** When set, the group is a cash job: no claim # chip, the job name when known. */
  cashJob?: { name?: string | null } | null;
  count: number;
  noun?: [string, string];
  /** Stage-specific facts for the group, shown on the one summary line after the count. */
  details?: ReactNode[];
  /** e.g. a select-all checkbox for the group */
  leading?: ReactNode;
}) {
  const shownDetails = (details ?? []).filter((d) => d !== null && d !== undefined && d !== false && d !== "");
  return (
    <div className="rounded-md border-t-4 border-primary bg-primary/20 px-3 py-3 text-foreground font-semibold">
      <div className="flex flex-wrap items-center gap-2">
        {leading}
        {cashJob ? (
          <>
            <Badge variant="secondary" className="text-[10px] tracking-wide border-amber-500/40 text-amber-500">Cash Job</Badge>
            <span className="font-semibold text-foreground truncate">{displayCase(policyholderName)}</span>
            {cashJob.name && <Badge variant="outline" className="text-[10px]">{cashJob.name}</Badge>}
          </>
        ) : (
          <>
            <Badge variant="secondary" className="text-[10px] tracking-wide">Claim Check File</Badge>
            <span className="font-semibold text-foreground truncate">{displayCase(policyholderName)}</span>
            <Badge variant="outline" className="font-mono text-[10px]">Claim #{claimNumber}</Badge>
          </>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs font-normal text-muted-foreground">
        <span>{count} {count === 1 ? noun[0] : noun[1]}</span>
        {shownDetails.map((detail, i) => (
          <span key={i} className="contents">
            <span>•</span>
            <span>{detail}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function CompactCheckRow({
  checkNumber,
  amount,
  subtitle,
  selected = false,
  className = "",
  interactive = true,
  onClick,
  onMouseEnter,
  onFocus,
  leading,
  titleAdornment,
  pills,
  actions,
  footer,
}: {
  checkNumber: string | null | undefined;
  amount: number | null | undefined;
  /** One truncated line under the number, e.g. the carrier name. */
  subtitle: ReactNode;
  selected?: boolean;
  /** extra classes for the card, e.g. a bulk-selected tint */
  className?: string;
  interactive?: boolean;
  onClick?: () => void;
  onMouseEnter?: (e: MouseEvent<HTMLDivElement>) => void;
  onFocus?: (e: FocusEvent<HTMLDivElement>) => void;
  /** e.g. a bulk-select checkbox, before the check number */
  leading?: ReactNode;
  /** small badges after the check number (shared, duplicate) */
  titleAdornment?: ReactNode;
  /** status / stage pills */
  pills?: ReactNode;
  /** icon buttons at the end of the pill row; clicks do not open the check */
  actions?: ReactNode;
  /** an extra line under the pills (the Review tab's Claim # field); clicks do not open the check */
  footer?: ReactNode;
}) {
  const number = (
    <span className="font-mono text-sm font-medium">
      #{checkNumber || "Pending"}
    </span>
  );
  return (
    <Card
      className={`${interactive ? "cursor-pointer" : ""} transition-colors hover:bg-accent/30 ${
        selected ? "ring-1 ring-primary bg-accent/50" : ""
      }${className ? ` ${className}` : ""}`}
      onClick={interactive ? onClick : undefined}
      onMouseEnter={onMouseEnter}
      onFocus={onFocus}
    >
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1">
          {leading || titleAdornment ? (
            <div className="flex min-w-0 items-center gap-1.5">
              {leading && <span onClick={(e) => e.stopPropagation()} className="inline-flex">{leading}</span>}
              {number}
              {titleAdornment}
            </div>
          ) : number}
          <span className="text-sm font-bold tabular-nums">
            {formatCompactAmount(amount)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {subtitle}
        </p>
        {(pills || actions) && (
          <div className={`mt-1.5 flex flex-wrap gap-1${actions ? " items-center" : ""}`}>
            {pills}
            {actions && (
              <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                {actions}
              </div>
            )}
          </div>
        )}
        {footer && (
          <div
            className="mt-2 flex items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            {footer}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
