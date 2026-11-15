import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { ArrowDownLeft, ArrowUpRight, Search, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { displayCase } from "@/lib/displayCase";
import {
  drilldownTotals,
  filterByDirection,
  recipientTransactions,
  searchTransactions,
  type DrilldownFilter,
  type RecipientTransaction,
} from "@/lib/payments/recipientDrilldown";

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TONE: Record<string, string> = {
  settled: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
  completed: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
  in_transit: "text-blue-600 border-blue-500/30 bg-blue-500/10",
  submitted: "text-blue-600 border-blue-500/30 bg-blue-500/10",
  returned: "text-destructive border-destructive/30 bg-destructive/10",
  failed: "text-destructive border-destructive/30 bg-destructive/10",
};

/**
 * Every transaction between this organization and one recipient (owner 2026-11-15), from the rows
 * the recipient report already loaded. Sent and Received filter, with totals for each. Each row shows
 * the client the payment was for; the search narrows by client, check or claim number, and the
 * totals count the rows it leaves.
 */
export function RecipientDrilldownSheet({
  name,
  transactions,
  rangeLabel,
  onClose,
}: {
  /** The recipient's name as the report shows it; null when closed. */
  name: string | null;
  /** Every sent and received transaction of the report's date range (all recipients). */
  transactions: RecipientTransaction[];
  /** The report's date range, shown in the header. */
  rangeLabel: string;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<DrilldownFilter>("all");
  const [query, setQuery] = useState("");
  useEffect(() => { if (name) { setFilter("all"); setQuery(""); } }, [name]);

  const mine = useMemo(() => (name ? recipientTransactions(name, transactions) : []), [name, transactions]);
  // The search first, so the All/Sent/Received totals count the rows it leaves.
  const matching = useMemo(() => searchTransactions(mine, query), [mine, query]);
  const totals = useMemo(() => drilldownTotals(matching), [matching]);
  const shown = useMemo(() => filterByDirection(matching, filter), [matching, filter]);
  const searching = query.trim().length > 0;

  const filters: Array<{ value: DrilldownFilter; label: string; rows: number; amount: string }> = [
    { value: "all", label: "All", rows: totals.rows.all, amount: `${totals.net < 0 ? "−" : "+"}${money(totals.net)} net` },
    { value: "sent", label: "Sent", rows: totals.rows.sent, amount: `−${money(totals.sent.total)}` },
    { value: "received", label: "Received", rows: totals.rows.received, amount: `+${money(totals.received.total)}` },
  ];

  return (
    <Sheet open={!!name} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full max-w-full sm:max-w-xl p-4 sm:p-6" data-testid="recipient-drilldown">
        <SheetHeader className="pr-8 text-left">
          <SheetTitle className="text-base sm:text-lg break-words">{name}</SheetTitle>
          <SheetDescription className="text-xs">
            Every payment sent to and received from this recipient in the report's date range: <span className="font-medium text-foreground">{rangeLabel}</span>.
            Totals count settled payments sent and payments received that were not returned.
          </SheetDescription>
        </SheetHeader>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search client, check # or claim #"
            aria-label="Search transactions by client name, check number or claim number"
            className="h-9 pl-8 pr-8 text-sm"
          />
          {searching && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(v) => v && setFilter(v as DrilldownFilter)}
          aria-label="Show sent, received or all transactions"
          className="mt-3 grid grid-cols-3 gap-2"
        >
          {filters.map((f) => (
            <ToggleGroupItem
              key={f.value}
              value={f.value}
              aria-label={`${f.label}: ${f.rows} transaction${f.rows !== 1 ? "s" : ""}`}
              className="h-auto flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left data-[state=on]:border-primary data-[state=on]:bg-primary/5"
            >
              <span className="text-xs font-medium">{f.label} <span className="text-muted-foreground">({f.rows})</span></span>
              <span className={`text-sm font-semibold ${f.value === "received" ? "text-emerald-600" : ""}`}>{f.amount}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {shown.length === 0 ? (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {searching
              ? `No ${filter === "all" ? "transactions" : `${filter} transactions`} match “${query.trim()}”.`
              : filter === "all" ? "No transactions with this recipient in this range." : `Nothing ${filter} in this range.`}
          </p>
        ) : (
          <ul className="mt-4 divide-y rounded-lg border" aria-label={`Transactions with ${name ?? "recipient"}`}>
            {shown.map((t) => {
              const sent = t.direction === "sent";
              return (
                <li key={`${t.direction}:${t.id}`} className="flex items-start gap-3 p-3">
                  <span
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${sent ? "bg-muted text-foreground" : "bg-emerald-500/10 text-emerald-600"}`}
                    aria-hidden="true"
                  >
                    {sent ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownLeft className="h-3.5 w-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-xs font-medium">
                        {sent ? "Sent" : "Received"} · {t.methodLabel}
                      </p>
                      <p className={`shrink-0 text-sm font-semibold tabular-nums ${sent ? "" : "text-emerald-600"} ${t.counted ? "" : "text-muted-foreground line-through"}`}>
                        {sent ? "−" : "+"}{money(t.amount)}
                      </p>
                    </div>
                    {t.clientName && (
                      <p className="mt-0.5 truncate text-xs" title={displayCase(t.clientName)}>
                        <span className="text-muted-foreground">For:</span> <span className="font-medium">{displayCase(t.clientName)}</span>
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <span>{format(new Date(t.date), "MMM d, yyyy")}</span>
                      <Badge variant="outline" className={`h-4 py-0 text-[9px] ${STATUS_TONE[t.status] ?? ""}`}>{t.statusLabel}</Badge>
                      {t.reference && <span className="font-mono">{t.reference}</span>}
                      {t.name !== name && <span className="truncate">as {t.name}</span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}
