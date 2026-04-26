import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Coins, CreditCard, History, Loader2, ShieldAlert, Wrench, Zap, Settings } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const QUICK_AMOUNTS = [10, 25, 50, 100, 250];
const MIN_USD = 5;
const MAX_USD = 5000;

export function TenantCreditManager() {
  const { tenantId } = useTenantFilter();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [usdInput, setUsdInput] = useState<string>("25");

  // Current balance + maintenance status
  const { data: balance, isLoading: balLoading } = useQuery({
    queryKey: ["tenant-credit-balance", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_credit_balances")
        .select("*")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!tenantId,
  });

  const { data: transactions = [] } = useQuery({
    queryKey: ["tenant-credit-transactions", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_credit_transactions")
        .select("*")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!tenantId,
  });

  const usdPerCredit = Number((balance as any)?.usd_per_credit ?? 0.015);
  const usdAmount = Math.max(0, Number(usdInput) || 0);
  const previewCredits = usdPerCredit > 0 ? Math.floor(usdAmount / usdPerCredit) : 0;
  const validUsd = usdAmount >= MIN_USD && usdAmount <= MAX_USD;

  // Top-up via Stripe Checkout (one-time)
  const topupMutation = useMutation({
    mutationFn: async (amount: number) => {
      const { data, error } = await supabase.functions.invoke("tenant-credit-topup", {
        body: { tenant_id: tenantId, usd_amount: amount },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.url) window.location.href = data.url;
    },
    onError: (e: any) => {
      toast({ title: "Top-up failed", description: e.message, variant: "destructive" });
    },
  });

  // Maintenance subscription
  const maintenanceMutation = useMutation({
    mutationFn: async (action: "start" | "manage") => {
      const body: any = { tenant_id: tenantId, action };
      if (action === "start") {
        // Default maintenance fee — admin can change in Stripe later, or pass a stored price_id
        body.usd_per_month = 99;
      }
      const { data, error } = await supabase.functions.invoke("tenant-maintenance-subscription", {
        body,
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.url) window.location.href = data.url;
    },
    onError: (e: any) => {
      toast({ title: "Subscription action failed", description: e.message, variant: "destructive" });
    },
  });

  const currentBalance = balance?.balance ?? 0;
  const isLow = currentBalance < 100;
  const isEmpty = currentBalance === 0;
  const maintActive = (balance as any)?.maintenance_subscription_status === "active"
    || (balance as any)?.maintenance_subscription_status === "trialing";

  return (
    <div className="space-y-6">
      {/* Disclaimer */}
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="pt-4 pb-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-amber-300">Pass-through billing</p>
              <p>
                You own this system. AI processing credits are billed at <strong>exact pass-through cost</strong> with
                no markup — currently <strong>${usdPerCredit.toFixed(4)}/credit</strong>. The optional monthly
                maintenance fee covers system support and updates only and is fully separate from credits.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Balance card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Coins className="h-4 w-4" /> Credit Balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          {balLoading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <div className="space-y-3">
              <div className="flex items-baseline gap-3">
                <span className={`text-3xl font-bold tabular-nums ${isEmpty ? "text-destructive" : isLow ? "text-amber-400" : "text-emerald-400"}`}>
                  {currentBalance.toLocaleString()}
                </span>
                <span className="text-sm text-muted-foreground">
                  credits (≈ ${(currentBalance * usdPerCredit).toFixed(2)} of AI usage)
                </span>
              </div>
              {(isEmpty || isLow) && (
                <div className={`flex items-center gap-1.5 text-xs ${isEmpty ? "text-destructive" : "text-amber-400"}`}>
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {isEmpty ? "No credits — AI processing is paused. Top up below." : "Low balance — consider topping up."}
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 text-center pt-2">
                <div>
                  <div className="text-lg font-semibold tabular-nums">{(balance?.lifetime_purchased ?? 0).toLocaleString()}</div>
                  <div className="text-[10px] text-muted-foreground">Lifetime Purchased</div>
                </div>
                <div>
                  <div className="text-lg font-semibold tabular-nums">{(balance?.lifetime_used ?? 0).toLocaleString()}</div>
                  <div className="text-[10px] text-muted-foreground">Lifetime Used</div>
                </div>
                <div>
                  <div className="text-lg font-semibold tabular-nums">${usdPerCredit.toFixed(4)}</div>
                  <div className="text-[10px] text-muted-foreground">Cost / Credit</div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top-up: custom dollar amount */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="h-4 w-4" /> Top Up Credits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Pay exactly what you use. Every dollar buys{" "}
            <strong>{(1 / usdPerCredit).toFixed(0)} credits</strong> at the current pass-through rate.
            Minimum top-up ${MIN_USD}.
          </p>

          <div className="flex flex-wrap gap-2">
            {QUICK_AMOUNTS.map((amt) => (
              <Button
                key={amt}
                size="sm"
                variant={Number(usdInput) === amt ? "default" : "outline"}
                onClick={() => setUsdInput(String(amt))}
              >
                ${amt}
              </Button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="usd-input" className="text-xs">Custom amount (USD)</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                <Input
                  id="usd-input"
                  type="number"
                  min={MIN_USD}
                  max={MAX_USD}
                  step="1"
                  value={usdInput}
                  onChange={(e) => setUsdInput(e.target.value)}
                  className="pl-7"
                />
              </div>
              <Button
                disabled={!validUsd || topupMutation.isPending}
                onClick={() => topupMutation.mutate(usdAmount)}
              >
                {topupMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  `Pay $${usdAmount.toFixed(2)}`
                )}
              </Button>
            </div>
            {usdAmount > 0 && (
              <p className="text-xs text-muted-foreground">
                {validUsd ? (
                  <>You'll receive <strong className="text-foreground">{previewCredits.toLocaleString()} credits</strong> (~{previewCredits} checks).</>
                ) : (
                  <span className="text-amber-400">Enter ${MIN_USD}–${MAX_USD}.</span>
                )}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Maintenance subscription — separate from credits */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wrench className="h-4 w-4" /> System Maintenance Fee
            {maintActive && <Badge className="text-[9px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-500/30">Active</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Monthly fee for ongoing support, updates, hosting, and bug fixes.
            <strong className="text-foreground"> Does not include AI credits</strong> — those are billed separately at pass-through cost above.
          </p>

          {maintActive ? (
            <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Maintenance subscription active</div>
                {(balance as any)?.maintenance_current_period_end && (
                  <div className="text-xs text-muted-foreground">
                    Renews {format(new Date((balance as any).maintenance_current_period_end), "MMM d, yyyy")}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={maintenanceMutation.isPending}
                onClick={() => maintenanceMutation.mutate("manage")}
              >
                <Settings className="h-3.5 w-3.5 mr-1.5" />
                Manage
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3">
              <div>
                <div className="text-sm font-medium">$99 / month</div>
                <div className="text-xs text-muted-foreground">Cancel anytime via Stripe customer portal.</div>
              </div>
              <Button
                size="sm"
                disabled={maintenanceMutation.isPending}
                onClick={() => maintenanceMutation.mutate("start")}
              >
                {maintenanceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start subscription"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transaction history */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4" /> Transaction History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No transactions yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {transactions.map((tx: any) => (
                <div key={tx.id} className="flex items-center justify-between text-xs py-1.5 border-b border-border/30 last:border-0">
                  <div>
                    <span className="text-foreground">{tx.description || tx.transaction_type}</span>
                    <span className="text-muted-foreground ml-2">
                      {format(new Date(tx.created_at), "MMM d, h:mm a")}
                    </span>
                  </div>
                  <span className={`font-mono font-medium ${tx.amount > 0 ? "text-emerald-400" : "text-destructive"}`}>
                    {tx.amount > 0 ? "+" : ""}{tx.amount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
