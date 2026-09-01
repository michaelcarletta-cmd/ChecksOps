import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
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
import { usePaymentRail } from "@/hooks/usePaymentRail";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";

type Speed = "next_day" | "same_day";

// Moov pricing — same schedule used by the claim-check disbursement console.
const SPEED_FEES: Record<Speed, number> = { next_day: 0.75, same_day: 1.00 };
const SPEED_LABELS: Record<Speed, string> = { next_day: "Next Day", same_day: "Same Day" };

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
}

export function RunPayrollDialog({ open, onOpenChange, onDone }: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const { isPlaid } = usePaymentRail();
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

  // Load eligible payees: verified, active, has consumer_code, not the primary debit account
  const { data: payees = [], isLoading } = useQuery({
    queryKey: ["payroll-eligible-payees", tenant?.id],
    enabled: !!tenant?.id && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, custname, account_type, verification_status, consumer_unique, is_primary, is_active")
        .eq("tenant_id", tenant!.id)
        .eq("is_active", true)
        .eq("is_primary", false)
        .in("verification_status", ["verified", "admin_override"])
        .not("consumer_unique", "is", null)
        .order("nickname", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const selected = useMemo(() => payees.find((p: any) => p.id === stakeholderId), [payees, stakeholderId]);
  const amount = Number.parseFloat(amountStr || "0");
  const fee = SPEED_FEES[speed];
  const total = amount + fee;
  const canContinue = !!selected && amount > 0 && Number.isFinite(amount);

  const guardFinancial = useFinancialGuard(tenant?.id);

  const runMutation = useMutation({
    mutationFn: async () => {
      await guardFinancial("payroll.run");
      if (!tenant?.id || !user?.id || !selected) throw new Error("Missing context");

      // Create disbursement batch (no claim linkage)
      const { data: batch, error: batchErr } = await supabase
        .from("disbursement_batches")
        .insert({
          tenant_id: tenant.id,
          created_by: user.id,
          check_amount: amount,
          reserve_held: 0,
          available_amount: amount,
          delivery_speed: speed,
          status: "pending",
          notes: memo ? `Payroll: ${memo}` : "Payroll disbursement",
        })
        .select("id")
        .single();
      if (batchErr) throw batchErr;

      // Insert single split
      const { error: splitErr } = await supabase.from("disbursement_splits").insert({
        batch_id: batch.id,
        tenant_id: tenant.id,
        stakeholder_account_id: selected.id,
        amount,
        pct_of_total: 100,
        idempotence_key: `payroll_${batch.id}_${Date.now()}`,
      });
      if (splitErr) throw splitErr;

      // Create payroll_runs record (pending)
      const { data: runRow, error: runErr } = await supabase
        .from("payroll_runs")
        .insert({
          tenant_id: tenant.id,
          stakeholder_account_id: selected.id,
          disbursement_batch_id: batch.id,
          amount,
          speed,
          memo: memo || null,
          initiated_by: user.id,
          status: "pending",
        })
        .select("id")
        .single();
      if (runErr) throw runErr;

      // Primary rail: Moov. Falls back to the legacy rail only when the
      // recipient/payer still needs payment setup.
      if (moovEnabled) {
        const { data: moovData, error: moovErr } = await supabase.functions.invoke("moov-disburse", {
          body: { batch_id: batch.id, source_kind: "bank" },
        });

        if (!moovErr && (moovData as any)?.success) {
          await supabase.from("payroll_runs").update({ status: "submitted" }).eq("id", runRow.id);
          return runRow.id;
        }

        let reason: any = (moovData as any) ?? null;
        if (moovErr) {
          try {
            reason = await (moovErr as any).context?.json?.();
          } catch {
            reason = null;
          }
        }
        const code = reason?.error ?? "";
        const recoverable = ["recipient_setup_required", "payer_setup_required", "insufficient_balance"].includes(code);

        if (!recoverable) {
          const msg = reason?.message ?? reason?.error ?? moovErr?.message ?? "Payment failed";
          await supabase.from("payroll_runs").update({ status: "failed", error: msg }).eq("id", runRow.id);
          throw new Error(msg);
        }
        
        // Fallback rail logic removed — Actum is disabled globally.
        const msg = reason?.message ?? "Recipient not ready for Moov payroll. Please connect their bank account via Moov first.";
        await supabase.from("payroll_runs").update({ status: "failed", error: msg }).eq("id", runRow.id);
        throw new Error(msg);
      }

      await supabase.from("payroll_runs").update({ status: "submitted" }).eq("id", runRow.id);
      return runRow.id;
    },
    onSuccess: () => {
      toast({ title: "Payment submitted", description: `$${amount.toFixed(2)} sent to ${selected?.nickname}.` });
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
                  <SelectValue placeholder={isLoading ? "Loading..." : payees.length ? "Choose a stakeholder" : "No eligible payees"} />
                </SelectTrigger>
                <SelectContent>
                  {payees.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.nickname} <span className="text-muted-foreground text-xs">· {p.custname}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {payees.length === 0 && !isLoading && (
                <Alert variant="default" className="mt-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    No eligible payees. Add a stakeholder in the <strong>Stakeholders</strong> tab and complete the bank-link before running payroll.
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
              <div className="flex justify-between"><span className="text-muted-foreground">Payee</span><span className="font-medium">{selected.nickname}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Account</span><span>{selected.custname}</span></div>
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
