import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DollarSign, ArrowDownCircle, Send, CheckCircle2, AlertCircle, Clock, FileCheck, X, Home } from "lucide-react";
import { format } from "date-fns";
import { DisbursementConsole } from "@/components/disbursement/DisbursementConsole";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { SendHomeownerBankLinkDialog } from "@/components/disbursement/SendHomeownerBankLinkDialog";
import { SendCheckTrackingLinkButton } from "@/components/homeowner-ledger/SendCheckTrackingLinkButton";
import { useState, useMemo, useEffect } from "react";
import { toast } from "@/hooks/use-toast";


interface Props {
  checkIntakeItemId: string;
  checkNumber?: string;
  carrierName?: string;
  claimId?: string | null;
  detectedClaimNumber?: string | null;
  payoutEnabled?: boolean;
}

const STATUS_CONFIG: Record<string, { label: string; icon: any; className: string }> = {
  pending: { label: "Pending", icon: Clock, className: "text-amber-600 border-amber-500/30 bg-amber-500/10" },
  submitted: { label: "In Transit", icon: Send, className: "text-blue-600 border-blue-500/30 bg-blue-500/10" },
  settled: { label: "Settled", icon: CheckCircle2, className: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10" },
  returned: { label: "Returned", icon: AlertCircle, className: "text-red-600 border-red-500/30 bg-red-500/10" },
  failed: { label: "Failed", icon: AlertCircle, className: "text-red-600 border-red-500/30 bg-red-500/10" },
};

type DisburseMode = null | "platform" | "external";

const toCents = (value: number) => Math.round((Number(value) || 0) * 100) / 100;

export function FundsTab({ checkIntakeItemId, checkNumber, carrierName, claimId, detectedClaimNumber, payoutEnabled = true }: Props) {
  const { tenant } = useTenant();
  const qc = useQueryClient();
  const [disburseMode, setDisburseMode] = useState<DisburseMode>(null);
  const [homeownerLinkOpen, setHomeownerLinkOpen] = useState(false);
  const [resending, setResending] = useState(false);

  // Existing homeowner bank link for this check (if any), so we can
  // offer a Resend button instead of forcing another Send flow when a link
  // was already sent but the homeowner hasn't finished verifying.
  const { data: existingHomeownerLink, refetch: refetchHomeownerLink } = useQuery({
    queryKey: ["homeowner-bank-link", checkIntakeItemId],
    enabled: !!checkIntakeItemId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("homeowner_bank_link_tokens")
        .select("id, homeowner_name, homeowner_email, status, expires_at, stakeholder_account_id, created_at")
        .eq("check_intake_item_id", checkIntakeItemId)
        .not("status", "in", "(revoked,completed)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const handleResendHomeownerLink = async () => {
    if (!existingHomeownerLink?.stakeholder_account_id) return;
    setResending(true);
    try {
      const { data, error } = await supabase.functions.invoke("stakeholder-resend-verification", {
        body: {
          stakeholder_account_id: existingHomeownerLink.stakeholder_account_id,
          recipient_email: existingHomeownerLink.homeowner_email,
        },
      });
      const errMsg = error?.message ?? (data as any)?.error;
      if (errMsg) {
        toast({ title: "Couldn't resend link", description: errMsg, variant: "destructive" });
      } else {
        toast({ title: "Payment link resent", description: `Sent to ${existingHomeownerLink.homeowner_email}` });
        refetchHomeownerLink();
      }
    } finally {
      setResending(false);
    }
  };

  const { data: incomingPayments = [], isLoading } = useQuery({
    queryKey: ["incoming-payments", checkIntakeItemId, tenant?.id],
    enabled: !!checkIntakeItemId && !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_check_payments")
        .select(`*, auth_code, sender:sender_tenant_id (id, name)`)
        .eq("check_intake_item_id", checkIntakeItemId)
        .eq("recipient_tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Payments this tenant RECEIVED on this check that were recorded by the
  // sender as a disbursement (external check, Moov, ACH — any method). These
  // roll into the same Received totals; there is no separate external lane.
  const { data: incomingSplits = [] } = useQuery({
    queryKey: ["incoming-splits", checkIntakeItemId, tenant?.id],
    enabled: !!checkIntakeItemId && !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("disbursement_splits")
        .select("id, amount, status, created_at, method, external_check_number, recipient_name, disbursement_batches!inner(check_intake_item_id)")
        .eq("recipient_tenant_id", tenant!.id)
        .neq("tenant_id", tenant!.id)
        .eq("disbursement_batches.check_intake_item_id", checkIntakeItemId);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Per-check PA fee
  const { data: intakeItem } = useQuery({
    queryKey: ["intake-pa-fee", checkIntakeItemId],
    enabled: !!checkIntakeItemId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("check_intake_items")
        .select("id, amount, pa_fee_pct, pa_fee_amount")
        .eq("id", checkIntakeItemId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: outgoingBatches = [] } = useQuery({
    queryKey: ["funds-tab-disbursements", checkIntakeItemId, tenant?.id],
    enabled: !!checkIntakeItemId && !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("disbursement_batches")
        .select(`id, created_at, status, disbursement_splits(id, amount, status, return_code, created_at, method, external_check_number, recipient_name, external_notes, stakeholder_accounts(nickname), actum_transactions(auth_code, response_reason))`)
        .eq("check_intake_item_id", checkIntakeItemId)
        .eq("tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Recurring recipients — distinct external recipients this tenant has paid before
  const { data: recurringRecipients = [] } = useQuery({
    queryKey: ["recurring-recipients", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("disbursement_splits")
        .select("recipient_name, recipient_type, created_at")
        .eq("tenant_id", tenant!.id)
        .eq("method", "external_check")
        .not("recipient_name", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      const seen = new Map<string, { name: string; type: string; count: number }>();
      for (const r of (data ?? []) as any[]) {
        const name = String(r.recipient_name ?? "").trim();
        if (!name) continue;
        const type = r.recipient_type ?? "other";
        const key = `${type}|${name.toLowerCase()}`;
        const existing = seen.get(key);
        if (existing) existing.count += 1;
        else seen.set(key, { name, type, count: 1 });
      }
      return Array.from(seen.values()).sort((a, b) => b.count - a.count);
    },
  });



  const outgoingSplits = outgoingBatches.flatMap((b: any) =>
    (b.disbursement_splits ?? []).map((s: any) => ({ ...s, batch_id: b.id }))
  );
  const totalDisbursed = toCents(outgoingSplits
    .filter((s: any) => s.status !== "failed" && s.status !== "cancelled" && s.status !== "returned")
    .reduce((sum: number, s: any) => sum + toCents(Number(s.amount || 0)), 0));

  const receivedFromPayments = toCents(
    incomingPayments
      .filter((p: any) => p.status === "settled")
      .reduce((sum: number, p: any) => sum + Number(p.payment_amount), 0)
    + (incomingSplits as any[])
      .filter((s: any) => s.status === "settled")
      .reduce((sum: number, s: any) => sum + Number(s.amount || 0), 0)
  );

  // Fallback: when there are no incoming PA→contractor payments, the check
  // amount itself represents the funds available on this check.
  const totalReceived = receivedFromPayments > 0
    ? receivedFromPayments
    : Number(intakeItem?.amount || 0);

  const totalInTransit = toCents(
    incomingPayments
      .filter((p: any) => p.status === "submitted")
      .reduce((sum: number, p: any) => sum + Number(p.payment_amount), 0)
    + (incomingSplits as any[])
      .filter((s: any) => s.status === "submitted" || s.status === "pending")
      .reduce((sum: number, s: any) => sum + Number(s.amount || 0), 0)
  );

  // PA fee math
  const [paFeeMode, setPaFeeMode] = useState<"pct" | "amount">("pct");
  const [paFeePct, setPaFeePct] = useState<string>("");
  const [paFeeAmt, setPaFeeAmt] = useState<string>("");

  useEffect(() => {
    if (intakeItem?.pa_fee_pct != null) {
      setPaFeeMode("pct");
      setPaFeePct(String(intakeItem.pa_fee_pct));
    } else if (intakeItem?.pa_fee_amount != null) {
      setPaFeeMode("amount");
      setPaFeeAmt(String(intakeItem.pa_fee_amount));
    }
  }, [intakeItem?.id]);

  useEffect(() => {
    if (!payoutEnabled && disburseMode === "platform") {
      setDisburseMode(null);
    }
  }, [payoutEnabled, disburseMode]);

  const paFeeComputed = useMemo(() => {
    if (paFeeMode === "pct") {
      const pct = parseFloat(paFeePct);
      if (isNaN(pct) || pct <= 0) return 0;
      return toCents((totalReceived * pct) / 100);
    }
    const amt = parseFloat(paFeeAmt);
    return isNaN(amt) ? 0 : toCents(amt);
  }, [paFeeMode, paFeePct, paFeeAmt, totalReceived]);

  const availableForDisbursement = Math.max(0, toCents(toCents(totalReceived) - paFeeComputed - totalDisbursed));

  const savePaFee = async () => {
    const payload: any = { pa_fee_pct: null, pa_fee_amount: null };
    if (paFeeMode === "pct") payload.pa_fee_pct = parseFloat(paFeePct) || null;
    else payload.pa_fee_amount = parseFloat(paFeeAmt) || null;
    const { error } = await (supabase as any)
      .from("check_intake_items").update(payload).eq("id", checkIntakeItemId);
    if (error) return toast({ title: "Couldn't save PA fee", description: error.message, variant: "destructive" });
    toast({ title: "PA fee saved" });
    qc.invalidateQueries({ queryKey: ["intake-pa-fee", checkIntakeItemId] });
  };

  // External check form
  const [extRecipient, setExtRecipient] = useState("");
  const [extRecipientType, setExtRecipientType] = useState<string>("vendor");
  const [extCheckNum, setExtCheckNum] = useState("");
  const [extAmount, setExtAmount] = useState("");
  const [extNotes, setExtNotes] = useState("");
  const [extSaving, setExtSaving] = useState(false);

  const recordExternal = async () => {
    const amt = toCents(parseFloat(extAmount));
    if (!extRecipient.trim() || !extCheckNum.trim() || !amt || amt <= 0) {
      return toast({ title: "Fill recipient, check #, and amount", variant: "destructive" });
    }
    if (amt > availableForDisbursement + 0.005) {
      return toast({ title: "Amount exceeds available funds", variant: "destructive" });
    }
    setExtSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData?.user?.id;
      if (!uid) throw new Error("Not signed in");
      // Create a batch for this external payment
      const { data: batch, error: bErr } = await (supabase as any)
        .from("disbursement_batches")
        .insert({
          tenant_id: tenant!.id,
          check_intake_item_id: checkIntakeItemId,
          created_by: uid,
          check_amount: amt,
          available_amount: amt,
          status: "completed",
          notes: `External check #${extCheckNum} to ${extRecipient}`,
          completed_at: new Date().toISOString(),
        })
        .select("id").single();

      if (bErr) throw bErr;
      const { error: sErr } = await (supabase as any)
        .from("disbursement_splits").insert({
          batch_id: batch.id,
          tenant_id: tenant!.id,
          amount: amt,
          status: "settled",
          method: "external_check",
          external_check_number: extCheckNum,
          recipient_name: extRecipient,
          recipient_type: extRecipientType,
          external_notes: extNotes || null,
          settled_at: new Date().toISOString(),
        });
      if (sErr) throw sErr;
      const remaining = Math.max(0, toCents(availableForDisbursement - amt));
      toast({
        title: "External disbursement recorded",
        description: remaining > 0
          ? `$${remaining.toLocaleString("en-US", { minimumFractionDigits: 2 })} remaining — record another to zero out.`
          : "This check is fully disbursed.",
      });
      setExtRecipient(""); setExtRecipientType("vendor"); setExtCheckNum(""); setExtAmount(""); setExtNotes("");
      // Keep the form open when funds remain so the tenant can immediately record the next payment.
      if (remaining <= 0.005) setDisburseMode(null);
      qc.invalidateQueries({ queryKey: ["funds-tab-disbursements", checkIntakeItemId, tenant?.id] });
      qc.invalidateQueries({ queryKey: ["recurring-recipients", tenant?.id] });
    } catch (e: any) {
      toast({ title: "Couldn't record external disbursement", description: e.message, variant: "destructive" });
    } finally {
      setExtSaving(false);
    }
  };

  if (isLoading) return <div className="text-sm text-muted-foreground p-4">Loading funds...</div>;

  const noIncoming = incomingPayments.length === 0;

  return (
    <div className="space-y-4 p-1">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2">
        <Card>
          <CardContent className="pt-3 pb-3">
            <div className="flex items-center gap-1.5 mb-1">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-xs text-muted-foreground">Received</span>
            </div>
            <p className="text-lg font-semibold text-emerald-600">
              ${totalReceived.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Send className="h-3.5 w-3.5 text-blue-400" />
              <span className="text-xs text-muted-foreground">In Transit</span>
            </div>
            <p className="text-lg font-semibold text-blue-600">
              ${totalInTransit.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* PA Fee + Ledger */}
      {totalReceived > 0 && (
        <Card>
          <CardContent className="pt-3 pb-3 space-y-3">
            {disburseMode === "platform" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">Public adjuster fee (optional)</Label>
                  <div className="flex gap-1">
                    <Button size="sm" variant={paFeeMode === "pct" ? "default" : "outline"} className="h-6 px-2 text-[10px]" onClick={() => setPaFeeMode("pct")}>%</Button>
                    <Button size="sm" variant={paFeeMode === "amount" ? "default" : "outline"} className="h-6 px-2 text-[10px]" onClick={() => setPaFeeMode("amount")}>$</Button>
                  </div>
                </div>
                <div className="flex gap-2">
                  {paFeeMode === "pct" ? (
                    <Input type="number" inputMode="decimal" step="0.01" placeholder="e.g. 10" className="h-8 text-sm" value={paFeePct} onChange={(e) => setPaFeePct(e.target.value)} />
                  ) : (
                    <Input type="number" inputMode="decimal" step="0.01" placeholder="$ amount" className="h-8 text-sm" value={paFeeAmt} onChange={(e) => setPaFeeAmt(e.target.value)} />
                  )}
                  <Button size="sm" className="h-8 text-xs" onClick={savePaFee}>Save</Button>
                </div>
              </div>
            )}


            <div className="border-t pt-2 space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Funds received</span><span>${totalReceived.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
              {paFeeComputed > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">PA fee{paFeeMode === "pct" && paFeePct ? ` (${paFeePct}%)` : ""}</span><span className="text-amber-600">− ${paFeeComputed.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
              )}
              <div className="flex justify-between"><span className="text-muted-foreground">Disbursed</span><span className="text-blue-600">− ${totalDisbursed.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
              <div className="border-t pt-1 flex justify-between text-sm font-medium"><span>Available for disbursement</span><span className="text-emerald-600">${availableForDisbursement.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
            </div>

            {outgoingSplits.length > 0 && (
              <div className="border-t pt-2 space-y-1">
                {outgoingSplits.map((s: any) => (
                  <div key={s.id} className="flex items-center justify-between text-[11px]">
                    <span className="truncate text-muted-foreground">
                      {s.recipient_name ?? s.stakeholder_accounts?.nickname ?? "—"}
                      {s.external_check_number && <span className="ml-1 font-mono">· Ck #{s.external_check_number}</span>}
                      {s.created_at && <span className="ml-1 text-muted-foreground/70">· {format(new Date(s.created_at), "MMM d")}</span>}
                    </span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span>${Number(s.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                      <Badge variant="outline" className={`text-[9px] ${
                        s.status === "settled" ? "text-emerald-600 border-emerald-500/30 bg-emerald-500/10" :
                        s.status === "returned" || s.status === "failed" ? "text-red-600 border-red-500/30 bg-red-500/10" :
                        s.status === "submitted" ? "text-blue-600 border-blue-500/30 bg-blue-500/10" :
                        "text-muted-foreground"
                      }`}>
                        {s.method === "external_check" ? "external" : s.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Homeowner links */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setHomeownerLinkOpen(true)}>
            <Home className="h-3.5 w-3.5 mr-1.5" />
            Send Homeowner Payment Link
          </Button>
          {existingHomeownerLink && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={resending}
              onClick={handleResendHomeownerLink}
              title={`Rotates the link and re-emails ${existingHomeownerLink.homeowner_email}`}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" />
              {resending ? "Resending…" : "Resend Payment Link"}
            </Button>
          )}
          <SendCheckTrackingLinkButton
            claimId={claimId ?? null}
            tenantId={tenant?.id ?? null}
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            label="Send Homeowner Tracking Link"
          />
        </div>
        {existingHomeownerLink && (
          <p className="text-[10px] text-muted-foreground">
            Payment link already sent to {existingHomeownerLink.homeowner_email}. Resending rotates the URL and extends it another 30 days.
          </p>
        )}
        <p className="text-[10px] text-muted-foreground">
          Payment link: homeowner verifies their bank account. Tracking link: homeowner sees the full timeline for every check on this claim.
        </p>
      </div>

      <SendHomeownerBankLinkDialog
        open={homeownerLinkOpen}
        onOpenChange={setHomeownerLinkOpen}
        checkIntakeItemId={checkIntakeItemId}
        claimId={claimId ?? null}
      />

      {/* Disburse buttons */}
      {availableForDisbursement > 0 && disburseMode === null && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Button
              className="w-full h-auto min-h-11 whitespace-normal break-words text-center text-sm px-3 py-2 leading-tight"
              onClick={() => setDisburseMode("platform")}
              disabled={!payoutEnabled}
            >
              <DollarSign className="h-4 w-4 mr-1.5 shrink-0" />
              <span className="min-w-0">Disburse to Stakeholders</span>
            </Button>
            <Button
              variant="outline"
              className="w-full h-auto min-h-11 whitespace-normal break-words text-center text-sm px-3 py-2 leading-tight"
              onClick={() => setDisburseMode("external")}
            >
              <FileCheck className="h-4 w-4 mr-1.5 shrink-0" />
              <span className="min-w-0">Disburse Outside ChecksOps</span>
            </Button>
          </div>
          {!payoutEnabled && (
            <p className="text-[10px] text-muted-foreground">
              Disbursement becomes available once this check is marked deposited.
            </p>
          )}
        </div>
      )}

      {disburseMode === "platform" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Disbursement</p>
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setDisburseMode(null)}>
              <X className="h-3 w-3 mr-1" />Cancel
            </Button>
          </div>
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
            Remaining to zero out: <span className="font-semibold">${availableForDisbursement.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>
          <InlineErrorBoundary label="Disbursement console">
            <DisbursementConsole
              checkIntakeItemId={checkIntakeItemId}
              checkAmount={availableForDisbursement}
              checkNumber={checkNumber}
              carrierName={carrierName}
              onComplete={() => {
                // Refresh disbursement totals then decide whether to keep the console open for the remainder.
                qc.invalidateQueries({ queryKey: ["funds-tab-disbursements", checkIntakeItemId, tenant?.id] }).then(() => {
                  // Give the query a tick to settle before deciding — if funds remain the console re-renders with the new remainder.
                  setTimeout(() => {
                    if (availableForDisbursement <= 0.005) setDisburseMode(null);
                  }, 300);
                });
              }}
            />
          </InlineErrorBoundary>
        </div>
      )}

      {disburseMode === "external" && (
        <Card>
          <CardContent className="pt-3 pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Record External Payment</p>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setDisburseMode(null)}>
                <X className="h-3 w-3 mr-1" />Cancel
              </Button>
            </div>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
              Remaining to zero out: <span className="font-semibold">${availableForDisbursement.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </div>

            <div className="space-y-2">
              {recurringRecipients.length > 0 && (
                <div>
                  <Label className="text-[11px]">Recurring recipient (optional)</Label>
                  <Select
                    value=""
                    onValueChange={(v) => {
                      const pick = recurringRecipients.find((r: any) => `${r.type}|${r.name}` === v);
                      if (pick) {
                        setExtRecipient(pick.name);
                        setExtRecipientType(pick.type);
                      }
                    }}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Pick a past recipient..." />
                    </SelectTrigger>
                    <SelectContent>
                      {recurringRecipients.map((r: any) => (
                        <SelectItem key={`${r.type}|${r.name}`} value={`${r.type}|${r.name}`} className="text-xs">
                          {r.name} <span className="text-muted-foreground">· {r.type} · {r.count}×</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid grid-cols-[1fr_140px] gap-2">
                <div>
                  <Label className="text-[11px]">Recipient</Label>
                  <Input className="h-8 text-sm" placeholder="e.g. ABC Roofing" value={extRecipient} onChange={(e) => setExtRecipient(e.target.value)} />
                </div>
                <div>
                  <Label className="text-[11px]">Type</Label>
                  <select
                    className="h-8 w-full rounded-md border bg-background text-sm px-2"
                    value={extRecipientType}
                    onChange={(e) => setExtRecipientType(e.target.value)}
                  >
                    <option value="subcontractor">Subcontractor</option>
                    <option value="contractor">Contractor</option>
                    <option value="sales_rep">Sales Rep</option>
                    <option value="appraisal">Appraisal</option>
                    <option value="supplier">Supplier</option>
                    <option value="adjuster">Adjuster</option>
                    <option value="vendor">Vendor</option>
                    <option value="insured">Insured</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[11px]">Check #</Label>
                  <Input className="h-8 text-sm font-mono" placeholder="1234" value={extCheckNum} onChange={(e) => setExtCheckNum(e.target.value)} />
                </div>
                <div>
                  <Label className="text-[11px]">Amount</Label>
                  <Input type="number" inputMode="decimal" step="0.01" className="h-8 text-sm" placeholder="0.00" value={extAmount} onChange={(e) => setExtAmount(e.target.value)} />
                </div>
              </div>
              <div>
                <Label className="text-[11px]">Notes (optional)</Label>
                <Input className="h-8 text-sm" placeholder="Memo, date paid, etc." value={extNotes} onChange={(e) => setExtNotes(e.target.value)} />
              </div>
              <p className="text-[10px] text-muted-foreground">Available: ${availableForDisbursement.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
              <Button className="w-full" disabled={extSaving} onClick={recordExternal}>
                {extSaving ? "Recording..." : "Record Payment"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Payment list */}
      <div className="space-y-2">
        {incomingPayments.map((payment: any) => {
          const cfg = STATUS_CONFIG[payment.status] ?? STATUS_CONFIG.pending;
          const StatusIcon = cfg.icon;
          return (
            <Card key={payment.id}>
              <CardContent className="pt-3 pb-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <ArrowDownCircle className="h-3.5 w-3.5 text-emerald-400" />
                      <p className="text-sm font-medium">
                        ${Number(payment.payment_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      From {payment.sender?.name ?? "Public Adjuster"}
                    </p>
                    {payment.created_at && (
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(payment.created_at), "MMM d, yyyy · h:mm a")}
                      </p>
                    )}
                  </div>
                  <Badge variant="outline" className={`text-[10px] flex-shrink-0 ${cfg.className}`}>
                    <StatusIcon className="h-2.5 w-2.5 mr-1" />
                    {cfg.label}
                  </Badge>
                </div>

                {payment.notes && (
                  <p className="text-xs text-muted-foreground italic">"{payment.notes}"</p>
                )}

                {payment.return_code && (
                  <div className="flex items-center gap-1.5 text-xs text-red-500">
                    <AlertCircle className="h-3 w-3" />
                    {payment.return_code} — {payment.return_desc}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

    </div>
  );
}
