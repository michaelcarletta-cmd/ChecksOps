import { useState, useMemo, useRef } from "react";
import { useStepUp } from "@/hooks/useStepUp";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sendPayrollPayment, SendPaymentError } from "@/lib/payments/sends";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Zap, Clock, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useActiveStakeholders } from "@/hooks/useActiveStakeholders";
import { activeStakeholderName, isPayableStakeholder } from "@/lib/payments/activeStakeholders";

type Speed = "next_day" | "same_day";

// Moov pricing — same schedule used by the claim-check disbursement console.
const SPEED_FEES: Record<Speed, number> = { next_day: 0.75, same_day: 1.00 };
const SPEED_LABELS: Record<Speed, string> = { next_day: "Next Day", same_day: "Same Day" };
// The Moov rail for each payroll speed: Next Day is the standard ACH credit.
const SEND_SPEED: Record<Speed, "standard" | "same_day"> = { next_day: "standard", same_day: "same_day" };

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
}

export function RunPayrollDialog({ open, onOpenChange, onDone }: Props) {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const { enabled: moovEnabled } = usePaymentProviderEligibility();
  const qc = useQueryClient();

  const [stakeholderId, setStakeholderId] = useState<string>("");
  const [amountStr, setAmountStr] = useState<string>("");
  const [speed, setSpeed] = useState<Speed>("next_day");
  const [memo, setMemo] = useState<string>("");
  const [step, setStep] = useState<"form" | "confirm">("form");

  const resetForm = () => {
    setStakeholderId("");
    setAmountStr("");
    setSpeed("next_day");
    setMemo("");
    setStep("form");
  };

  // Every Active Stakeholder from Settings is listed (same query as Settings).
  // Only those whose bank setup is verified can be paid; the rest show why not.
  // (The old filter also required consumer_unique, a legacy rail field nothing
  // writes any more, so stakeholders added in Settings never appeared.)
  const { data: payees = [], isLoading } = useActiveStakeholders(tenant?.id, open);

  const selected = useMemo(
    () => payees.find((p) => p.id === stakeholderId && isPayableStakeholder(p)),
    [payees, stakeholderId],
  );
  const payableCount = payees.filter(isPayableStakeholder).length;
  const amount = Number.parseFloat(amountStr || "0");
  const fee = SPEED_FEES[speed];
  const total = amount + fee;
  const canContinue = !!selected && amount > 0 && Number.isFinite(amount);


  const { requireStepUp } = useStepUp();
  // One key per payment: retrying the same payment never pays twice.
  const pending = useRef<{ signature: string; key: string } | null>(null);

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!tenant?.id || !selected) throw new Error("Missing context");
      const amountCents = Math.round(amount * 100);
      const signature = JSON.stringify([selected.id, amountCents, speed, memo]);
      if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
      const idempotencyKey = pending.current.key;
      const send = () =>
        sendPayrollPayment({
          tenantId: tenant.id,
          stakeholderAccountId: selected.id,
          amountCents,
          speed: SEND_SPEED[speed],
          memo: memo || null,
          idempotencyKey,
        });
      const attempt = async () => {
        try {
          return await send();
        } catch (error) {
          // The server decides whether this login has confirmed two-factor; ask only when it says so.
          if (!(error instanceof SendPaymentError) || error.code !== "totp_required") throw error;
          const confirmed = await requireStepUp(
            {
              actionKey: "wallet.fund",
              checkId: null,
              tenantId: tenant.id,
              title: "Confirm payroll payment",
              description: "Enter the 6-digit code from your authenticator app. You'll only be asked once until you sign out.",
            },
            { force: true },
          );
          if (!confirmed) {
            pending.current = null;
            throw new Error("Payroll was cancelled. Two-factor confirmation is required.");
          }
          return send();
        }
      };
      // A long payment is finished in steps; each step continues the same payment.
      for (let step = 0; ; step += 1) {
        try {
          const result = await attempt();
          pending.current = null;
          return result;
        } catch (error) {
          if (error instanceof SendPaymentError && error.code === "send_incomplete" && step < 8) continue;
          throw error;
        }
      }
    },
    onSuccess: () => {
      toast({ title: "Payment submitted", description: `$${amount.toFixed(2)} sent to ${selected ? activeStakeholderName(selected) : "the payee"}.` });
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      resetForm();
      onOpenChange(false);
      onDone?.();
    },
    onError: (e: any) => {
      toast({ title: "Payroll failed", description: e.message ?? String(e), variant: "destructive" });
      setStep("form");
    },
  });

  if (!moovEnabled) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Payroll unavailable</DialogTitle>
            <DialogDescription>
              Bank payments are being migrated for this organization. Payroll runs will be
              available again shortly.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{step === "form" ? "Run Payroll Payment" : "Confirm Payment"}</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? "Send an ACH payment to any verified stakeholder — not tied to a specific claim check."
              : "Review the details below. This will move funds immediately."}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Payee</Label>
              <Select value={stakeholderId} onValueChange={setStakeholderId} disabled={isLoading}>
                <SelectTrigger>
                  <SelectValue placeholder={isLoading ? "Loading..." : payees.length ? "Choose a stakeholder" : "No active stakeholders"} />
                </SelectTrigger>
                <SelectContent>
                  {payees.map((p) => {
                    const payable = isPayableStakeholder(p);
                    return (
                      <SelectItem key={p.id} value={p.id} disabled={!payable}>
                        {activeStakeholderName(p)}
                        {p.custname && p.custname !== activeStakeholderName(p) && (
                          <span className="text-muted-foreground text-xs"> · {p.custname}</span>
                        )}
                        {!payable && <span className="text-muted-foreground text-xs"> · Bank setup pending</span>}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {payees.length === 0 && !isLoading && (
                <Alert variant="default" className="mt-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    No active stakeholders. Add a stakeholder in <strong>Settings</strong> and complete the bank-link before running payroll.
                  </AlertDescription>
                </Alert>
              )}
              {payees.length > 0 && payableCount === 0 && !isLoading && (
                <Alert variant="default" className="mt-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    None of your active stakeholders has finished bank setup yet. They can be paid once setup is verified.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Amount (USD)</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Delivery Speed</Label>
              <RadioGroup value={speed} onValueChange={(v) => setSpeed(v as Speed)}>
                {([
                  { v: "next_day" as Speed, Icon: Clock, cls: "" },
                  { v: "same_day" as Speed, Icon: Zap, cls: "text-blue-500" },
                ]).map(({ v, Icon, cls }) => {
                  const checked = speed === v;
                  return (
                    <label
                      key={v}
                      className={`flex items-center gap-2 rounded-md border p-2 cursor-pointer transition-colors ${
                        checked
                          ? "bg-gradient-success border-[hsl(var(--success))] text-[hsl(var(--success-foreground))] shadow-[0_4px_14px_-4px_hsl(var(--success)/0.4)]"
                          : "border-border hover:bg-accent"
                      }`}
                    >
                      <RadioGroupItem value={v} id={`speed-${v}`} />
                      <Icon className={`h-4 w-4 ${checked ? "" : cls}`} />
                      <span className="text-sm font-medium">{SPEED_LABELS[v]}</span>
                      <span className={`ml-auto text-xs ${checked ? "text-[hsl(var(--success-foreground)/0.9)]" : "text-muted-foreground"}`}>Fee ${SPEED_FEES[v].toFixed(2)}</span>
                    </label>
                  );
                })}
              </RadioGroup>
            </div>

            <div className="space-y-1.5">
              <Label>Memo (optional)</Label>
              <Textarea
                placeholder="e.g. Assistant week of Aug 4"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        )}

        {step === "confirm" && selected && (
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Payee</span><span className="font-medium">{activeStakeholderName(selected)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Account</span><span>{selected.custname ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-medium">${amount.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Speed</span><span>{SPEED_LABELS[speed]} (fee ${fee.toFixed(2)})</span></div>
              <div className="flex justify-between border-t border-border pt-2"><span>Total debit</span><span className="font-semibold">${total.toFixed(2)}</span></div>
              {memo && <div className="flex justify-between"><span className="text-muted-foreground">Memo</span><span className="text-right">{memo}</span></div>}
            </div>
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Once you confirm, funds will be debited from your primary account and credited to the payee. This cannot be undone.
              </AlertDescription>
            </Alert>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === "form" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button variant="success" disabled={!canContinue} onClick={() => setStep("confirm")}>Continue</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep("form")} disabled={runMutation.isPending}>Back</Button>
              <Button variant="success" onClick={() => runMutation.mutate()} disabled={runMutation.isPending}>
                {runMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Yes, send ${total.toFixed(2)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
