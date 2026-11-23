import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { ArrowDownLeft, ArrowUpRight, Clock } from "lucide-react";
import type { JobPnlLine, JobPnlSummary, JobType } from "@/lib/jobPnl";

export const money = (n: number) =>
  `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Signed: a loss shows as "-$12.00". */
export const signedMoney = (n: number) => (n < 0 ? `-${money(Math.abs(n))}` : money(n));
export const marginLabel = (margin: number | null) => (margin === null ? "—" : `${margin.toFixed(1)}%`);

const dateText = (at: string | null) => {
  if (!at) return null;
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? format(d, "MMM d, yyyy") : null;
};

/** "Carrier · Deposited Mar 3, 2026": where the money came from, then when. */
export function jobLineSource(line: JobPnlLine): string {
  const date = dateText(line.at);
  const when = line.dateLabel && date ? `${line.dateLabel} ${date}` : date;
  return [line.detail, when].filter(Boolean).join(" · ");
}

export function JobTypeChip({ type }: { type: JobType }) {
  if (type === "unassigned") {
    return <Badge variant="outline" className="text-[10px] text-muted-foreground">Unassigned</Badge>;
  }
  return type === "cash_job" ? (
    <Badge variant="outline" className="text-[10px] border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">Cash job</Badge>
  ) : (
    <Badge variant="outline" className="text-[10px] border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400">Claim</Badge>
  );
}

export function ChecksPendingChip({ count, amount }: { count: number; amount: number }) {
  if (!count) return null;
  return (
    <Badge
      variant="outline"
      className="text-[10px] border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      title={`${count} check${count === 1 ? "" : "s"} not yet deposited or released: ${money(amount)}, not counted as revenue`}
    >
      Checks pending · {money(amount)}
    </Badge>
  );
}

/** Revenue / Costs / Profit / Margin for one job (or for all jobs). */
export function JobPnlTiles({ revenue, costs, profit, margin, label }: {
  revenue: number;
  costs: number;
  profit: number;
  margin: number | null;
  label?: { revenue?: string; costs?: string };
}) {
  const tile = "rounded-md border bg-background p-3";
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <div className={tile}>
        <p className="text-xs text-muted-foreground">{label?.revenue ?? "Revenue"}</p>
        <p className="text-lg font-semibold text-emerald-600">{money(revenue)}</p>
      </div>
      <div className={tile}>
        <p className="text-xs text-muted-foreground">{label?.costs ?? "Costs"}</p>
        <p className="text-lg font-semibold text-rose-600">{money(costs)}</p>
      </div>
      <div className={tile}>
        <p className="text-xs text-muted-foreground">Profit</p>
        <p className={`text-lg font-semibold ${profit < 0 ? "text-rose-600" : "text-primary"}`}>{signedMoney(profit)}</p>
      </div>
      <div className={tile}>
        <p className="text-xs text-muted-foreground">Margin</p>
        <p className="text-lg font-semibold">{marginLabel(margin)}</p>
      </div>
    </div>
  );
}

function LineList({ title, icon, lines, total, tone, empty }: {
  title: string;
  icon: React.ReactNode;
  lines: JobPnlLine[];
  total?: number;
  tone: "in" | "out" | "pending";
  empty: string;
}) {
  const amountClass = tone === "in" ? "text-emerald-600" : tone === "out" ? "text-rose-600" : "text-muted-foreground";
  const sign = tone === "in" ? "+" : tone === "out" ? "-" : "";
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">{icon}{title}</p>
        {total !== undefined && <p className={`text-sm font-semibold ${amountClass}`}>{money(total)}</p>}
      </div>
      {lines.length === 0 ? (
        <p className="px-3 py-3 text-xs italic text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y">
          {lines.map((line) => (
            <li key={line.key} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{line.title}</p>
                <p className="text-[11px] text-muted-foreground">{jobLineSource(line) || "—"}</p>
              </div>
              <p className={`whitespace-nowrap text-sm font-medium ${amountClass}`}>{sign}{money(line.amount)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Money in, money out and checks still in process for one job, each line saying where it came from. */
export function JobPnlLines({ job }: { job: JobPnlSummary }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <LineList
          title="Money in"
          icon={<ArrowDownLeft className="h-4 w-4 text-emerald-600" />}
          lines={job.moneyIn}
          total={job.revenue}
          tone="in"
          empty="No deposited checks, paid invoices or payments yet."
        />
        <LineList
          title="Money out"
          icon={<ArrowUpRight className="h-4 w-4 text-rose-600" />}
          lines={job.moneyOut}
          total={job.costs}
          tone="out"
          empty="No payouts, payments sent or ChecksOps fees yet."
        />
      </div>
      {job.pendingChecks.length > 0 && (
        <LineList
          title={`Checks pending (not counted as revenue yet)`}
          icon={<Clock className="h-4 w-4 text-amber-600" />}
          lines={job.pendingChecks}
          total={job.pendingAmount}
          tone="pending"
          empty=""
        />
      )}
    </div>
  );
}
