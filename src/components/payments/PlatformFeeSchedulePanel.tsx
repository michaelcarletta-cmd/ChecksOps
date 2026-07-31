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
import { CalendarClock, Loader2, RefreshCw } from "lucide-react";
import { usePlatformFees } from "@/hooks/usePlatformFees";
import { useToast } from "@/hooks/use-toast";
import type { FeeAmountMode } from "@/lib/payments/feeSchedules";

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const dateLabel = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

/**
 * Recurring platform fees: what accrues this period, when it gets pulled, and
 * the history of past charges. Fees attached to a payout are not shown here —
 * those are taken from the payout itself.
 */
export function PlatformFeeSchedulePanel() {
  const {
    enabled,
    schedules,
    occurrences,
    unbilled,
    unbilledTotalCents,
    isLoading,
    error,
    refetch,
    save,
    cancel,
    rollUp,
  } = usePlatformFees();
  const { toast } = useToast();

  const active = schedules[0] ?? null;
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [amountMode, setAmountMode] = useState<FeeAmountMode>("usage");
  const [fixedAmount, setFixedAmount] = useState("");

  useEffect(() => {
    if (!active) return;
    setDayOfMonth(String(active.day_of_month ?? 1));
    setAmountMode((active.amount_mode as FeeAmountMode) ?? "usage");
    setFixedAmount(active.amount_cents ? String(active.amount_cents / 100) : "");
  }, [active?.id]);

  if (!enabled) return null;
  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading fee billing…</div>;

  async function handleSave() {
    const amountCents = amountMode === "fixed" ? Math.round(Number(fixedAmount) * 100) : 0;
    if (amountMode === "fixed" && (!Number.isFinite(amountCents) || amountCents <= 0)) {
      toast({ title: "Enter a base amount greater than zero.", variant: "destructive" });
      return;
    }
    try {
      await save.mutateAsync({
        cadence: "monthly",
        dayOfMonth: Number(dayOfMonth) || 1,
        amountMode,
        amountCents,
      });
      toast({ title: active ? "Fee schedule updated" : "Fee schedule created" });
    } catch (e) {
      toast({ title: "Could not save the fee schedule", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function handleRollUp(dryRun: boolean) {
    try {
      const res = await rollUp.mutateAsync({ dryRun });
      toast({
        title: dryRun ? "Preview" : res.skipped ? "Nothing to bill" : "Charge scheduled",
        description: `${money(res.amount_cents)} across ${res.line_item_count} item(s).`,
      });
    } catch (e) {
      toast({ title: "Roll-up failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" />
            Recurring platform fees
          </CardTitle>
          <CardDescription>
            Usage that isn't tied to a payout is totalled each period and pulled from your bank
            account on the day you choose.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-5">
        {error && <p className="text-sm text-destructive">{error.message}</p>}

        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <div>
            <p className="text-xs text-muted-foreground">Accrued this period</p>
            <p className="text-lg font-semibold">{money(unbilledTotalCents)}</p>
          </div>
          <Badge variant="secondary">{unbilled.length} item(s)</Badge>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" disabled={rollUp.isPending} onClick={() => handleRollUp(true)}>
              Preview
            </Button>
            <Button size="sm" disabled={rollUp.isPending || !active} onClick={() => handleRollUp(false)}>
              {rollUp.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Bill now
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="fee-day">Charge day of month</Label>
            <Input
              id="fee-day"
              type="number"
              min={1}
              max={28}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Amount</Label>
            <Select value={amountMode} onValueChange={(v) => setAmountMode(v as FeeAmountMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="usage">Usage only</SelectItem>
                <SelectItem value="fixed">Base + usage</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fee-base">Base amount (USD)</Label>
            <Input
              id="fee-base"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              disabled={amountMode !== "fixed"}
              value={fixedAmount}
              onChange={(e) => setFixedAmount(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={save.isPending} onClick={handleSave}>
            {save.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {active ? "Update schedule" : "Create schedule"}
          </Button>
          {active && (
            <>
              <Badge variant="outline">Next charge {dateLabel(active.next_run_at)}</Badge>
              <Button
                variant="ghost"
                size="sm"
                disabled={cancel.isPending}
                onClick={async () => {
                  try {
                    await cancel.mutateAsync(active.id);
                    toast({ title: "Fee schedule cancelled" });
                  } catch (e) {
                    toast({
                      title: "Could not cancel",
                      description: (e as Error).message,
                      variant: "destructive",
                    });
                  }
                }}
              >
                Cancel schedule
              </Button>
            </>
          )}
        </div>

        {occurrences.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">Recent charges</p>
              {occurrences.map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">
                    {dateLabel(o.run_at)}
                    {o.period_start ? ` · ${o.period_start} – ${o.period_end}` : ""}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant={o.status === "failed" ? "destructive" : "secondary"}>{o.status}</Badge>
                    <span className="font-medium">{money(o.amount_cents)}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
