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
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Zap, Clock, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useActiveStakeholders } from "@/hooks/useActiveStakeholders";
import { activeStakeholderName, isPayableStakeholder } from "@/lib/payments/activeStakeholders";
import { PAYROLL_FINANCE_QUERY_KEY } from "@/lib/payments/payrollRows";
import { PAYROLL_SPEED_FEES, PAYROLL_SPEED_LABELS, type PayrollSpeed } from "@/lib/payments/payrollSpeedFees";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";
import { useVendorPayees } from "@/hooks/useVendorPayees";
import {
  VENDOR_INACTIVE_LABEL,
  VENDOR_WALLET_ONLY_NOTE,
  vendorPayeeName,
  vendorRecipientKey,
  vendorTenantIdFromKey,
} from "@/lib/payments/vendorPayees";

const SHOW_VENDOR_PAYMENTS = PAYMENT_FLAGS.SHOW_VENDOR_PAYMENTS;

type Speed = PayrollSpeed;
/** Who the payment is for: a stakeholder (ACH to its bank) or a vendor payee (its ChecksOps wallet). */
type PayeeKind = "stakeholder" | "vendor";

// Moov pricing — same schedule used by the claim-check disbursement console. One source,
// shared with Revenue & Profit, which counts the fee of each paid run as an expense.
const SPEED_FEES = PAYROLL_SPEED_FEES;
const SPEED_LABELS = PAYROLL_SPEED_LABELS;
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
  const [payeeKind, setPayeeKind] = useState<PayeeKind>("stakeholder");

  const resetForm = () => {
    setPayeeKind("stakeholder");
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
  // A vendor payee (Settings → Bank Account/Stakeholders → Vendors) is an allowed single recipient,
  // paid to its ChecksOps wallet only. Its select value is "vendor:<vendor_tenant_id>".
  const {
    data: vendorPayees = [],
    isLoading: vendorsLoading,
    error: vendorsError,
  } = useVendorPayees(tenant?.id, open);
  // The payee list is one kind at a time. Before, vendors were a group after every stakeholder in a
  // 300px list whose scrollbar Radix hides, so with a few stakeholders they were out of sight.
  const showingVendors = SHOW_VENDOR_PAYMENTS && payeeKind === "vendor";
  const choosePayeeKind = (kind: PayeeKind) => {
    if (kind === payeeKind) return;
    setPayeeKind(kind);
    setStakeholderId("");
  };
  const selectedVendor = useMemo(() => {
    const vendorTenantId = SHOW_VENDOR_PAYMENTS ? vendorTenantIdFromKey(stakeholderId) : null;
    return vendorTenantId ? vendorPayees.find((v) => v.vendor_tenant_id === vendorTenantId && v.vendor_active) ?? null : null;
  }, [vendorPayees, stakeholderId]);
  const payeeName = selectedVendor ? vendorPayeeName(selectedVendor) : selected ? activeStakeholderName(selected) : null;
  const payableCount = payees.filter(isPayableStakeholder).length;
  const amount = Number.parseFloat(amountStr || "0");
  const fee = SPEED_FEES[speed];
  const total = amount + fee;
  const canContinue = (!!selected || !!selectedVendor) && amount > 0 && Number.isFinite(amount);


  const { requireStepUp } = useStepUp();
  // One key per payment: retrying the same payment never pays twice.
  const pending = useRef<{ signature: string; key: string } | null>(null);

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!tenant?.id || (!selected && !selectedVendor)) throw new Error("Missing context");
      const amountCents = Math.round(amount * 100);
      const recipientKey = selectedVendor ? vendorRecipientKey(selectedVendor.vendor_tenant_id) : selected!.id;
      const signature = JSON.stringify([recipientKey, amountCents, speed, memo]);
      if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
      const idempotencyKey = pending.current.key;
      const send = () =>
        sendPayrollPayment({
          tenantId: tenant.id,
          stakeholderAccountId: selectedVendor ? null : selected!.id,
          vendorTenantId: selectedVendor?.vendor_tenant_id ?? null,
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
      toast({ title: "Payment submitted", description: `$${amount.toFixed(2)} sent to ${payeeName ?? "the payee"}.` });
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      // Payment History, Revenue & Profit, By Recipient and Tax & 1099 read payroll_runs too.
      qc.invalidateQueries({ queryKey: [PAYROLL_FINANCE_QUERY_KEY] });
      resetForm();
      onOpenChange(false);
      onDone?.();
    },
    onError: (e: any) => {
      toast({ title: "Payroll failed", description: e.message ?? String(e), variant: "destructive" });
      // A failed or partial send may still have recorded a payroll run.
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      qc.invalidateQueries({ queryKey: [PAYROLL_FINANCE_QUERY_KEY] });
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
              ? SHOW_VENDOR_PAYMENTS
                ? "Send a payment to any verified stakeholder, or to one of your vendors' ChecksOps wallet — not tied to a specific claim check."
                : "Send an ACH payment to any verified stakeholder — not tied to a specific claim check."
              : "Review the details below. This will move funds immediately."}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Payee</Label>
              {SHOW_VENDOR_PAYMENTS && (
                <div role="radiogroup" aria-label="Pay a" className="grid grid-cols-2 gap-2" data-testid="payroll-payee-kind">
                  {([
                    { choice: "stakeholder" as PayeeKind, label: "Stakeholder", hint: "ACH to their bank" },
                    { choice: "vendor" as PayeeKind, label: "Vendor", hint: "ChecksOps wallet" },
                  ]).map(({ choice, label, hint }) => {
                    const checked = payeeKind === choice;
                    return (
                      <button
                        key={choice}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        data-testid={`payroll-payee-kind-${choice}`}
                        onClick={() => choosePayeeKind(choice)}
                        className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                          checked ? "border-primary bg-primary/10 font-medium" : "border-border hover:bg-accent"
                        }`}
                      >
                        {label}
                        {choice === "vendor" && vendorPayees.length > 0 && (
                          <span className="text-muted-foreground text-xs"> ({vendorPayees.length})</span>
                        )}
                        <span className="block text-[11px] font-normal text-muted-foreground">{hint}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {showingVendors ? (
                <Select value={stakeholderId} onValueChange={setStakeholderId} disabled={vendorsLoading || vendorPayees.length === 0}>
                  <SelectTrigger>
                    <SelectValue placeholder={vendorsLoading ? "Loading..." : vendorPayees.length ? "Choose a vendor" : "No vendors yet"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel className="text-xs">Vendors (ChecksOps wallet)</SelectLabel>
                      {vendorPayees.map((v) => (
                        <SelectItem key={v.vendor_tenant_id} value={vendorRecipientKey(v.vendor_tenant_id)} disabled={!v.vendor_active}>
                          {vendorPayeeName(v)}
                          <span className="text-muted-foreground text-xs"> · {v.vendor_active ? "Vendor" : VENDOR_INACTIVE_LABEL}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
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
              )}
              {selectedVendor && (
                <p className="text-[11px] text-muted-foreground">{VENDOR_WALLET_ONLY_NOTE} The normal send fee applies.</p>
              )}
              {showingVendors && vendorsError && (
                <Alert variant="destructive" className="mt-2" data-testid="payroll-vendors-error">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    {vendorsError instanceof Error ? vendorsError.message : "Vendors could not be loaded"}
                  </AlertDescription>
                </Alert>
              )}
              {showingVendors && !vendorsLoading && !vendorsError && vendorPayees.length === 0 && (
                <Alert variant="default" className="mt-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    No vendors yet. Add a vendor by its Partner Code in <strong>Settings → Bank Account/Stakeholders → Vendors</strong>.
                  </AlertDescription>
                </Alert>
              )}
              {!showingVendors && payees.length === 0 && !isLoading && (
                <Alert variant="default" className="mt-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    No active stakeholders. Add a stakeholder in <strong>Settings</strong> and complete the bank-link before running payroll.
                  </AlertDescription>
                </Alert>
              )}
              {!showingVendors && payees.length > 0 && payableCount === 0 && !isLoading && (
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

        {step === "confirm" && (selected || selectedVendor) && (
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Payee</span><span className="font-medium">{payeeName}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Account</span><span>{selectedVendor ? "Vendor · ChecksOps wallet" : (selected?.custname ?? "—")}</span></div>
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
