import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, RefreshCw, Wallet, TrendingUp, TrendingDown, DollarSign, Landmark } from "lucide-react";

type Bucket = {
  fees_cents: number;
  transfer_fees_cents: number;
  provider_cost_cents: number;
  volume_cents: number;
  transfer_count: number;
  revenue_cents: number;
  profit_cents: number;
  // Provider cost in its two parts. The provider-named keys are the same values under the
  // response's older names and are read only as a fallback.
  check_processing_cost_cents?: number;
  disbursement_cost_cents?: number;
  checkalt_cost_cents?: number;
  moov_cost_cents?: number;
  check_count?: number;
  payout_count?: number;
  next_day_count?: number;
  same_day_count?: number;
};

type CostRates = {
  effective_from?: string;
  checkalt_per_check_cents?: number;
  moov_next_day_cents?: number;
  moov_same_day_cents?: number;
};

type CostBasis = {
  estimated?: boolean;
  rates?: CostRates[];
  provider_minimums?: { deposit_cents?: number; transfer_cents?: number };
  notes?: string[];
};

type TreasuryResponse = {
  environment: string;
  platform_account_id: string | null;
  wallet: {
    wallet_id: string | null;
    available_cents: number;
    pending_cents: number;
    setup_required?: boolean;
    warnings?: string[];
    transactions: {
      id: string | null;
      type: string | null;
      status: string | null;
      amount_cents: number;
      available_balance_cents: number;
      created_at: string | null;
      memo: string | null;
    }[];
  };
  pnl: {
    totals: Bucket;
    months: (Bucket & { month: string })[];
    tenants: (Bucket & { tenant_id: string; tenant_name: string })[];
    cost_basis?: CostBasis;
    sources_unavailable?: string[];
  };
};

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-");
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
};

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A cost part, or null when the response does not carry it (shown as a dash, never as $0). */
const checkCost = (b?: Bucket | null) =>
  isAmount(b?.check_processing_cost_cents)
    ? b.check_processing_cost_cents
    : isAmount(b?.checkalt_cost_cents)
      ? b.checkalt_cost_cents
      : null;
const disbursementCost = (b?: Bucket | null) =>
  isAmount(b?.disbursement_cost_cents)
    ? b.disbursement_cost_cents
    : isAmount(b?.moov_cost_cents)
      ? b.moov_cost_cents
      : null;
const partMoney = (cents: number | null) => (cents === null ? "—" : money(cents));

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const payoutCount = (b?: Bucket | null) =>
  isAmount(b?.payout_count) ? b.payout_count : Number(b?.transfer_count ?? 0);

/** A per-item rate: under a dollar in cents, otherwise as money. */
const rateLabel = (cents: number) => (cents >= 0 && cents < 100 ? `${cents}¢` : money(cents));

/** The rate row in force today; a date before the first row takes the first row. */
const currentRates = (rates?: CostRates[]) => {
  if (!Array.isArray(rates) || !rates.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  let picked = rates[0];
  for (const row of rates) {
    if (row?.effective_from && row.effective_from <= today) picked = row;
  }
  return picked ?? null;
};

const SOURCE_LABELS: Record<string, string> = {
  tenants: "organizations",
  collected_revenue: "collected revenue",
  payouts: "payouts",
  check_deposits: "check processing",
  test_account_flag: "the test organization filter",
};
const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? String(source).replace(/[-_]/g, " ");

/** The check and disbursement counts behind a row's cost, as muted sub-lines. */
function CostCells({ row }: { row: Bucket }) {
  const speeds = [
    isAmount(row.next_day_count) ? `${row.next_day_count} next day` : null,
    isAmount(row.same_day_count) ? `${row.same_day_count} same day` : null,
  ].filter(Boolean);
  return (
    <>
      <TableCell className="text-right">
        {partMoney(checkCost(row))}
        {isAmount(row.check_count) && (
          <p className="text-xs text-muted-foreground">{plural(row.check_count, "check", "checks")}</p>
        )}
      </TableCell>
      <TableCell className="text-right">
        {partMoney(disbursementCost(row))}
        {speeds.length > 0 && <p className="text-xs text-muted-foreground">{speeds.join(" · ")}</p>}
      </TableCell>
    </>
  );
}

/**
 * The platform's own balance and profit & loss — the master-merchant mirror of
 * what each organization sees under Payments.
 */
export function PlatformTreasuryPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<TreasuryResponse>({
    queryKey: ["platform-treasury"],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("platform-treasury", {
        body: { action: "overview" },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as TreasuryResponse;
    },
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">{(error as Error).message}</CardContent>
      </Card>
    );
  }

  const wallet = data?.wallet;
  const pnl = data?.pnl;
  const totals = pnl?.totals;
  const margin =
    totals && totals.revenue_cents > 0 ? (totals.profit_cents / totals.revenue_cents) * 100 : 0;
  const totalCheckCost = checkCost(totals);
  const totalDisbursementCost = disbursementCost(totals);
  const hasCostSplit = totalCheckCost !== null || totalDisbursementCost !== null;
  const unavailable = Array.isArray(pnl?.sources_unavailable) ? pnl.sources_unavailable : [];
  const minimums = pnl?.cost_basis?.provider_minimums;
  const minimumParts = [
    isAmount(minimums?.deposit_cents) ? `check processing ${money(minimums.deposit_cents)}` : null,
    isAmount(minimums?.transfer_cents) ? `disbursements ${money(minimums.transfer_cents)}` : null,
  ].filter(Boolean);
  const rates = currentRates(pnl?.cost_basis?.rates);
  const disbursementRates = [
    isAmount(rates?.moov_next_day_cents) ? `${rateLabel(rates.moov_next_day_cents)} next-day` : null,
    isAmount(rates?.moov_same_day_cents) ? `${rateLabel(rates.moov_same_day_cents)} same-day` : null,
  ].filter(Boolean);
  const rateParts = [
    isAmount(rates?.checkalt_per_check_cents) ? `${rateLabel(rates.checkalt_per_check_cents)} per check` : null,
    disbursementRates.length ? `${disbursementRates.join(" / ")} per disbursement` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      {/* Platform wallet */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" />
              Platform balance
            </CardTitle>
            <CardDescription>
              Funds held on the ChecksOps master account — used to pull from and send to organizations.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-8">
            <div>
              <p className="text-xs tracking-wide text-muted-foreground">Available</p>
              <p className="text-2xl font-semibold">{money(wallet?.available_cents ?? 0)}</p>
            </div>
            <div>
              <p className="text-xs tracking-wide text-muted-foreground">Pending</p>
              <p className="text-lg">{money(wallet?.pending_cents ?? 0)}</p>
            </div>
            <Badge variant="outline" className="capitalize">
              {data?.environment ?? "unknown"}
            </Badge>
            {wallet?.setup_required && (
              <Badge variant="outline" className="border-amber-500/40 text-amber-500">
                Balance not provisioned yet
              </Badge>
            )}
          </div>

          {!!wallet?.warnings?.length && (
            <p className="text-xs text-muted-foreground">{wallet.warnings.join(" · ")}</p>
          )}

          {!!wallet?.transactions?.length && (
            <>
              <Separator />
              <div className="space-y-1">
                <p className="text-xs tracking-wide text-muted-foreground">Recent activity</p>
                <div className="divide-y rounded-md border">
                  {wallet.transactions.slice(0, 8).map((t, i) => (
                    <div key={t.id ?? i} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate capitalize">
                          {(t.type ?? "transaction").replace(/[-_]/g, " ")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t.created_at ? new Date(t.created_at).toLocaleString() : "—"}
                          {t.status ? ` · ${t.status}` : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p>{money(t.amount_cents)}</p>
                        <p className="text-xs text-muted-foreground">
                          Balance {money(t.available_balance_cents)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Profit & loss */}
      {unavailable.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-500"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Some figures could not be loaded: {unavailable.map(sourceLabel).join(", ")}. Amounts that depend on
            them may show as $0.00 or be incomplete — do not read them as final.
          </p>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Revenue</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{money(totals?.revenue_cents ?? 0)}</div>
            <p className="text-xs text-muted-foreground">Collected from organizations</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Provider cost</CardTitle>
            <TrendingDown className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{money(totals?.provider_cost_cents ?? 0)}</div>
            <p className="text-xs text-muted-foreground">
              {hasCostSplit
                ? `Check processing ${partMoney(totalCheckCost)} · Disbursements ${partMoney(totalDisbursementCost)}`
                : "Check processing and disbursements"}
            </p>
          </CardContent>
        </Card>
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net profit</CardTitle>
            <DollarSign className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{money(totals?.profit_cents ?? 0)}</div>
            <div className="mt-1 flex items-center gap-2">
              <p className="text-xs text-muted-foreground">Revenue less provider cost</p>
              <Badge variant="outline" className="h-4 py-0 font-mono text-[10px]">
                {margin.toFixed(1)}%
              </Badge>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Processed volume</CardTitle>
            <Landmark className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{money(totals?.volume_cents ?? 0)}</div>
            <p className="text-xs text-muted-foreground">
              {plural(payoutCount(totals), "payout", "payouts")} completed
            </p>
          </CardContent>
        </Card>
      </div>

      {(rateParts.length > 0 || minimumParts.length > 0) && (
        <div className="space-y-1 text-xs text-muted-foreground">
          {rateParts.length > 0 && (
            <p>Provider cost is estimated from per-item rates: {rateParts.join("; ")}.</p>
          )}
          {minimumParts.length > 0 && (
            <p>
              Provider monthly minimums — {minimumParts.join(", ")} — are not included in provider cost or
              profit.
            </p>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly profit &amp; loss</CardTitle>
          <CardDescription>Last 12 months: collected revenue, provider cost per item, and completed payouts.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {pnl?.months?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Check processing</TableHead>
                  <TableHead className="text-right">Disbursements</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pnl.months.map((m) => (
                  <TableRow key={m.month}>
                    <TableCell>{monthLabel(m.month)}</TableCell>
                    <TableCell className="text-right">{money(m.revenue_cents)}</TableCell>
                    <CostCells row={m} />
                    <TableCell
                      className={`text-right font-medium ${m.profit_cents >= 0 ? "text-emerald-500" : "text-rose-500"}`}
                    >
                      {money(m.profit_cents)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {money(m.volume_cents)}
                      <p className="text-xs">{plural(payoutCount(m), "payout", "payouts")}</p>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No collected revenue, checks or payouts in the last 12 months yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profit by organization</CardTitle>
          <CardDescription>Collected revenue, provider cost and completed payouts per organization over the same 12 months.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {pnl?.tenants?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Check processing</TableHead>
                  <TableHead className="text-right">Disbursements</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pnl.tenants.map((t) => (
                  <TableRow key={t.tenant_id}>
                    <TableCell className="max-w-[220px] truncate">{t.tenant_name}</TableCell>
                    <TableCell className="text-right">{money(t.revenue_cents)}</TableCell>
                    <CostCells row={t} />
                    <TableCell
                      className={`text-right font-medium ${t.profit_cents >= 0 ? "text-emerald-500" : "text-rose-500"}`}
                    >
                      {money(t.profit_cents)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {money(t.volume_cents)}
                      <p className="text-xs">{plural(payoutCount(t), "payout", "payouts")}</p>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No organization activity recorded yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
