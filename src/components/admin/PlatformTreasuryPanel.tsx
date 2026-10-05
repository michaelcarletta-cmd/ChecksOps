import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { monthLabel } from "@/lib/payments/platformFinance";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Wallet, TrendingUp, TrendingDown, DollarSign, Landmark, AlertTriangle } from "lucide-react";

type Ledger = {
  charged_cents: number;
  outstanding_cents: number;
  billed_processing_cents: number;
  collected_cents: number;
  revenue_cents: number;
  provider_cost_cents: number;
  provider_cost_available: boolean;
  provider_cost_missing: boolean;
  profit_cents: number | null;
  profit_available: boolean;
  volume_cents: number;
  transfer_count: number;
};

type ActivityItem = {
  kind: "fee" | "transfer";
  id: string | null;
  tenant_id: string | null;
  tenant_name: string;
  fee_code?: string | null;
  description?: string | null;
  amount_cents: number;
  collection_status: string;
  occurred_at?: string | null;
  completed_at?: string | null;
  source_reference?: string | null;
  check_id?: string | null;
  claim_id?: string | null;
  provider_transfer_id?: string | null;
  provider_fee_cents?: number | null;
  provider_fee_recorded?: boolean;
};

type TreasuryResponse = {
  environment: string;
  platform_account_id: string | null;
  wallet: {
    wallet_id: string | null;
    available_cents: number | null;
    pending_cents: number | null;
    setup_required?: boolean;
    read_error?: boolean;
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
    totals: Ledger;
    months: (Ledger & { month: string })[];
    tenants: (Ledger & { tenant_id: string; tenant_name: string; items?: ActivityItem[] })[];
    activity?: ActivityItem[];
  };
};

const money = (cents: number | null | undefined) => {
  if (cents == null) return "—";
  return (Number(cents) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const statusLabel = (status: string) => status.replace(/_/g, " ");

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
  const walletUnread = Boolean(wallet?.read_error) || wallet?.available_cents == null;
  const activity = pnl?.activity
    ?? (pnl?.tenants ?? []).flatMap((tenant) => tenant.items ?? []);

  return (
    <div className="space-y-6">
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
          {walletUnread ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Wallet balance could not be read</p>
                <p className="text-xs text-muted-foreground">
                  {wallet?.warnings?.length
                    ? wallet.warnings.join(" · ")
                    : "This is a read error, not a $0 or unprovisioned balance."}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-8">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Available</p>
                <p className="text-2xl font-semibold">{money(wallet?.available_cents)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Pending</p>
                <p className="text-lg">{money(wallet?.pending_cents)}</p>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className="capitalize">
              {data?.environment ?? "unknown"}
            </Badge>
            {data?.platform_account_id && (
              <p className="font-mono text-xs text-muted-foreground break-all">
                {data.platform_account_id}
              </p>
            )}
            {wallet?.wallet_id && !walletUnread && (
              <p className="font-mono text-xs text-muted-foreground break-all">{wallet.wallet_id}</p>
            )}
            {wallet?.setup_required && !wallet?.read_error && (
              <Badge variant="outline" className="border-amber-500/40 text-amber-500">
                Balance not provisioned yet
              </Badge>
            )}
          </div>

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

      <div className="grid gap-4 md:grid-cols-4">
        <Metric title="Accrued / Charged" cents={totals?.charged_cents} hint="Fees recorded against organizations" icon={TrendingUp} />
        <Metric title="Outstanding" cents={totals?.outstanding_cents} hint="Unbilled / not yet collected" />
        <Metric title="Billed / Processing" cents={totals?.billed_processing_cents} hint="Billed but not completed at the provider" />
        <Metric title="Collected" cents={totals?.collected_cents} hint="Completed occurrence with provider transfer" icon={DollarSign} emphasize />
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Provider cost</CardTitle>
            <TrendingDown className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {totals?.provider_cost_available ? money(totals.provider_cost_cents) : "Unavailable"}
            </div>
            <p className="text-xs text-muted-foreground">
              {totals?.provider_cost_available
                ? "Recorded rail fees on completed production transfers"
                : "No complete recorded provider-fee data"}
            </p>
          </CardContent>
        </Card>
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net profit</CardTitle>
            <DollarSign className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">
              {totals?.profit_available ? money(totals.profit_cents) : "Unavailable"}
            </div>
            <p className="text-xs text-muted-foreground">
              Collected revenue minus recorded provider cost
            </p>
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
              {totals?.transfer_count ?? 0} completed production transfers
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly profit &amp; loss</CardTitle>
          <CardDescription>Charged, collected, and completed production volume. Dates are grouped by UTC year-month.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {pnl?.months?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">Provider cost</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pnl.months.map((m) => (
                  <TableRow key={m.month}>
                    <TableCell>{monthLabel(m.month)}</TableCell>
                    <TableCell className="text-right">{money(m.charged_cents)}</TableCell>
                    <TableCell className="text-right">{money(m.outstanding_cents)}</TableCell>
                    <TableCell className="text-right">{money(m.collected_cents)}</TableCell>
                    <TableCell className="text-right">
                      {m.provider_cost_available ? money(m.provider_cost_cents) : "—"}
                    </TableCell>
                    <TableCell className={`text-right font-medium ${m.profit_available && (m.profit_cents ?? 0) >= 0 ? "text-emerald-500" : m.profit_available ? "text-rose-500" : ""}`}>
                      {m.profit_available ? money(m.profit_cents) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{money(m.volume_cents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No charged or completed production activity in the last 12 months yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organizations</CardTitle>
          <CardDescription>Charged, outstanding, collected, and earned amounts use the same definitions as the platform totals.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {pnl?.tenants?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pnl.tenants.map((t) => (
                  <TableRow key={t.tenant_id}>
                    <TableCell className="max-w-[220px] truncate">{t.tenant_name}</TableCell>
                    <TableCell className="text-right">{money(t.charged_cents)}</TableCell>
                    <TableCell className="text-right">{money(t.outstanding_cents)}</TableCell>
                    <TableCell className="text-right">{money(t.collected_cents)}</TableCell>
                    <TableCell className="text-right">
                      {t.provider_cost_available ? money(t.provider_cost_cents) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {t.profit_available ? money(t.profit_cents) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{money(t.volume_cents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No organization activity recorded yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fee and transfer detail</CardTitle>
          <CardDescription>
            Traceability from organization to fee or completed production transfer. Missing check, claim, or request identity is left blank.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {activity.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.map((item, index) => (
                  <TableRow key={item.id ?? `${item.kind}-${index}`}>
                    <TableCell className="max-w-[180px] truncate">{item.tenant_name}</TableCell>
                    <TableCell className="capitalize">
                      {item.kind === "fee" ? (item.fee_code || "fee").replace(/_/g, " ") : "transfer"}
                    </TableCell>
                    <TableCell className="capitalize">{statusLabel(item.collection_status)}</TableCell>
                    <TableCell className="max-w-[240px] truncate font-mono text-xs text-muted-foreground">
                      {item.source_reference
                        || item.provider_transfer_id
                        || item.check_id
                        || item.claim_id
                        || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.occurred_at || item.completed_at
                        ? new Date(String(item.occurred_at || item.completed_at)).toLocaleDateString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">{money(item.amount_cents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No fee lines or completed production transfers to display.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  title,
  cents,
  hint,
  icon: Icon,
  emphasize = false,
}: {
  title: string;
  cents?: number;
  hint: string;
  icon?: typeof TrendingUp;
  emphasize?: boolean;
}) {
  return (
    <Card className={emphasize ? "border-primary/20 bg-primary/5" : undefined}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {Icon ? <Icon className="h-4 w-4 text-muted-foreground" /> : null}
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${emphasize ? "text-primary" : ""}`}>{money(cents ?? 0)}</div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
