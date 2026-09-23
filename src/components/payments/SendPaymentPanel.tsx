import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/usePermissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, Send, Building2, CheckCircle2, Loader2, DollarSign, ShieldAlert, ShieldCheck } from "lucide-react";
import { VERIFICATION_LABEL, VERIFICATION_BADGE_CLASS, type VerificationStatus } from "@/lib/banking";

import { usePaymentRail } from "@/hooks/usePaymentRail";

interface Props {
  checkIntakeItemId: string;
  checkAmount: number;
  checkNumber?: string;
  carrierName?: string;
  // The contractor tenant who is the recipient
  contractorTenantId: string;
  contractorName: string;
}

export function SendPaymentPanel({
  checkIntakeItemId,
  checkAmount,
  checkNumber,
  carrierName,
  contractorTenantId,
  contractorName,
}: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [feeType, setFeeType] = useState<"pct" | "flat">("pct");
  const [feeValue, setFeeValue] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [adminOverride, setAdminOverride] = useState(false);
  const { isAdmin } = usePermissions();

  // Load contractor's primary stakeholder account
  const { data: contractorAccount, isLoading: accountLoading } = useQuery({
    queryKey: ["contractor-primary-account", contractorTenantId],
    enabled: !!contractorTenantId,
    queryFn: async () => {
      // Prefer the flagged primary account, but fall back to any active
      // account (e.g. the provider-connected payment account) so recipients
      // who onboarded through the payment provider aren't reported as missing.
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, chk_acct, acct_type, custname, consumer_unique, verification_status, is_primary, origin")
        .eq("tenant_id", contractorTenantId)
        .eq("is_active", true)
        .order("is_primary", { ascending: false })
        .order("updated_at", { ascending: false });
      if (error) throw error;
      const rows = data ?? [];
      return (
        rows.find((r: any) => r.is_primary) ??
        rows.find((r: any) => r.origin === "provider_connected") ??
        rows.find((r: any) => r.verification_status === "verified") ??
        rows[0] ??
        null
      );
    },
  });


  // Load existing payment for this check if already sent
  const { data: existingPayment } = useQuery({
    queryKey: ["claim-check-payment", checkIntakeItemId, contractorTenantId],
    enabled: !!checkIntakeItemId && !!contractorTenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("claim_check_payments")
        .select("*")
        .eq("check_intake_item_id", checkIntakeItemId)
        .eq("recipient_tenant_id", contractorTenantId)
        .order("created_at", { ascending: false })
        .limit(1);
      return data?.[0] ?? null;
    },
  });

  // Calculate fee and payment amount
  const feeNum = parseFloat(feeValue || "0");
  const feeAmount = feeType === "pct"
    ? (isNaN(feeNum) ? 0 : (feeNum / 100) * checkAmount)
    : (isNaN(feeNum) ? 0 : feeNum);
  const paymentAmount = checkAmount - feeAmount;
  const disbursementFee = 1.00; // $1 pass-through per disbursement

  const sendPayment = useMutation({
    mutationFn: async () => {
      if (!user || !tenant || !contractorAccount) throw new Error("Missing required data");
      if (paymentAmount <= 0) throw new Error("Payment amount must be greater than 0");

      const idempotenceKey = `pay_${checkIntakeItemId}_${contractorTenantId}_${Date.now()}`;

      // Create the payment record
      const { data: payment, error: payErr } = await supabase
        .from("claim_check_payments")
        .insert({
          tenant_id: tenant.id,
          check_intake_item_id: checkIntakeItemId,
          sender_tenant_id: tenant.id,
          sender_user_id: user.id,
          recipient_tenant_id: contractorTenantId,
          recipient_stakeholder_account_id: contractorAccount.id,
          check_amount: checkAmount,
          pa_fee_pct: feeType === "pct" ? feeNum : null,
          pa_fee_amount: feeAmount,
          payment_amount: paymentAmount,
          status: "pending",
          idempotence_key: idempotenceKey,
          notes: notes || null,
        })
        .select("id")
        .single();

      if (payErr) throw payErr;

      throw new Error("This legacy payment rail has been removed. Please use the Moov payout hub.");
    },
    onSuccess: () => {
      toast({ title: "Payment sent", description: `$${paymentAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} sent to ${contractorName}` });
      qc.invalidateQueries({ queryKey: ["claim-check-payment"] });
      setConfirmed(false);
      setAdminOverride(false);
    },
    onError: (e: any) => toast({ title: "Payment failed", description: e.message, variant: "destructive" }),
  });

  // Already sent — show status
  if (existingPayment && existingPayment.status !== "pending") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Payment {existingPayment.status === "settled" ? "Settled" : existingPayment.status}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md bg-muted/50 p-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Sent to</span>
              <span className="font-medium">{contractorName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Check amount</span>
              <span>${Number(existingPayment.check_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Your fee</span>
              <span className="text-amber-600">− ${Number(existingPayment.pa_fee_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="font-medium">Amount sent</span>
              <span className="font-semibold text-emerald-600">${Number(existingPayment.payment_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-xs ${
              existingPayment.status === "settled" ? "text-emerald-600 border-emerald-500/30 bg-emerald-500/10" :
              existingPayment.status === "returned" ? "text-red-600 border-red-500/30 bg-red-500/10" :
              "text-blue-600 border-blue-500/30 bg-blue-500/10"
            }`}>
              {existingPayment.status}
              {existingPayment.return_code && ` · ${existingPayment.return_code}`}
            </Badge>
            {existingPayment.actum_order_id && (
              <span className="text-xs text-muted-foreground font-mono">Order #{existingPayment.actum_order_id}</span>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (accountLoading) return <div className="text-sm text-muted-foreground p-4">Loading contractor account...</div>;

  if (!contractorAccount) {
    return (
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-sm text-amber-600">
            <AlertTriangle className="h-4 w-4" />
            {contractorName} has not set up a primary bank account in ChecksOps yet. They need to add one in their Settings before you can send payment.
          </div>
        </CardContent>
      </Card>
    );
  }

  return <div className="p-6 text-center text-sm text-muted-foreground border rounded-lg">Contractor payments are currently moving to Moov. Please use the Disbursement Console for all payments.</div>;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Send className="h-4 w-4 text-blue-400" />
          Send Payment to Contractor
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Contractor account info */}
        {(() => {
          const vStatus = ((contractorAccount as any).verification_status ?? "unverified") as VerificationStatus;
          const isVerified = vStatus === "verified" || vStatus === "admin_override";
          return (
            <div className="rounded-md bg-muted/50 p-2.5 flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium">{contractorName}</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {contractorAccount.nickname} · {contractorAccount.chk_acct ? `••••${contractorAccount.chk_acct.slice(-4)}` : "Account pending"}
                </p>
              </div>
              <Badge
                variant="outline"
                className={`text-[10px] flex items-center gap-1 ${VERIFICATION_BADGE_CLASS[vStatus]}`}
              >
                {isVerified ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                {VERIFICATION_LABEL[vStatus]}
              </Badge>
            </div>
          );
        })()}

        {/* Fee input */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Your fee</Label>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={feeType === "pct" ? "default" : "outline"}
                className="h-6 text-xs px-2"
                onClick={() => setFeeType("pct")}
              >%</Button>
              <Button
                size="sm"
                variant={feeType === "flat" ? "default" : "outline"}
                className="h-6 text-xs px-2"
                onClick={() => setFeeType("flat")}
              >$</Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{feeType === "pct" ? "%" : "$"}</span>
            <Input
              type="number"
              min="0"
              step={feeType === "pct" ? "0.5" : "1"}
              placeholder={feeType === "pct" ? "10" : "1000"}
              className="h-8 text-sm"
              value={feeValue}
              onChange={(e) => { setFeeValue(e.target.value); setConfirmed(false); }}
            />
          </div>
        </div>

        {/* Payment summary */}
        <div className="rounded-md bg-muted/50 p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Check amount</span>
            <span className="font-medium">${checkAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">
              Your fee {feeType === "pct" && feeValue ? `(${feeValue}%)` : ""}
            </span>
            <span className="text-amber-600 font-medium">
              − ${feeAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div className="border-t pt-2 flex justify-between text-sm">
            <span className="font-medium">Sending to contractor</span>
            <span className="font-semibold text-emerald-600">
              ${paymentAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground border-t pt-2">
            <span>Transfer fee (passed through)</span>
            <span>$1.00</span>
          </div>
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <Label className="text-xs">Notes (optional)</Label>
          <Input
            className="h-8 text-sm"
            placeholder="e.g. Initial draw for roof repairs"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {/* Verification gate */}
        {(() => {
          const vStatus = ((contractorAccount as any).verification_status ?? "unverified") as VerificationStatus;
          const isVerified = vStatus === "verified" || vStatus === "admin_override";
          const blocked = !isVerified && !(isAdmin && adminOverride);
          return (
            <>
              {!isVerified && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2 text-xs">
                  <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                    <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    <div className="space-y-1">
                      <p className="font-medium">{contractorName}'s bank account hasn't been verified yet.</p>
                      <p className="text-[11px] opacity-90">
                        Status: <span className="font-medium">{VERIFICATION_LABEL[vStatus]}</span>. Have them confirm the verification code before sending, or an admin can override below.
                      </p>
                    </div>
                  </div>
                  {isAdmin && (
                    <label className="flex items-start gap-2 pt-1 cursor-pointer">
                      <Checkbox
                        checked={adminOverride}
                        onCheckedChange={(v) => setAdminOverride(v === true)}
                        className="mt-0.5"
                      />
                      <span className="text-[11px] text-amber-800 dark:text-amber-200">
                        <span className="font-semibold">Admin override:</span> send anyway. This is audit-logged.
                      </span>
                    </label>
                  )}
                </div>
              )}

              {/* Confirm toggle */}
              {!confirmed ? (
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={paymentAmount <= 0 || blocked}
                  onClick={() => setConfirmed(true)}
                >
                  {blocked ? (
                    <><ShieldAlert className="h-4 w-4 mr-2" />Verify account to send</>
                  ) : (
                    <><DollarSign className="h-4 w-4 mr-2" />Review & confirm payment</>
                  )}
                </Button>
              ) : (
                <div className="space-y-2">
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
                    You are about to send <strong>${paymentAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</strong> to {contractorName} for check #{checkNumber ?? "—"}. This cannot be undone once submitted.
                    {!isVerified && adminOverride && <div className="mt-1 font-semibold">Admin override active — verification will be bypassed and logged.</div>}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      onClick={() => sendPayment.mutate()}
                      disabled={sendPayment.isPending || blocked}
                    >
                      {sendPayment.isPending ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending...</>
                      ) : (
                        <><Send className="h-4 w-4 mr-2" />Confirm & send{!isVerified && adminOverride ? " (override)" : ""}</>
                      )}
                    </Button>
                    <Button variant="outline" onClick={() => setConfirmed(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </>
          );
        })()}

      </CardContent>
    </Card>
  );
}
