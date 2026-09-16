import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info, Landmark, Loader2, RefreshCw } from "lucide-react";
import { useSweepConfig } from "@/hooks/useSweepConfig";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import {
  dollarsToCents,
  SWEEP_RAIL_HINT,
  SWEEP_RAIL_LABEL,
  type SweepPushRail,
} from "@/lib/payments/sweeps";

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const sweepAmount = (value: unknown): string => {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.valueDecimal !== undefined) return money(Math.round(Number(v.valueDecimal) * 100));
    if (v.value !== undefined) return money(Number(v.value));
  }
  if (value === undefined || value === null) return "—";
  return money(Math.round(Number(value) * 100));
};

/**
 * Moov-native treasury sweeps: the provider automatically pays out the
 * organization's available balance every day, keeping the retained minimum in
 * place.
 */
export function MoovTreasuryPanel() {
  const { userRole } = useAuth();
  const isAdmin = userRole === "admin";
  const { toast } = useToast();
  const {
    enabled,
    config,
    wallet,
    settlementMethod,
    pushRails,
    pullAvailable,
    stale,
    history,
    isLoading,
    error,
    refetch,
    save,
    disable,
  } = useSweepConfig("operating");

  const [rail, setRail] = useState<SweepPushRail | "">("");
  const [minimum, setMinimum] = useState("");
  const [descriptor, setDescriptor] = useState("");

  useEffect(() => {
    setRail((config?.push_rail as SweepPushRail) ?? pushRails[0] ?? "");
    setMinimum(((config?.minimum_balance_cents ?? 0) / 100).toFixed(2));
    setDescriptor(config?.statement_descriptor ?? "");
  }, [config?.push_rail, config?.minimum_balance_cents, config?.statement_descriptor, pushRails.join(",")]);

  if (!enabled) return null;

  const isOn = config?.status === "enabled";

  async function handleSave() {
    if (!rail) {
      toast({ title: "Choose a payout speed first.", variant: "destructive" });
      return;
    }
    let cents: number;
    try {
      cents = dollarsToCents(minimum);
    } catch (e) {
      toast({ title: "Check the minimum balance", description: (e as Error).message, variant: "destructive" });
      return;
    }
    if (cents < 0) {
      toast({
        title: "Check the minimum balance",
        description: "Enter zero or a positive dollar amount to keep in the wallet.",
        variant: "destructive",
      });
      return;
    }
    try {
      await save.mutateAsync({
        pushRail: rail,
        minimumBalanceCents: cents,
        statementDescriptor: descriptor.trim() || null,
        status: "enabled",
        enablePull: true,
      });
      toast({
        title: "Daily payouts are on",
        description: cents === 0
          ? "Retain is $0.00 — the full wallet is paid out to the settlement bank each day. To send through ChecksOps, pause automatic payouts or keep a retain so funds stay in the wallet."
          : `Anything above ${money(cents)} is paid out automatically each day.`,
      });
    } catch (e) {
      toast({ title: "Could not save", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function handleDisable() {
    try {
      await disable.mutateAsync();
      toast({ title: "Daily payouts turned off" });
    } catch (e) {
      toast({ title: "Could not turn off", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className="h-4 w-4" />
            Treasury &amp; daily payouts
          </CardTitle>
          <CardDescription>
            Your provider can automatically pay out available balance to your settlement bank once a
            day. A $0.00 retain means keep nothing — the full wallet is pushed to the bank. To send
            payees through ChecksOps, pause automatic payouts or keep a retain so funds sit in the
            wallet.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading treasury settings…</p>}
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        {stale && (
          <p className="text-sm text-muted-foreground">
            Showing the last known settings — the provider could not be reached just now.
          </p>
        )}

        {!isLoading && (
          <>
            <div className="flex flex-wrap items-end gap-6">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Available balance</p>
                <p className="text-2xl font-semibold">
                  {wallet?.status === "sync_failed" ? "Unavailable" : money(wallet?.available_cents ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Settlement bank</p>
                <p className="text-sm">
                  {settlementMethod
                    ? `${settlementMethod.bank_name ?? "Bank"} ••${settlementMethod.last_four ?? "----"}`
                    : "Not connected"}
                </p>
              </div>
              <Badge
                variant="outline"
                className={
                  isOn
                    ? "border-emerald-500/40 text-emerald-500"
                    : "border-muted-foreground/30 text-muted-foreground"
                }
              >
                {isOn ? "Daily payouts on" : "Daily payouts off"}
              </Badge>
            </div>

            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-sm">
                Payouts run automatically once a day. Everything above the minimum balance you keep
                in the account is sent to your settlement bank. $0.00 retain empties the wallet, which
                is valid if you want the bank to hold the funds; it is not a required operating
                setting to use Moov.
                {pullAvailable
                  ? " If the balance ever goes negative, funds are pulled back from that same bank account by ACH debit to bring it to zero."
                  : " Connect a bank funding method to also let negative balances be corrected automatically."}
              </AlertDescription>
            </Alert>

            <Separator />

            {pushRails.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect and verify a settlement bank account to turn on daily payouts.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sweep-rail">Payout speed</Label>
                  <Select
                    value={rail}
                    onValueChange={(v) => setRail(v as SweepPushRail)}
                    disabled={!isAdmin}
                  >
                    <SelectTrigger id="sweep-rail">
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
                  {rail && (
                    <p className="text-xs text-muted-foreground">{SWEEP_RAIL_HINT[rail]}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="sweep-min">Minimum balance to keep</Label>
                  <Input
                    id="sweep-min"
                    inputMode="decimal"
                    value={minimum}
                    onChange={(e) => setMinimum(e.target.value)}
                    disabled={!isAdmin}
                  />
                  <p className="text-xs text-muted-foreground">
                    Held back in the account on every payout. $0.00 means push the full wallet.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="sweep-desc">Bank statement description</Label>
                  <Input
                    id="sweep-desc"
                    maxLength={10}
                    placeholder="CHECKSOPS"
                    value={descriptor}
                    onChange={(e) => setDescriptor(e.target.value)}
                    disabled={!isAdmin}
                  />
                  <p className="text-xs text-muted-foreground">Up to 10 characters.</p>
                </div>
              </div>
            )}

            {isAdmin && pushRails.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleSave} disabled={save.isPending}>
                  {save.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                  {isOn ? "Save changes" : "Turn on daily payouts"}
                </Button>
                {isOn && (
                  <Button variant="outline" onClick={handleDisable} disabled={disable.isPending}>
                    {disable.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                    Turn off
                  </Button>
                )}
              </div>
            )}
            {!isAdmin && (
              <p className="text-xs text-muted-foreground">
                Only administrators can change treasury settings.
              </p>
            )}

            {isOn && (
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Recent payouts</p>
                {history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No automatic payouts yet. They appear here after the first daily run.
                  </p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {history.slice(0, 8).map((s) => (
                      <div key={s.sweepID} className="flex items-center justify-between px-3 py-2 text-sm">
                        <div>
                          <p>{sweepAmount(s.accruedAmount)}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(s.completedOn ?? s.createdOn ?? Date.now()).toLocaleString()}
                          </p>
                        </div>
                        <Badge variant="outline">{s.status ?? "pending"}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
