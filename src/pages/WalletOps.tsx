import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  CircleAlert,
  Clock,
  Gauge,
  Landmark,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Timer,
  Wallet,
  Zap,
} from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useSweepConfig } from "@/hooks/useSweepConfig";
import { useWalletOpsReadiness, useWalletOpsTransfers } from "@/hooks/useWalletOps";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { SWEEP_RAIL_HINT, SWEEP_RAIL_LABEL, type SweepPushRail } from "@/lib/payments/sweeps";
import { WalletPanel } from "@/components/payments/WalletPanel";
import { MoovTreasuryPanel } from "@/components/payments/MoovTreasuryPanel";
import { isCheckOpsHost } from "@/lib/checkopsHost";

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const ENTRY_LABEL: Record<string, string> = {
  funding: "Balance funded",
  payout: "Payout",
  settlement_received: "Settlement received",
  fee: "Platform fee",
  adjustment: "Adjustment",
  sweep: "Automatic payout",
};

const STATUS_TONE: Record<string, string> = {
  completed: "border-emerald-500/40 text-emerald-500 bg-emerald-500/5",
  settled: "border-emerald-500/40 text-emerald-500 bg-emerald-500/5",
  pending: "border-amber-500/40 text-amber-500 bg-amber-500/5",
  processing: "border-amber-500/40 text-amber-500 bg-amber-500/5",
  submitted: "border-sky-500/40 text-sky-500 bg-sky-500/5",
  failed: "border-destructive/40 text-destructive bg-destructive/5",
  returned: "border-destructive/40 text-destructive bg-destructive/5",
  canceled: "border-muted-foreground/30 text-muted-foreground",
};

const READINESS_COPY: Record<string, { label: string; tone: string }> = {
  ready: { label: "Ready", tone: "border-emerald-500/40 text-emerald-500 bg-emerald-500/5" },
  pending: { label: "Pending", tone: "border-amber-500/40 text-amber-500 bg-amber-500/5" },
  action_required: { label: "Action required", tone: "border-destructive/40 text-destructive bg-destructive/5" },
  not_started: { label: "Not started", tone: "border-muted-foreground/30 text-muted-foreground" },
};

function SectionCard({
  title,
  icon,
  accent,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  accent: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden border-border/60 shadow-sm">
      <div className={`h-1.5 ${accent}`} />
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          {icon}
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-2">{children}</CardContent>
    </Card>
  );
}

export default function WalletOps() {
  const { tenant } = useTenant();
  const { userRole } = useAuth();
  const isAdmin = userRole === "admin";
  const { toast } = useToast();
  const { enabled, isLoading: eligibilityLoading } = usePaymentProviderEligibility();

  const { wallet, ledger, isLoading: walletLoading, setupRequired, refetch: refetchWallet } =
    useWallet("operating");
  const {
    config,
    settlementMethod,
    pushRails,
    history,
    stale,
    refetch: refetchSweeps,
    save,
  } = useSweepConfig("operating");
  const { data: transferData, isLoading: transfersLoading } = useWalletOpsTransfers();
  const { data: readiness } = useWalletOpsReadiness();

  const [payoutRail, setPayoutRail] = useState<SweepPushRail | "">("");

  const tenantBase = tenant?.slug
    ? isCheckOpsHost()
      ? `/${tenant.slug}`
      : `/wl/${tenant.slug}`
    : "";

  const syncFailed = wallet?.status === "sync_failed";
  const balanceLabel = syncFailed
    ? "Balance unavailable"
    : wallet
      ? money(wallet.available_cents)
      : setupRequired
        ? "Pending setup"
        : "Pending sync";

  const sweepsOn = config?.status === "enabled";
  const effectiveRail = (payoutRail || (config?.push_rail as SweepPushRail) || pushRails[0] || "") as
    | SweepPushRail
    | "";

  const lastSweep = history?.[0];
  const pendingOut = transferData?.pendingOutCents ?? 0;
  const pendingIn = transferData?.pendingInCents ?? 0;
  const minimumCents = config?.minimum_balance_cents ?? 0;


  async function handleSavePayoutSpeed() {
    if (!effectiveRail) return;
    try {
      await save.mutateAsync({
        pushRail: effectiveRail,
        minimumBalanceCents: minimumCents,
        statementDescriptor: config?.statement_descriptor ?? null,
        status: sweepsOn ? "enabled" : "disabled",
        enablePull: true,
      });
      toast({ title: "Payout speed updated" });
    } catch (e) {
      toast({
        title: "Could not update payout speed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  }

  if (!eligibilityLoading && !enabled) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <SectionCard title="WalletOps" icon={<Wallet className="h-4 w-4" />} accent="bg-primary/40">
          <p className="text-sm text-muted-foreground">
            Wallet and treasury operations aren't turned on for {tenant?.name ?? "your organization"} yet.
            Finish setting up your payment account and this dashboard activates automatically.
          </p>
          <Button asChild>
            <Link to={`${tenantBase}/payments`}>Go to Payment Account</Link>
          </Button>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/15 via-primary/5 to-background p-4 md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-xs font-bold uppercase tracking-widest text-primary">WalletOps</span>
            </div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Available operating balance</p>
            <div className="text-4xl font-bold tracking-tight md:text-5xl">
              {walletLoading ? "…" : balanceLabel}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={
                  syncFailed
                    ? READINESS_COPY.pending.tone
                    : wallet?.status === "active"
                      ? READINESS_COPY.ready.tone
                      : READINESS_COPY.not_started.tone
                }
              >
                {syncFailed
                  ? "Pending sync"
                  : wallet?.status === "active"
                    ? "Balance active"
                    : setupRequired
                      ? "Setup in progress"
                      : (wallet?.status ?? "Not set up")}
              </Badge>
              {wallet?.last_synced_at && !syncFailed && (
                <span className="text-[11px] text-muted-foreground">
                  Synced {new Date(wallet.last_synced_at).toLocaleString()}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-500">
                <ArrowDownLeft className="h-3 w-3" /> Pending in
              </div>
              <div className="mt-1 text-xl font-semibold">
                {transfersLoading ? "…" : money(pendingIn)}
              </div>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-500">
                <ArrowUpRight className="h-3 w-3" /> Pending out
              </div>
              <div className="mt-1 text-xl font-semibold">
                {transfersLoading ? "…" : money(pendingOut)}
              </div>
            </div>
            <Button
              variant="outline"
              className="col-span-2 bg-background/60"
              onClick={() => {
                refetchWallet();
                refetchSweeps();
              }}
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Refresh balances
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Wallet & Treasury */}
        <SectionCard
          title="Wallet & Treasury"
          icon={<Landmark className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
          action={
            <Badge variant="outline" className={sweepsOn ? STATUS_TONE.completed : "border-muted-foreground/30 text-muted-foreground"}>
              {sweepsOn ? "Automatic payouts on" : "Automatic payouts off"}
            </Badge>
          }
        >
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Settlement bank</p>
              <p className="mt-0.5 font-medium">
                {settlementMethod
                  ? `${settlementMethod.bank_name ?? "Bank"} ••${settlementMethod.last_four ?? "----"}`
                  : "Not connected"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Minimum retained</p>
              <p className="mt-0.5 font-medium">{money(minimumCents)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Payout speed</p>
              <p className="mt-0.5 font-medium">
                {config?.push_rail ? (SWEEP_RAIL_LABEL[config.push_rail] ?? config.push_rail) : "Not set"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last automatic payout</p>
              <p className="mt-0.5 font-medium">
                {lastSweep
                  ? new Date(lastSweep.completedOn ?? lastSweep.createdOn ?? Date.now()).toLocaleDateString()
                  : "None yet"}
              </p>
            </div>
          </div>

          {stale && (
            <p className="text-xs text-muted-foreground">
              Showing the last known settings — we couldn't reach the banking network just now.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button className="gap-2">
                  <Gauge className="h-4 w-4" />
                  Manage sweeps
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Treasury & automatic payouts</DialogTitle>
                </DialogHeader>
                <MoovTreasuryPanel />
              </DialogContent>
            </Dialog>

            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" className="gap-2">
                  <Banknote className="h-4 w-4" />
                  Add funds
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Operating balance</DialogTitle>
                </DialogHeader>
                <WalletPanel />
              </DialogContent>
            </Dialog>
          </div>
        </SectionCard>

        {/* Payout preferences */}
        <SectionCard
          title="Payout Preferences"
          icon={<Zap className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
        >
          {pushRails.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect and verify a settlement bank to choose payout speeds.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="walletops-rail">Default payout speed</Label>
                <Select
                  value={effectiveRail}
                  onValueChange={(v) => setPayoutRail(v as SweepPushRail)}
                  disabled={!isAdmin}
                >
                  <SelectTrigger id="walletops-rail">
                    <SelectValue placeholder="Choose a speed" />
                  </SelectTrigger>
                  <SelectContent>
                    {pushRails.map((r) => (
                      <SelectItem key={r} value={r}>
                        {SWEEP_RAIL_LABEL[r] ?? r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {effectiveRail && (
                  <p className="text-xs text-muted-foreground">{SWEEP_RAIL_HINT[effectiveRail]}</p>
                )}
              </div>

              <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 text-xs text-muted-foreground">
                Instant delivery is used automatically when the receiving bank supports it; otherwise the
                payment falls back to same-day or standard ACH so it always lands.
              </div>

              {isAdmin ? (
                <Button onClick={handleSavePayoutSpeed} disabled={save.isPending || !effectiveRail}>
                  {save.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                  Save payout preference
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Only administrators can change payout preferences.
                </p>
              )}
            </>
          )}
        </SectionCard>

        {/* Readiness shortcut */}
        <SectionCard
          title="Payment Account"
          icon={<BadgeCheck className="h-4 w-4 text-emerald-500" />}
          accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
          action={
            <Badge
              variant="outline"
              className={READINESS_COPY[readiness?.overall ?? "not_started"].tone}
            >
              {READINESS_COPY[readiness?.overall ?? "not_started"].label}
            </Badge>
          }
        >
          <div className="space-y-2">
            {(readiness?.checks ?? []).slice(0, 5).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{c.label}</span>
                <Badge variant="outline" className={`text-[10px] ${READINESS_COPY[c.state].tone}`}>
                  {READINESS_COPY[c.state].label}
                </Badge>
              </div>
            ))}
            {!readiness && (
              <p className="text-sm text-muted-foreground">Checking your account status…</p>
            )}
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              Settlement bank {settlementMethod ? "connected" : "not connected"}
            </span>
            <Button size="sm" asChild>
              <Link to={`${tenantBase}/payments`}>Open Payment Account</Link>
            </Button>
          </div>
        </SectionCard>
      </div>

      {/* Treasury health */}
      <SectionCard
        title="Treasury Health"
        icon={<Timer className="h-4 w-4 text-primary" />}
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
      >
        {syncFailed || !wallet ? (
          <p className="text-sm text-muted-foreground">
            Balance figures are unavailable right now, so coverage can't be calculated. Try refreshing in a
            moment.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Spendable after reserve
                </p>
                <p className="mt-1 text-xl font-semibold">{money(coverage?.spendable ?? 0)}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Payouts in flight
                </p>
                <p className="mt-1 text-xl font-semibold">{money(pendingOut)}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Automatic payouts
                </p>
                <p className="mt-1 text-xl font-semibold">{sweepsOn ? "On" : "Off"}</p>
              </div>
            </div>

            {pendingOut > 0 && (
              <div className="space-y-1.5">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full transition-all duration-500 ${
                      coverage?.covered ? "bg-emerald-500" : "bg-amber-500"
                    }`}
                    style={{ width: `${Math.round((coverage?.ratio ?? 0) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {coverage?.covered
                    ? "Your balance covers every payout currently in flight."
                    : "Payouts in flight exceed your spendable balance — add funds to avoid delays."}
                </p>
              </div>
            )}

            {!coverage?.covered && pendingOut > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400">
                <CircleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                Add funds or pause automatic payouts until in-flight payments settle.
              </div>
            )}
          </>
        )}
      </SectionCard>

      {/* Recent activity */}
      <SectionCard
        title="Recent Wallet Activity"
        icon={<Clock className="h-4 w-4 text-sky-500" />}
        accent="bg-gradient-to-r from-sky-500/60 to-transparent"
      >
        {ledger.length === 0 && (transferData?.transfers.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No wallet activity yet. Funding, payouts, and automatic payouts appear here.
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {ledger.slice(0, 6).map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {ENTRY_LABEL[entry.entry_type] ?? entry.entry_type}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(entry.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className={entry.direction === "credit" ? "font-semibold text-emerald-500" : "font-semibold"}>
                    {entry.direction === "credit" ? "+" : "−"}
                    {money(entry.amount_cents)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Balance {money(entry.balance_after_cents)}
                  </p>
                </div>
              </div>
            ))}
            {(transferData?.transfers ?? []).slice(0, 6).map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {t.is_facilitator_fee ? "Processing fee" : t.description || "Payout"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(t.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`text-[10px] ${STATUS_TONE[(t.status ?? "").toLowerCase()] ?? "border-muted-foreground/30 text-muted-foreground"}`}
                  >
                    {t.status}
                  </Badge>
                  <span className="font-semibold">{money(t.amount_cents)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
