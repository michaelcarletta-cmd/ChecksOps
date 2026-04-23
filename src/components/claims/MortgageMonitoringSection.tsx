import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Building2, Truck, PackageCheck, ArrowDownToLine,
  Lock, CheckCircle2, Plus, DollarSign,
} from "lucide-react";
import { format } from "date-fns";

type MonitoringType = "not_set" | "monitored" | "not_monitored";

type DrawRecord = {
  id: string;
  draw_number: number;
  draw_type: string;
  amount: number | null;
  status: string;
  requested_at: string;
  completed_at: string | null;
  notes: string | null;
};

type Props = {
  claimId: string;
  checkId: string;
  check: any;
  draws: DrawRecord[];
  onRefresh: () => void;
};

export function MortgageMonitoringSection({ claimId, checkId, check, draws, onRefresh }: Props) {
  const monitoringType: MonitoringType = check?.mortgage_monitoring_type ?? "not_set";
  const [trackingNumber, setTrackingNumber] = useState("");
  const [showTrackingInput, setShowTrackingInput] = useState(false);
  const [drawAmount, setDrawAmount] = useState("");
  const [drawNotes, setDrawNotes] = useState("");
  const [showDrawForm, setShowDrawForm] = useState<string | null>(null); // draw_request | release | holdback
  const [saving, setSaving] = useState(false);

  async function setMonitoring(type: MonitoringType) {
    setSaving(true);
    await supabase
      .from("claim_checks")
      .update({ mortgage_monitoring_type: type } as any)
      .eq("id", checkId);
    await logEvent(`mortgage_set_${type}`, `Check marked as ${type === "monitored" ? "Monitored" : "Not Monitored"} mortgage.`);
    setSaving(false);
    onRefresh();
  }

  async function markSentToMortgage() {
    setSaving(true);
    await supabase
      .from("claim_checks")
      .update({
        mortgage_sent_at: new Date().toISOString(),
        mortgage_tracking_number: trackingNumber || null,
      } as any)
      .eq("id", checkId);
    await logEvent("check_sent_to_mortgage", `Check sent to mortgage company.${trackingNumber ? ` Tracking: ${trackingNumber}` : ""}`);
    setShowTrackingInput(false);
    setTrackingNumber("");
    setSaving(false);
    onRefresh();
  }

  async function markReceivedFromMortgage() {
    setSaving(true);
    await supabase
      .from("claim_checks")
      .update({ mortgage_received_at: new Date().toISOString() } as any)
      .eq("id", checkId);
    await logEvent("check_received_from_mortgage", "Check received back from mortgage company.");
    setSaving(false);
    onRefresh();
  }

  async function markFinalRelease() {
    setSaving(true);
    await supabase
      .from("claim_checks")
      .update({ mortgage_final_released_at: new Date().toISOString() } as any)
      .eq("id", checkId);
    await logEvent("mortgage_final_release", "Mortgage final release completed.");
    setSaving(false);
    onRefresh();
  }

  async function submitDraw() {
    if (!showDrawForm) return;
    setSaving(true);
    const nextDrawNum = draws.length + 1;
    await supabase.from("claim_check_mortgage_draws" as any).insert({
      check_id: checkId,
      claim_id: claimId,
      draw_number: nextDrawNum,
      draw_type: showDrawForm,
      amount: drawAmount ? parseFloat(drawAmount) : null,
      status: showDrawForm === "draw_request" ? "requested" : "completed",
      notes: drawNotes || null,
      completed_at: showDrawForm !== "draw_request" ? new Date().toISOString() : null,
    });
    const typeLabel = showDrawForm === "draw_request" ? "Draw Request" : showDrawForm === "release" ? "Release" : "Holdback";
    await logEvent(`mortgage_${showDrawForm}`, `${typeLabel} #${nextDrawNum}${drawAmount ? ` — $${parseFloat(drawAmount).toLocaleString()}` : ""}`);
    setShowDrawForm(null);
    setDrawAmount("");
    setDrawNotes("");
    setSaving(false);
    onRefresh();
  }

  async function logEvent(eventType: string, summary: string) {
    await supabase.from("claim_events").insert({
      claim_id: claimId,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      date_source: "system",
      summary,
      metadata_json: { check_id: checkId },
    });
  }

  const isSent = !!check?.mortgage_sent_at;
  const isReceived = !!check?.mortgage_received_at;
  const isFinalReleased = !!check?.mortgage_final_released_at;

  return (
    <div className="space-y-4">
      <Separator />
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold">Mortgage / Loss Draft</span>
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
          <Button
            size="sm"
            variant="ghost"
            className="text-xs h-6 px-2 text-muted-foreground"
            onClick={() => setMonitoring("not_set")}
          >
            Change
          </Button>
        </div>
      )}

      {/* Tracking number display if already sent */}
      {isSent && (
        <div className="rounded-md bg-muted/50 p-3 space-y-1 text-sm">
          <div className="flex items-center gap-2 text-emerald-400">
            <Truck className="h-3.5 w-3.5" />
            Sent to Mortgage Company
          </div>
          <div className="text-xs text-muted-foreground">
            {format(new Date(check.mortgage_sent_at), "MMM d, yyyy h:mm a")}
          </div>
          {check?.mortgage_tracking_number && (
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
            <>
              {showTrackingInput ? (
                <div className="space-y-2">
                  <Input
                    placeholder="Tracking number (optional)"
                    value={trackingNumber}
                    onChange={e => setTrackingNumber(e.target.value)}
                    className="h-8 text-sm"
                  />
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
              )}
            </>
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
                {format(new Date(check.mortgage_received_at), "MMM d, yyyy")}
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

          {/* Send to mortgage */}
          {!isSent && (
            <>
              {showTrackingInput ? (
                <div className="space-y-2">
                  <Input
                    placeholder="Tracking number (optional)"
                    value={trackingNumber}
                    onChange={e => setTrackingNumber(e.target.value)}
                    className="h-8 text-sm"
                  />
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
              )}
            </>
          )}

          {/* Draw actions - available after sent */}
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
                {format(new Date(check.mortgage_final_released_at), "MMM d, yyyy")}
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
                <Input
                  type="number"
                  placeholder="Amount ($)"
                  value={drawAmount}
                  onChange={e => setDrawAmount(e.target.value)}
                  className="h-8 text-sm"
                />
                <Textarea
                  placeholder="Notes (optional)"
                  value={drawNotes}
                  onChange={e => setDrawNotes(e.target.value)}
                  className="text-sm min-h-[60px]"
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={saving} onClick={submitDraw}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setShowDrawForm(null); setDrawAmount(""); setDrawNotes(""); }}>
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Draw history */}
          {draws.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Draw History</span>
              <div className="space-y-1">
                {draws.map(d => (
                  <div key={d.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {d.draw_type.replace(/_/g, " ")}
                      </Badge>
                      <span>#{d.draw_number}</span>
                      {d.amount != null && (
                        <span className="font-semibold tabular-nums">
                          ${d.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Badge variant={d.status === "completed" ? "default" : "secondary"} className="text-[10px]">
                        {d.status}
                      </Badge>
                      <span>{format(new Date(d.requested_at), "M/d/yy")}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
