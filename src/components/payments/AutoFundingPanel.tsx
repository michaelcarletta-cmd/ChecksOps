import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/hooks/useWallet";
import {
  AUTHORIZATION_VERSION,
  useAutoFunding,
  type FundingStrategy,
} from "@/hooks/useAutoFunding";

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const dollars = (cents: number) => (Number(cents || 0) / 100).toFixed(2);
const toCents = (v: string) => Math.round(Number(v || 0) * 100);

const STRATEGY_LABEL: Record<FundingStrategy, string> = {
  payment_shortage: "Fund payment shortage (recommended)",
  target_balance: "Maintain a wallet reserve",
  manual: "Manual funding only",
};

const STRATEGY_HINT: Record<FundingStrategy, string> = {
  payment_shortage: "Pulls only the amount an approved payment is short by.",
  target_balance:
    "ChecksOps watches your balance and pulls authorized funds to keep it at your target.",
  manual: "Nothing is pulled automatically — you start each transfer yourself.",
};

const FUNDING_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  authorization_required: "Authorization required",
  ready: "Ready",
  initiating: "Starting",
  pending: "In transit",
  completed: "Completed",
  failed: "Failed",
  returned: "Returned",
  canceled: "Canceled",
  action_required: "Action required",
};

/** Automatic funding controls: on/off, bank, strategy, limits and history. */
export function AutoFundingPanel({ canEdit = true }: { canEdit?: boolean }) {
  const { settings, requests, banks, saveSettings, fundManually, cancelFunding } = useAutoFunding();
  const { wallet } = useWallet("operating");
  const { toast } = useToast();

  const s = settings.data;
  const [strategy, setStrategy] = useState<FundingStrategy>("payment_shortage");
  const [bankId, setBankId] = useState<string>("");
  const [target, setTarget] = useState("0.00");
  const [maxSingle, setMaxSingle] = useState("25000.00");
  const [maxDaily, setMaxDaily] = useState("50000.00");
  const [manualAmount, setManualAmount] = useState("");

  useEffect(() => {
    if (!s) return;
    setStrategy(s.funding_strategy);
    setBankId(s.funding_bank_account_id ?? "");
    setTarget(dollars(s.target_wallet_balance_cents));
    setMaxSingle(dollars(s.maximum_single_pull_cents));
    setMaxDaily(dollars(s.maximum_daily_pull_cents));
  }, [s?.id]);

  const authorized = Boolean(s?.authorization_accepted_at);
  const selectedBank = (banks.data ?? []).find((b: any) => b.id === bankId);
  const reservedCents = 0;
  const availableCents = wallet?.available_cents ?? 0;
  const pendingCents = wallet?.pending_cents ?? 0;
  const lastRequest = requests.data?.[0];
  const attention = (requests.data ?? []).filter((r) =>
    ["failed", "returned", "action_required"].includes(r.status),
  );

  async function persist(patch: Record<string, unknown>) {
    try {
      await saveSettings.mutateAsync(patch as any);
      toast({ title: "Automatic funding updated" });
    } catch (e) {
      toast({ title: "Could not save", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function handleAuthorize() {
    if (!bankId) {
      toast({ title: "Choose a funding bank account first.", variant: "destructive" });
      return;
    }
    await persist({
      funding_bank_account_id: bankId,
      funding_strategy: strategy,
      target_wallet_balance_cents: toCents(target),
      maximum_single_pull_cents: toCents(maxSingle),
      maximum_daily_pull_cents: toCents(maxDaily),
      authorization_accepted_at: new Date().toISOString(),
      authorization_version: AUTHORIZATION_VERSION,
    });
  }

  async function handleManualFund() {
    const cents = toCents(manualAmount);
    if (cents <= 0) {
      toast({ title: "Enter an amount greater than zero.", variant: "destructive" });
      return;
    }
    try {
      await fundManually.mutateAsync(cents);
      setManualAmount("");
      toast({ title: "Transfer started", description: "Funds post once the bank transfer settles." });
    } catch (e) {
      toast({ title: "Could not start transfer", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-5">
      {/* Balances */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Available" value={money(availableCents)} />
        <Stat label="Pending in" value={money(pendingCents)} muted />
        <Stat label="Reserved for payments" value={money(reservedCents)} muted />
        <Stat label="Available to spend" value={money(availableCents - reservedCents)} />
      </div>

      {attention.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
          <div>
            <p className="font-medium">Funding needs attention</p>
            <p className="text-muted-foreground">
              {attention[0].failure_reason ??
                "A bank transfer into your wallet did not complete, so the related payment is on hold."}
            </p>
          </div>
        </div>
      )}

      <Separator />

      {/* Switch */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Automatic funding</p>
          <p className="text-xs text-muted-foreground">
            Top your wallet up from your own bank account when an approved payment is short.
          </p>
        </div>
        <Switch
          checked={Boolean(s?.auto_funding_enabled)}
          disabled={!canEdit || !authorized || saveSettings.isPending}
          onCheckedChange={(checked) => persist({ auto_funding_enabled: checked })}
        />
      </div>

      {!authorized && (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Bank debit authorization required
          </p>
          <p className="text-muted-foreground">
            You authorize ChecksOps to debit{" "}
            {selectedBank
              ? `${selectedBank.bank_name ?? "your bank"} ••••${selectedBank.last_four ?? ""}`
              : "your selected bank account"}{" "}
            for the amount an approved payment is short by (plus any reserve target you set), up to{" "}
            {money(toCents(maxSingle))} per transfer and {money(toCents(maxDaily))} per day. Each
            debit is initiated only for a payment you approved. You can revoke this authorization at
            any time by turning automatic funding off here.
          </p>
          <Button size="sm" onClick={handleAuthorize} disabled={!canEdit || saveSettings.isPending}>
            {saveSettings.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Accept and save
          </Button>
        </div>
      )}

      {authorized && (
        <p className="text-xs text-muted-foreground">
          Authorization accepted {new Date(s!.authorization_accepted_at!).toLocaleString()} (
          {s!.authorization_version ?? AUTHORIZATION_VERSION}).
        </p>
      )}

      {/* Settings */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Funding bank account</Label>
          <Select value={bankId} onValueChange={setBankId} disabled={!canEdit}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a verified bank" />
            </SelectTrigger>
            <SelectContent>
              {(banks.data ?? []).map((b: any) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.bank_name ?? "Bank"} ••••{b.last_four ?? "????"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Funding strategy</Label>
          <Select
            value={strategy}
            onValueChange={(v) => setStrategy(v as FundingStrategy)}
            disabled={!canEdit}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STRATEGY_LABEL) as FundingStrategy[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {STRATEGY_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{STRATEGY_HINT[strategy]}</p>
        </div>

        {strategy === "target_balance" && (
          <div className="space-y-1.5">
            <Label>Target wallet balance</Label>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} disabled={!canEdit} />
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Maximum single transfer</Label>
          <Input value={maxSingle} onChange={(e) => setMaxSingle(e.target.value)} disabled={!canEdit} />
        </div>

        <div className="space-y-1.5">
          <Label>Maximum per day</Label>
          <Input value={maxDaily} onChange={(e) => setMaxDaily(e.target.value)} disabled={!canEdit} />
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={!canEdit || saveSettings.isPending}
        onClick={() =>
          persist({
            funding_bank_account_id: bankId || null,
            funding_strategy: strategy,
            target_wallet_balance_cents: toCents(target),
            maximum_single_pull_cents: toCents(maxSingle),
            maximum_daily_pull_cents: toCents(maxDaily),
          })
        }
      >
        {saveSettings.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
        Save funding settings
      </Button>

      <Separator />

      {/* Manual funding */}
      <div className="space-y-2">
        <Label>One-time transfer from your bank</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-44"
            inputMode="decimal"
            placeholder="Amount"
            value={manualAmount}
            onChange={(e) => setManualAmount(e.target.value)}
            disabled={!canEdit || !authorized}
          />
          <Button onClick={handleManualFund} disabled={!canEdit || !authorized || fundManually.isPending}>
            {fundManually.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Transfer to wallet
          </Button>
        </div>
      </div>

      {/* History */}
      {(requests.data ?? []).length > 0 && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Recent funding</p>
          <div className="divide-y rounded-md border">
            {(requests.data ?? []).map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate">{money(r.requested_amount_cents)}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{FUNDING_STATUS_LABEL[r.status] ?? r.status}</Badge>
                  {["pending", "initiating", "ready"].includes(r.status) && canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => cancelFunding.mutate(r.id)}
                      disabled={cancelFunding.isPending}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {lastRequest && (
        <p className="text-xs text-muted-foreground">
          Last transfer {money(lastRequest.requested_amount_cents)} —{" "}
          {FUNDING_STATUS_LABEL[lastRequest.status] ?? lastRequest.status}.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold ${muted ? "text-muted-foreground" : ""}`}>{value}</p>
    </div>
  );
}
