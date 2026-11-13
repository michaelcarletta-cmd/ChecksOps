import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Landmark, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useWalletWithdraw } from "@/hooks/useWalletWithdraw";
import { displayCaseOrNull } from "@/lib/displayCase";
import { formatWalletMoney } from "@/lib/payments/operatingBalance";
import {
  arrivalText,
  centsToDollarInput,
  limitInputToCents,
  limitLabel,
  maskedBankLabel,
  parseDollarsToCents,
  precheckWithdrawAmount,
  SAME_DAY_RULE_TEXT,
  type WithdrawReply,
} from "@/lib/payments/walletWithdraw";

const money = formatWalletMoney;

type Step = "form" | "confirm" | "done";

/**
 * Wallet & Treasury → "Transfer to bank": the operating wallet to the organization's default
 * bank by same-day ACH. No fee, no admin approval, the same wallet.fund two-factor as Add funds.
 * The bank is shown (masked) and cannot be changed here: there is no bank picker. Without a
 * default bank nothing can be sent, and the dialog says where to choose one.
 */
export function TransferToBankDialog({
  availableCents,
  walletActive,
  paymentsHref,
  onTransferred,
}: {
  availableCents: number;
  walletActive: boolean;
  paymentsHref: string;
  onTransferred?: () => Promise<unknown> | void;
}) {
  const { toast } = useToast();
  const { defaultBank, limits, withdraw, saveLimits } = useWalletWithdraw();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [result, setResult] = useState<WithdrawReply | null>(null);

  const [editingLimits, setEditingLimits] = useState(false);
  const [perTransfer, setPerTransfer] = useState("");
  const [perDay, setPerDay] = useState("");
  const [limitsError, setLimitsError] = useState<string | null>(null);

  const bank = defaultBank.data ?? null;
  const bankLabel = maskedBankLabel(bank, displayCaseOrNull);
  const perTransferCents = limits.data?.wallet_withdraw_max_per_transfer_cents ?? null;
  const perDayCents = limits.data?.wallet_withdraw_max_per_day_cents ?? null;
  const available = Math.max(0, Number(availableCents || 0));
  const amountCents = parseDollarsToCents(amount);
  const canSend = walletActive && !!bank && available > 0;

  useEffect(() => {
    if (!editingLimits) {
      setPerTransfer(centsToDollarInput(perTransferCents));
      setPerDay(centsToDollarInput(perDayCents));
    }
  }, [editingLimits, perTransferCents, perDayCents]);

  function reset() {
    setStep("form");
    setAmount("");
    setFormError(null);
    setSendError(null);
    setIdempotencyKey(null);
    setResult(null);
    setEditingLimits(false);
    setLimitsError(null);
  }

  function handleReview() {
    setSendError(null);
    const refusal = precheckWithdrawAmount({ amountCents, availableCents: available, perTransferCents });
    if (refusal) {
      setFormError(refusal.message);
      return;
    }
    setFormError(null);
    // One key per confirmation: the two-factor retry and a repeated click on Send reuse it, so the
    // server never sends this transfer twice.
    setIdempotencyKey(crypto.randomUUID());
    setStep("confirm");
  }

  async function handleSend() {
    if (!amountCents || !idempotencyKey) return;
    setSendError(null);
    try {
      const reply = await withdraw.mutateAsync({ amountCents, idempotencyKey });
      setResult(reply);
      setStep("done");
      toast({ title: "Transfer to bank started", description: arrivalText(reply.expected_arrival) ?? reply.message });
      try {
        await onTransferred?.();
      } catch {
        /* the transfer started; a failed balance refresh is not a failed transfer */
      }
    } catch (e) {
      setSendError((e as Error).message);
    }
  }

  async function handleSaveLimits() {
    const nextPerTransfer = limitInputToCents(perTransfer);
    const nextPerDay = limitInputToCents(perDay);
    if (nextPerTransfer === "invalid" || nextPerDay === "invalid") {
      setLimitsError("Each limit must be empty (no limit) or an amount greater than zero.");
      return;
    }
    setLimitsError(null);
    try {
      await saveLimits.mutateAsync({
        wallet_withdraw_max_per_transfer_cents: nextPerTransfer,
        wallet_withdraw_max_per_day_cents: nextPerDay,
      });
      setEditingLimits(false);
      toast({ title: "Transfer limits saved" });
    } catch (e) {
      setLimitsError((e as Error).message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <ArrowUpRight className="h-4 w-4" />
          Transfer to bank
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transfer to bank</DialogTitle>
          <DialogDescription>
            Move money from your operating balance to your organization's default bank. No fee.
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">From</p>
                <p className="break-words font-medium">Operating balance</p>
                <p className="text-xs text-muted-foreground">{money(available)} available</p>
              </div>
              <div className="min-w-0 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">To (default bank)</p>
                <p className="flex items-center gap-1.5 break-words font-medium">
                  <Landmark className="h-3.5 w-3.5 shrink-0" />
                  {defaultBank.isLoading ? "Loading…" : bankLabel}
                </p>
                <p className="text-xs text-muted-foreground">Transfers go to the default bank only.</p>
              </div>
            </div>

            {defaultBank.error && (
              <p className="text-destructive">Could not load your default bank: {(defaultBank.error as Error).message}</p>
            )}

            {!defaultBank.isLoading && !defaultBank.error && !bank && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="min-w-0 space-y-1 break-words">
                  <p className="font-medium">No default bank</p>
                  <p className="text-muted-foreground">
                    Transfers to bank go only to your organization's default settlement bank, and none is set.
                    Choose a default bank in Payment Account, then come back here.
                  </p>
                  <Link to={paymentsHref} className="font-medium text-primary underline-offset-4 hover:underline">
                    Choose a default bank in Payment Account
                  </Link>
                </div>
              </div>
            )}

            {!walletActive && (
              <p className="text-muted-foreground">Your operating balance is not active yet, so nothing can be transferred.</p>
            )}
            {walletActive && available <= 0 && (
              <p className="text-muted-foreground">There is no available balance to transfer. Pending funds cannot be transferred.</p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="transfer-to-bank-amount">Amount</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="transfer-to-bank-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-40"
                  disabled={!canSend}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canSend}
                  onClick={() => setAmount(centsToDollarInput(perTransferCents !== null ? Math.min(available, perTransferCents) : available))}
                >
                  Transfer all available
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Up to your available balance{perTransferCents !== null || perDayCents !== null ? " and your transfer limits" : ""}.
              </p>
            </div>

            <div className="space-y-1 rounded-md border p-3">
              <p className="font-medium">Same-day ACH · No fee</p>
              <p className="text-xs text-muted-foreground">{SAME_DAY_RULE_TEXT}</p>
            </div>

            {formError && <p className="text-destructive">{formError}</p>}

            <div className="flex justify-end">
              <Button onClick={handleReview} disabled={!canSend || !amount.trim()}>
                Review transfer
              </Button>
            </div>

            <Separator />

            {/* Transfer limits: set by the organization; empty means no limit. Saving needs the two-factor code. */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">Transfer limits</p>
                {!editingLimits && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={limits.isLoading || !!limits.error}
                    onClick={() => setEditingLimits(true)}
                  >
                    Change limits
                  </Button>
                )}
              </div>
              {limits.error ? (
                <p className="text-destructive">{(limits.error as Error).message}</p>
              ) : !editingLimits ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Per transfer</p>
                    <p className="break-words">{limits.isLoading ? "…" : limitLabel(perTransferCents)}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Per day</p>
                    <p className="break-words">{limits.isLoading ? "…" : limitLabel(perDayCents)}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="transfer-limit-per-transfer">Per transfer</Label>
                      <Input
                        id="transfer-limit-per-transfer"
                        inputMode="decimal"
                        placeholder="No limit"
                        value={perTransfer}
                        onChange={(e) => setPerTransfer(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="transfer-limit-per-day">Per day</Label>
                      <Input
                        id="transfer-limit-per-day"
                        inputMode="decimal"
                        placeholder="No limit"
                        value={perDay}
                        onChange={(e) => setPerDay(e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                    Leave a box empty for no limit. Saving asks for your two-factor code.
                  </p>
                  {limitsError && <p className="text-destructive">{limitsError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saveLimits.isPending}
                      onClick={() => {
                        setEditingLimits(false);
                        setLimitsError(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button type="button" size="sm" disabled={saveLimits.isPending} onClick={handleSaveLimits}>
                      {saveLimits.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                      Save limits
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {step === "confirm" && amountCents && (
          <div className="space-y-4 text-sm">
            <p className="break-words">
              Send <span className="font-semibold">{money(amountCents)}</span> from your ChecksOps balance to{" "}
              <span className="font-semibold">{bankLabel}</span> by same-day ACH.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{SAME_DAY_RULE_TEXT}</li>
              <li>No fee.</li>
              <li>This cannot be cancelled once sent.</li>
            </ul>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              You may be asked for your two-factor code, the same as Add funds.
            </p>
            {sendError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="min-w-0 break-words text-destructive">{sendError}</p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                disabled={withdraw.isPending}
                onClick={() => {
                  setStep("form");
                  setSendError(null);
                  setIdempotencyKey(null);
                }}
              >
                Back
              </Button>
              <Button onClick={handleSend} disabled={withdraw.isPending}>
                {withdraw.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Send transfer
              </Button>
            </div>
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-4 text-sm">
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <div className="min-w-0 space-y-1 break-words">
                <p className="font-medium">Transfer to bank started</p>
                <p>
                  {money(result.transfer?.amount_cents ?? amountCents ?? 0)} to {bankLabel}.
                </p>
                {arrivalText(result.expected_arrival) && (
                  <p className="text-muted-foreground">Expected at your bank: {arrivalText(result.expected_arrival)}.</p>
                )}
                <p className="text-muted-foreground">
                  It shows in Recent Wallet Activity as "Transfer to bank" until it completes.
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
