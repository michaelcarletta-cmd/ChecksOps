import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import {
  Building2, Truck, PackageCheck, ArrowDownToLine,
  Lock, CheckCircle2, Plus, DollarSign, Headset,
} from "lucide-react";
import { format } from "date-fns";
import { MortgageDeskShippingCard } from "@/components/loss-draft/MortgageDeskShippingCard";


type Props = {
  checkId: string;
  onRefresh?: () => void;
};

export function CheckMortgageMonitoring({ checkId, onRefresh }: Props) {
  const qc = useQueryClient();
  const [trackingNumber, setTrackingNumber] = useState("");
  const [showTrackingInput, setShowTrackingInput] = useState(false);
  const [drawAmount, setDrawAmount] = useState("");
  const [drawNotes, setDrawNotes] = useState("");
  const [showDrawForm, setShowDrawForm] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDeskDialog, setShowDeskDialog] = useState(false);
  const [deskCompany, setDeskCompany] = useState("");
  const [deskLoan, setDeskLoan] = useState("");
  const [deskNote, setDeskNote] = useState("");
  const [deskSubmitting, setDeskSubmitting] = useState(false);

  const { data: check } = useQuery({
    queryKey: ["check-mortgage-data", checkId],
    queryFn: async () => {
      const { data } = await supabase
        .from("check_intake_items")
        .select("mortgage_monitoring_type, mortgage_sent_at, mortgage_tracking_number, mortgage_received_at, mortgage_final_released_at, tenant_id, claim_id, check_number")
        .eq("id", checkId)
        .single();
      return data as any;
    },
  });

  const { data: deskRequest, refetch: refetchDesk } = useQuery({
    queryKey: ["mortgage-desk-request", checkId],
    queryFn: async () => {
      const { data } = await supabase
        .from("mortgage_handling_requests")
        .select("id, status, mortgage_company, loan_number, created_at, completed_at, billing_status, billed_at, flat_fee_cents")
        .eq("check_intake_item_id", checkId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as any;
    },
  });


  const { data: draws = [] } = useQuery({
    queryKey: ["check-mortgage-draws", checkId],
    queryFn: async () => {
      const { data } = await supabase
        .from("check_intake_mortgage_draws")
        .select("*")
        .eq("check_id", checkId)
        .order("draw_number", { ascending: true });
      return (data ?? []) as any[];
    },
  });

  const monitoringType = check?.mortgage_monitoring_type ?? "not_set";
  const isSent = !!check?.mortgage_sent_at;
  const isReceived = !!check?.mortgage_received_at;
  const isFinalReleased = !!check?.mortgage_final_released_at;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["check-mortgage-data", checkId] });
    qc.invalidateQueries({ queryKey: ["check-mortgage-draws", checkId] });
    onRefresh?.();
  };

  async function setMonitoring(type: string) {
    setSaving(true);
    await supabase.from("check_intake_items").update({ mortgage_monitoring_type: type } as any).eq("id", checkId);
    setSaving(false);
    refresh();
  }

  async function markSentToMortgage() {
    setSaving(true);
    await supabase.from("check_intake_items").update({
      mortgage_sent_at: new Date().toISOString(),
      mortgage_tracking_number: trackingNumber || null,
    } as any).eq("id", checkId);
    setShowTrackingInput(false);
    setTrackingNumber("");
    setSaving(false);
    refresh();
  }

  async function markReceivedFromMortgage() {
    setSaving(true);
    await supabase.from("check_intake_items").update({ mortgage_received_at: new Date().toISOString() } as any).eq("id", checkId);
    setSaving(false);
    refresh();
  }

  async function markFinalRelease() {
    setSaving(true);
    await supabase.from("check_intake_items").update({ mortgage_final_released_at: new Date().toISOString() } as any).eq("id", checkId);
    setSaving(false);
    refresh();
  }

  async function submitDraw() {
    if (!showDrawForm) return;
    setSaving(true);
    const nextDrawNum = draws.length + 1;
    await supabase.from("check_intake_mortgage_draws").insert({
      check_id: checkId,
      draw_number: nextDrawNum,
      draw_type: showDrawForm,
      amount: drawAmount ? parseFloat(drawAmount) : null,
      status: showDrawForm === "draw_request" ? "requested" : "completed",
      notes: drawNotes || null,
      completed_at: showDrawForm !== "draw_request" ? new Date().toISOString() : null,
    } as any);
    setShowDrawForm(null);
    setDrawAmount("");
    setDrawNotes("");
    setSaving(false);
    refresh();
  }

  async function submitDeskRequest() {
    if (!check?.tenant_id) return;
    if (!deskCompany.trim()) {
      toast({ title: "Mortgage company required", variant: "destructive" });
      return;
    }
    setDeskSubmitting(true);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("mortgage_handling_requests").insert({
      tenant_id: check.tenant_id,
      check_intake_item_id: checkId,
      claim_id: check.claim_id ?? null,
      mortgage_company: deskCompany.trim(),
      loan_number: deskLoan.trim() || null,
      note: deskNote.trim() || null,
      requested_by: userData.user?.id ?? null,
    } as any).select("id").single();
    if (error) {
      // 23505 = duplicate open request; the partial unique index catches it
      const dup = /duplicate|unique/i.test(error.message);
      toast({
        title: dup ? "Request already open" : "Could not create request",
        description: dup ? "A ChecksOps mortgage request is already active for this check." : error.message,
        variant: "destructive",
      });
      setDeskSubmitting(false);
      if (dup) { setShowDeskDialog(false); refetchDesk(); }
      return;
    }
    // Fire-and-forget notification (never blocks the user)
    const { data: created } = await supabase
      .from("mortgage_handling_requests")
      .select("id")
      .eq("check_intake_item_id", checkId)
      .in("status", ["requested", "in_progress"])
      .maybeSingle();
    if (created?.id) {
      supabase.functions.invoke("notify-mortgage-handling-request", {
        body: { request_id: created.id },
      }).catch(() => {});
    }
    toast({ title: "ChecksOps has been notified", description: "Our team will contact the mortgage company." });
    setShowDeskDialog(false);
    setDeskCompany(""); setDeskLoan(""); setDeskNote("");
    setDeskSubmitting(false);
    refetchDesk();
  }

  if (!check) return null;

  const deskStatusLabel = deskRequest?.status === "requested" ? "Requested"
    : deskRequest?.status === "in_progress" ? "In progress"
    : deskRequest?.status === "completed" ? "Completed"
    : null;
  const deskOpen = deskRequest && ["requested", "in_progress"].includes(deskRequest.status);

  return (
    <div className="space-y-3">
      <Separator />
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold">Mortgage / Loss Draft</span>
        {deskStatusLabel && (
          <Badge
            variant={deskRequest?.status === "completed" ? "default" : "secondary"}
            className="text-[10px] gap-1"
          >
            <Headset className="h-2.5 w-2.5" /> ChecksOps handling: {deskStatusLabel}
          </Badge>
        )}
      </div>


      {/* Monitoring type selection */}
      {monitoringType === "not_set" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Is this check monitored by a mortgage company?</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={saving} onClick={() => setMonitoring("not_monitored")}>
              Not Monitored
            </Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={() => setMonitoring("monitored")}>
              Monitored
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Badge variant={monitoringType === "monitored" ? "default" : "secondary"} className="text-xs">
            {monitoringType === "monitored" ? "Monitored" : "Not Monitored"}
          </Badge>
          <Button size="sm" variant="ghost" className="text-xs h-6 px-2 text-muted-foreground" onClick={() => setMonitoring("not_set")}>
            Change
          </Button>
        </div>
      )}

      {/* ChecksOps Mortgage Desk — request live-people help */}
      {monitoringType === "monitored" && !deskOpen && deskRequest?.status !== "completed" && (
        <div className="rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Headset className="h-4 w-4 text-amber-400 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-semibold">Want us to handle the mortgage company?</p>
              <p className="text-[11px] text-muted-foreground">
                ChecksOps staff will contact the mortgage company on your behalf. Flat fee billed on completion.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowDeskDialog(true)}
          >
            <Headset className="h-3.5 w-3.5 mr-1" /> Have ChecksOps contact the mortgage company
          </Button>
        </div>
      )}
      {deskOpen && (
        <div className="rounded-md bg-muted/40 p-3 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <Headset className="h-3.5 w-3.5 text-amber-400" />
            <span className="font-semibold">ChecksOps is handling this mortgage company</span>
          </div>
          <div className="text-muted-foreground">
            {deskRequest?.mortgage_company ?? "—"}
            {deskRequest?.loan_number ? ` · Loan #${deskRequest.loan_number}` : ""}
            {" · "}Requested {format(new Date(deskRequest!.created_at), "MMM d")}
          </div>
        </div>
      )}
      {(deskOpen || deskRequest?.status === "completed") && (
        <MortgageDeskShippingCard checkIntakeItemId={checkId} />
      )}

      {deskRequest?.status === "completed" && (
        <div className="rounded-md bg-emerald-500/10 p-3 text-xs flex items-center gap-2 flex-wrap">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          <span>ChecksOps completed mortgage handling</span>
          {deskRequest.completed_at && (
            <span className="text-muted-foreground">· {format(new Date(deskRequest.completed_at), "MMM d, yyyy")}</span>
          )}
          {deskRequest.billing_status === "billed" && deskRequest.flat_fee_cents != null && (
            <span className="text-muted-foreground">
              · billed ${(deskRequest.flat_fee_cents / 100).toFixed(2)}
            </span>
          )}
          {deskRequest.billing_status === "failed" && (
            <span className="text-destructive">· billing failed — support has been notified</span>
          )}
        </div>
      )}




      {/* Sent status display */}
      {isSent && (
        <div className="rounded-md bg-muted/50 p-3 space-y-1 text-sm">
          <div className="flex items-center gap-2 text-emerald-400">
            <Truck className="h-3.5 w-3.5" />
            Sent to Mortgage Company
          </div>
          <div className="text-xs text-muted-foreground">
            {format(new Date(check.mortgage_sent_at!), "MMM d, yyyy h:mm a")}
          </div>
          {check.mortgage_tracking_number && (
            <div className="text-xs">
              <span className="text-muted-foreground">Tracking:</span>{" "}
              <span className="font-mono">{check.mortgage_tracking_number}</span>
            </div>
          )}
        </div>
      )}

      {/* NOT MONITORED path */}
      {monitoringType === "not_monitored" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Mortgage company will endorse and release — no escrow or draws.
          </p>
          {!isSent && (
            showTrackingInput ? (
              <div className="space-y-2">
                <Input placeholder="Tracking number (optional)" value={trackingNumber} onChange={e => setTrackingNumber(e.target.value)} className="h-8 text-sm" />
                <div className="flex gap-2">
                  <Button size="sm" disabled={saving} onClick={markSentToMortgage}>
                    <Truck className="h-3.5 w-3.5 mr-1" /> Confirm Sent
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowTrackingInput(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setShowTrackingInput(true)}>
                <Truck className="h-3.5 w-3.5 mr-1" /> Sent Check to Mortgage Company
              </Button>
            )
          )}
          {isSent && !isReceived && (
            <Button size="sm" variant="outline" disabled={saving} onClick={markReceivedFromMortgage}>
              <PackageCheck className="h-3.5 w-3.5 mr-1" /> Received Check from Mortgage Company
            </Button>
          )}
          {isReceived && (
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              Check received back from mortgage company
              <span className="text-xs text-muted-foreground">
                {format(new Date(check.mortgage_received_at!), "MMM d, yyyy")}
              </span>
            </div>
          )}
        </div>
      )}

      {/* MONITORED path */}
      {monitoringType === "monitored" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Mortgage company holding funds in escrow — track draws and releases.
          </p>
          {!isSent && (
            showTrackingInput ? (
              <div className="space-y-2">
                <Input placeholder="Tracking number (optional)" value={trackingNumber} onChange={e => setTrackingNumber(e.target.value)} className="h-8 text-sm" />
                <div className="flex gap-2">
                  <Button size="sm" disabled={saving} onClick={markSentToMortgage}>
                    <Truck className="h-3.5 w-3.5 mr-1" /> Confirm Sent
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowTrackingInput(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setShowTrackingInput(true)}>
                <Truck className="h-3.5 w-3.5 mr-1" /> Check Sent to Mortgage Company
              </Button>
            )
          )}

          {isSent && !isFinalReleased && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowDrawForm("draw_request")}>
                <ArrowDownToLine className="h-3.5 w-3.5 mr-1" /> Request Draw
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowDrawForm("release")}>
                <DollarSign className="h-3.5 w-3.5 mr-1" /> Record Release
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowDrawForm("holdback")}>
                <Lock className="h-3.5 w-3.5 mr-1" /> Record Holdback
              </Button>
              <Button size="sm" variant="default" disabled={saving} onClick={markFinalRelease}>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Mark Final Release
              </Button>
            </div>
          )}

          {isFinalReleased && (
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              Final release completed
              <span className="text-xs text-muted-foreground">
                {format(new Date(check.mortgage_final_released_at!), "MMM d, yyyy")}
              </span>
            </div>
          )}

          {/* Draw form */}
          {showDrawForm && (
            <Card className="border-dashed">
              <CardHeader className="py-2 px-3">
                <CardTitle className="text-xs capitalize">
                  {showDrawForm === "draw_request" ? "Request Draw" : showDrawForm === "release" ? "Record Release" : "Record Holdback"}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                <Input type="number" placeholder="Amount ($)" value={drawAmount} onChange={e => setDrawAmount(e.target.value)} className="h-8 text-sm" />
                <Textarea placeholder="Notes (optional)" value={drawNotes} onChange={e => setDrawNotes(e.target.value)} className="text-sm min-h-[60px]" />
                <div className="flex gap-2">
                  <Button size="sm" disabled={saving} onClick={submitDraw}><Plus className="h-3.5 w-3.5 mr-1" /> Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setShowDrawForm(null); setDrawAmount(""); setDrawNotes(""); }}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Draw history */}
          {draws.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Draw History</span>
              <div className="space-y-1">
                {draws.map((d: any) => (
                  <div key={d.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] capitalize">{d.draw_type.replace(/_/g, " ")}</Badge>
                      <span>#{d.draw_number}</span>
                      {d.amount != null && (
                        <span className="font-semibold tabular-nums">${Number(d.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Badge variant={d.status === "completed" ? "default" : "secondary"} className="text-[10px]">{d.status}</Badge>
                      <span>{format(new Date(d.requested_at), "M/d/yy")}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog open={showDeskDialog} onOpenChange={setShowDeskDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Headset className="h-4 w-4 text-amber-400" /> Have ChecksOps contact the mortgage company
            </DialogTitle>
            <DialogDescription>
              Our staff will reach out to the mortgage company for this check. You'll be billed a flat fee when the task is completed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Mortgage company *</label>
              <Input
                value={deskCompany}
                onChange={(e) => setDeskCompany(e.target.value)}
                placeholder="e.g. Chase Home Lending"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Loan number (optional)</label>
              <Input
                value={deskLoan}
                onChange={(e) => setDeskLoan(e.target.value)}
                placeholder="Loan #"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Anything we should know? (optional)</label>
              <Textarea
                value={deskNote}
                onChange={(e) => setDeskNote(e.target.value)}
                placeholder="Prior contact, servicer requirements, urgency…"
                className="min-h-[70px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDeskDialog(false)} disabled={deskSubmitting}>
              Cancel
            </Button>
            <Button onClick={submitDeskRequest} disabled={deskSubmitting || !deskCompany.trim()}>
              {deskSubmitting ? "Submitting…" : "Send to ChecksOps"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

