import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermissions";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Send, Building2, ArrowRightLeft, DollarSign, CheckCircle2,
  Clock, AlertTriangle, Eye, EyeOff, Shield, RotateCcw, PackageCheck, Upload, FileText,
} from "lucide-react";
import { format } from "date-fns";
import { MortgageContactCard } from "../MortgageContactCard";
import type { LossDraftRecord } from "@/hooks/queries/useLossDraft";
import { ClaimLedgerCard } from "@/components/payments/ClaimLedgerCard";
import { ClaimSettlementEditor } from "@/components/payments/ClaimSettlementEditor";
import { useQuery } from "@tanstack/react-query";



/* Not Monitored = mortgage endorses & releases check, no escrow/draws */
const NOT_MONITORED_ACTIONS: ActionDef[] = [
  { action: "mark_sent", label: "Sent Check to Mortgage Company", icon: Send, color: "text-blue-400", needsTracking: true, fromStatuses: ["pending_send"] },
  { action: "mark_received_back", label: "Received Check from Mortgage Company (Endorsed)", icon: PackageCheck, color: "text-emerald-400", fromStatuses: ["sent_to_lender", "received_by_lender", "escrowed", "first_draw_requested", "partial_release"] },
  { action: "send_for_endorsements", label: "Send for Endorsements", icon: Send, color: "text-orange-400", fromStatuses: ["check_received_back"] },
];

/* Monitored = mortgage holds funds in escrow, draws required */
const MONITORED_ACTIONS: ActionDef[] = [
  { action: "mark_sent", label: "Check Sent to Mortgage Company", icon: Send, color: "text-blue-400", needsTracking: true, fromStatuses: ["pending_send"] },
  { action: "mark_escrowed", label: "Mark Escrowed", icon: Building2, color: "text-amber-400", needsAmount: true, fromStatuses: ["sent_to_lender", "received_by_lender", "pending_send"] },
  { action: "request_draw", label: "Request Draw", icon: ArrowRightLeft, color: "text-orange-400", needsAmount: true, fromStatuses: ["escrowed", "first_draw_requested", "partial_release"] },
  { action: "record_release", label: "Record Release", icon: DollarSign, color: "text-emerald-400", needsAmount: true, fromStatuses: ["first_draw_requested", "partial_release", "escrowed"] },
  { action: "record_holdback", label: "Record Holdback", icon: AlertTriangle, color: "text-red-400", needsAmount: true, fromStatuses: ["escrowed", "first_draw_requested", "partial_release"] },
  { action: "mark_final_release", label: "Mark Final Release", icon: CheckCircle2, color: "text-primary", fromStatuses: ["partial_release", "escrowed", "first_draw_requested"] },
];

interface ActionDef {
  action: string;
  label: string;
  icon: typeof Send;
  color: string;
  needsAmount?: boolean;
  needsTracking?: boolean;
  fromStatuses: string[];
}

interface Props {
  lossDraftId: string;
  draft: LossDraftRecord;
  onChanged: () => void;
}

const fmtMoney = (v: number) =>
  `$${(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export function LossDraftActionsTab({ lossDraftId, draft, onChanged }: Props) {
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const { toast } = useToast();

  const [actionAmount, setActionAmount] = useState("");
  const [actionNotes, setActionNotes] = useState("");
  const [actionTracking, setActionTracking] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showAdminEdit, setShowAdminEdit] = useState(false);
  const [adminTargetStatus, setAdminTargetStatus] = useState("");
  const [adminResetNotes, setAdminResetNotes] = useState("");
  const [ledgerEditorOpen, setLedgerEditorOpen] = useState(false);

  // Fetch settlement for the ledger editor
  const { data: settlement } = useQuery({
    queryKey: ["claim-ledger-settlement", draft.claim_id],
    enabled: !!draft.claim_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_settlements")
        .select("*")
        .eq("claim_id", draft.claim_id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });


  const isMonitored = draft.monitoring_type !== "not_monitored";
  const actionButtons = isMonitored ? MONITORED_ACTIONS : NOT_MONITORED_ACTIONS;
  const availableActions = actionButtons.filter(a =>
    a.fromStatuses.includes(draft.escrow_status)
  );

  const executeAction = async (action: string) => {
    if (!user?.id) return;
    setSubmitting(true);
    try {
      const extra: Record<string, string> = {};
      if (actionTracking) extra.tracking_number = actionTracking;
      const { error } = await supabase.rpc("loss_draft_action", {
        p_loss_draft_id: lossDraftId,
        p_action: action,
        p_actor_id: user.id,
        p_amount: actionAmount ? parseFloat(actionAmount) : null,
        p_notes: actionNotes || null,
        p_extra: extra,
      });
      if (error) throw error;
      toast({ title: "Action completed", description: `${action.replace(/_/g, " ")} applied successfully.` });
      setPendingAction(null);
      setActionAmount("");
      setActionNotes("");
      setActionTracking("");
      onChanged();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const toggleMonitoringType = async () => {
    if (!user?.id) return;
    const newType = isMonitored ? "not_monitored" : "monitored";
    try {
      const { error } = await supabase.rpc("loss_draft_action", {
        p_loss_draft_id: lossDraftId,
        p_action: "set_monitoring_type",
        p_actor_id: user.id,
        p_amount: null,
        p_notes: `Changed to ${newType}`,
        p_extra: { monitoring_type: newType },
      });
      if (error) throw error;
      toast({
        title: "Monitoring type updated",
        description: `Set to ${newType === "monitored" ? "Monitored" : "Not Monitored"}`,
      });
      onChanged();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const adminResetStatus = async () => {
    if (!user?.id || !adminTargetStatus) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.rpc("loss_draft_action", {
        p_loss_draft_id: lossDraftId,
        p_action: "admin_reset_status",
        p_actor_id: user.id,
        p_amount: null,
        p_notes: adminResetNotes || `Admin reset to ${adminTargetStatus}`,
        p_extra: { target_status: adminTargetStatus },
      });
      if (error) throw error;
      toast({
        title: "Status reset",
        description: `Status changed to ${adminTargetStatus.replace(/_/g, " ")}`,
      });
      setShowAdminEdit(false);
      setAdminTargetStatus("");
      setAdminResetNotes("");
      onChanged();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="p-4 space-y-3">
        {/* Monitoring Type Toggle */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={isMonitored ? "default" : "outline"}
            className="flex-1 text-xs"
            onClick={() => !isMonitored && toggleMonitoringType()}
          >
            <Eye className="h-3.5 w-3.5 mr-1" /> Monitored
          </Button>
          <Button
            size="sm"
            variant={!isMonitored ? "default" : "outline"}
            className="flex-1 text-xs"
            onClick={() => isMonitored && toggleMonitoringType()}
          >
            <EyeOff className="h-3.5 w-3.5 mr-1" /> Not Monitored
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {isMonitored
            ? "Mortgage company holds funds in escrow — draws required to release."
            : "Mortgage company will endorse and release the check — no escrow or draws."}
        </p>

        {draft.tracking_number_sent && (
          <div className="bg-accent/30 rounded-lg p-2">
            <p className="text-[10px] text-muted-foreground">Tracking Number</p>
            <p className="text-xs font-medium">{draft.tracking_number_sent}</p>
          </div>
        )}

        <MortgageContactCard
          lossDraftId={lossDraftId}
          servicerName={draft.mortgage_servicer}
        />

        {draft.check_intake_item_id && (
          <EndorsedCheckUpload
            checkId={draft.check_intake_item_id}
            highlighted={
              draft.escrow_status === "check_received_back" ||
              !!draft.check_received_back_date
            }
            onUploaded={onChanged}
          />
        )}


        {isMonitored && (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Total Escrowed" value={fmtMoney(draft.total_escrowed)} />
            <Stat label="Released" value={fmtMoney(draft.draw_amount_released)} valueClass="text-emerald-400" />
            <Stat label="Holdback" value={fmtMoney(draft.holdback_amount)} valueClass="text-red-400" />
            <Stat
              label="Unreleased"
              value={fmtMoney(draft.total_escrowed - draft.draw_amount_released)}
              valueClass="text-amber-400"
            />
          </div>
        )}

        <Separator />

        {/* Claim Ledger */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <FileText className="h-3 w-3" /> Claim Ledger
            </p>
            {draft.claim_id && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => setLedgerEditorOpen(true)}
              >
                <DollarSign className="h-3 w-3 mr-1" /> Edit Ledger
              </Button>
            )}
          </div>
          <ClaimLedgerCard
            checkIntakeItemId={draft.check_intake_item_id!}
            claimId={draft.claim_id}
            detectedClaimNumber={draft.check_intake_items?.detected_claim_number ?? null}
            onLinked={onChanged}
          />
          {draft.claim_id && (
            <ClaimSettlementEditor
              open={ledgerEditorOpen}
              onOpenChange={setLedgerEditorOpen}
              claimId={draft.claim_id}
              settlement={settlement}
            />
          )}
        </div>

        <Separator />


        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Available Actions</p>
          {availableActions.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              No actions available for current status
            </p>
          )}
          {availableActions.map(a => (
            <div key={a.action}>
              {pendingAction === a.action ? (
                <div className="border rounded-lg p-3 space-y-2">
                  <p className="text-xs font-medium">{a.label}</p>
                  {a.needsTracking && (
                    <div>
                      <Label className="text-xs">Tracking Number</Label>
                      <Input
                        placeholder="Enter shipping tracking #"
                        value={actionTracking}
                        onChange={e => setActionTracking(e.target.value)}
                        className="h-8"
                      />
                    </div>
                  )}
                  {a.needsAmount && (
                    <div>
                      <Label className="text-xs">Amount</Label>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={actionAmount}
                        onChange={e => setActionAmount(e.target.value)}
                        className="h-8"
                      />
                    </div>
                  )}
                  <div>
                    <Label className="text-xs">Notes</Label>
                    <Textarea
                      rows={2}
                      value={actionNotes}
                      onChange={e => setActionNotes(e.target.value)}
                      placeholder="Optional notes..."
                      className="text-xs"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="text-xs"
                      disabled={submitting}
                      onClick={() => executeAction(a.action)}
                    >
                      {submitting ? "Saving..." : "Confirm"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs"
                      onClick={() => setPendingAction(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-auto min-h-8 w-full justify-start whitespace-normal break-words text-left text-xs leading-snug"
                  onClick={() => setPendingAction(a.action)}
                >
                  <a.icon className={`h-3.5 w-3.5 mr-2 shrink-0 ${a.color}`} />
                  <span className="min-w-0 break-words">{a.label}</span>
                </Button>
              )}
            </div>
          ))}
        </div>

        {/* Admin Override */}
        {isAdmin && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <Shield className="h-3 w-3" /> Admin Override
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs h-6 px-2"
                  onClick={() => setShowAdminEdit(!showAdminEdit)}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  {showAdminEdit ? "Cancel" : "Edit Status"}
                </Button>
              </div>
              {showAdminEdit && (
                <div className="border border-destructive/30 rounded-lg p-3 space-y-2 bg-destructive/5">
                  <p className="text-[10px] text-destructive">
                    Change the escrow status and monitoring type. This overrides normal workflow.
                  </p>
                  <div>
                    <Label className="text-xs">Target Status</Label>
                    <select
                      className="w-full h-8 rounded-md border border-input bg-background px-3 text-xs"
                      value={adminTargetStatus}
                      onChange={e => setAdminTargetStatus(e.target.value)}
                    >
                      <option value="">Select status...</option>
                      <option value="pending_send">Review</option>
                      <option value="endorsing">Endorsing</option>
                      <option value="escrowed">Loss Draft</option>
                      <option value="pending_reissue">Reissue</option>
                      <option value="void">Void</option>
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">Reason for change</Label>
                    <Textarea
                      rows={2}
                      value={adminResetNotes}
                      onChange={e => setAdminResetNotes(e.target.value)}
                      placeholder="e.g. Mortgage sent check back endorsed, not monitoring"
                      className="text-xs"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="text-xs"
                    disabled={submitting || !adminTargetStatus}
                    onClick={adminResetStatus}
                  >
                    {submitting ? "Saving..." : "Apply Override"}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}

        {draft.follow_up_date && (
          <div className="bg-accent/30 rounded-lg p-2 mt-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              Next follow-up: {format(new Date(draft.follow_up_date), "MMM d, yyyy")}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {draft.follow_up_count} contacts · Last:{" "}
              {draft.last_contact_at
                ? format(new Date(draft.last_contact_at), "MMM d 'at' h:mm a")
                : "Never"}
            </p>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-accent/30 rounded-lg p-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold ${valueClass ?? ""}`}>{value}</p>
    </div>
  );
}

function EndorsedCheckUpload({
  checkId,
  highlighted,
  onUploaded,
}: {
  checkId: string;
  highlighted: boolean;
  onUploaded: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const newPath = `checks/${checkId}/back-${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from("claim-files")
        .upload(newPath, file, {
          cacheControl: "31536000",
          upsert: false,
          contentType: file.type || "image/jpeg",
        });
      if (uploadErr) throw uploadErr;

      const { data: existing } = await supabase
        .from("check_intake_items")
        .select("back_image_path")
        .eq("id", checkId)
        .maybeSingle();

      const { error: updateErr } = await supabase
        .from("check_intake_items")
        .update({ back_image_path: newPath })
        .eq("id", checkId);
      if (updateErr) throw updateErr;

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "back_image_reuploaded",
        actor_id: user?.id ?? null,
        event_description: "Endorsed back of check uploaded from Loss Draft",
        event_data: { old_path: existing?.back_image_path ?? null, new_path: newPath },
      });

      toast({
        title: "Endorsed check uploaded",
        description: "Back of check updated with mortgage endorsement.",
      });
      onUploaded();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className={`rounded-lg border p-2 space-y-1.5 ${
        highlighted
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-border bg-accent/20"
      }`}
    >
      <p className="text-xs font-medium flex items-center gap-1.5">
        <PackageCheck className="h-3.5 w-3.5 text-emerald-400" />
        Endorsed Check from Mortgage
      </p>
      <p className="text-[10px] text-muted-foreground">
        Upload the back of the check once received and endorsed by the mortgage company.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
      <Button
        size="sm"
        variant={highlighted ? "default" : "outline"}
        className="w-full text-xs"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className={`h-3.5 w-3.5 mr-1.5 ${uploading ? "animate-spin" : ""}`} />
        {uploading ? "Uploading..." : "Upload Endorsed Back of Check"}
      </Button>
    </div>
  );
}

