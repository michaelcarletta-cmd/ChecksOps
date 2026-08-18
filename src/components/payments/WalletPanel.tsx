import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Loader2, RefreshCw, Wallet } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";

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
};

/**
 * Organization balance: fund once, then pay out of the balance instead of
 * pulling from the bank on every payout.
 */
export function WalletPanel() {
  const { enabled, wallet, ledger, isLoading, error, refetch, fund, setupRequired } =
    useWallet("operating");

  const { toast } = useToast();
  const [amount, setAmount] = useState("");

  if (!enabled) return null;

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading balance…</div>;
  }

  async function handleFund() {
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      toast({ title: "Enter an amount greater than zero.", variant: "destructive" });
      return;
    }
    try {
      await fund.mutateAsync({ amountCents: Math.round(dollars * 100), description: "Balance funding" });
      setAmount("");
      toast({ title: "Funding started", description: "Your balance updates once the transfer settles." });
    } catch (e) {
      toast({ title: "Could not fund balance", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" />
            Organization balance
          </CardTitle>
          <CardDescription>
            Pre-fund your balance and pay every party out of it — no bank pull per payout.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && !setupRequired && (
          <p className="text-sm text-destructive">{error.message}</p>
        )}
        {setupRequired && (
          <p className="text-sm text-muted-foreground">
            Your balance activates once your payment account finishes setup and approval. You can
            keep paying directly from your bank in the meantime.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-6">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Available</p>
            <p className="text-2xl font-semibold">
              {wallet?.status === "sync_failed" ? "Balance unavailable" : money(wallet?.available_cents ?? 0)}
            </p>
          </div>
          {!!wallet?.pending_cents && wallet?.status !== "sync_failed" && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Pending</p>
              <p className="text-lg">{money(wallet.pending_cents)}</p>
            </div>
          )}
          <Badge
            variant="outline"
            className={
              wallet?.status === "active"
                ? "border-emerald-500/40 text-emerald-500"
                : wallet?.status === "sync_failed"
                ? "border-amber-500/40 text-amber-500"
                : "border-muted-foreground/30 text-muted-foreground"
            }
          >
            {wallet?.status === "active" 
              ? "Active" 
              : wallet?.status === "sync_failed" 
              ? "Pending Sync" 
              : wallet?.status ?? "Not set up"}
          </Badge>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="Amount to add"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-44"
            disabled={setupRequired}
          />
          <Button onClick={handleFund} disabled={fund.isPending || setupRequired}>
            {fund.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}

            Add funds from bank
          </Button>
        </div>

        {ledger.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Recent activity</p>
            <div className="divide-y rounded-md border">
              {ledger.slice(0, 8).map((entry) => (
                <div key={entry.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div>
                    <p>{ENTRY_LABEL[entry.entry_type] ?? entry.entry_type}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(entry.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={entry.direction === "credit" ? "text-emerald-500" : "text-foreground"}>
                      {entry.direction === "credit" ? "+" : "−"}
                      {money(entry.amount_cents)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Balance {money(entry.balance_after_cents)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
