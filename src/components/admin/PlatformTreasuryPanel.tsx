import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Wallet, TrendingUp, TrendingDown, DollarSign, Landmark } from "lucide-react";

type Bucket = {
  fees_cents: number;
  transfer_fees_cents: number;
  provider_cost_cents: number;
  volume_cents: number;
  transfer_count: number;
  revenue_cents: number;
  profit_cents: number;
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
              Platform balance used to pull monthly/usage fees and to issue refunds. Tenant Management does not send partner, sub, vendor, or homeowner payouts on a tenant's behalf.
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
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Available</p>
              <p className="text-2xl font-semibold">{money(wallet?.available_cents ?? 0)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Pending</p>
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
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Recent activity</p>
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
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Revenue</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{money(totals?.revenue_cents ?? 0)}</div>
            <p className="text-xs text-muted-foreground">Platform fees billed to organizations</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Provider cost</CardTitle>
            <TrendingDown className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{money(totals?.provider_cost_cents ?? 0)}</div>
            <p className="text-xs text-muted-foreground">Money out to the payment rails</p>
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
              <p className="text-xs text-muted-foreground">Revenue less rail cost</p>
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
              {totals?.transfer_count ?? 0} transfers moved
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly profit &amp; loss</CardTitle>
          <CardDescription>Last 12 months of money in and money out across all organizations.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {pnl?.months?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Provider cost</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pnl.months.map((m) => (
                  <TableRow key={m.month}>
                    <TableCell>{monthLabel(m.month)}</TableCell>
                    <TableCell className="text-right">{money(m.revenue_cents)}</TableCell>
                    <TableCell className="text-right">{money(m.provider_cost_cents)}</TableCell>
                    <TableCell
                      className={`text-right font-medium ${m.profit_cents >= 0 ? "text-emerald-500" : "text-rose-500"}`}
                    >
                      {money(m.profit_cents)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{money(m.volume_cents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No billed activity in the last 12 months yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profit by organization</CardTitle>
          <CardDescription>Which organizations contribute the platform's earnings.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {pnl?.tenants?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Provider cost</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Transfers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pnl.tenants.map((t) => (
                  <TableRow key={t.tenant_id}>
                    <TableCell className="max-w-[220px] truncate">{t.tenant_name}</TableCell>
                    <TableCell className="text-right">{money(t.revenue_cents)}</TableCell>
                    <TableCell className="text-right">{money(t.provider_cost_cents)}</TableCell>
                    <TableCell
                      className={`text-right font-medium ${t.profit_cents >= 0 ? "text-emerald-500" : "text-rose-500"}`}
                    >
                      {money(t.profit_cents)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{t.transfer_count}</TableCell>
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
