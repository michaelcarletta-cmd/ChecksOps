import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCanMoveChecks } from "@/hooks/useCanMoveChecks";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Send, Building2, ArrowRightLeft, DollarSign, CheckCircle2,
  Clock, AlertTriangle, Eye, EyeOff, Shield, RotateCcw, PackageCheck, Upload,
} from "lucide-react";
import { format } from "date-fns";
import { MortgageContactCard } from "../MortgageContactCard";
import type { LossDraftRecord } from "@/hooks/queries/useLossDraft";
import { useQueryClient } from "@tanstack/react-query";
import { refreshCheckQueues } from "@/lib/checkQueueRefresh";
import { formatIssueDateDisplay } from "@/lib/issueDate";
import { useAcknowledgeMortgageDeskReturn, useMortgageDeskReturnAlert } from "@/hooks/useMortgageDeskReturnAlert";



/*
 * Owner decisions 2026-10-30:
 * - Monitored: the bank deposits the check, so it never goes to Endorsing; the file
 *   stays open here to record escrow and disbursements (amounts only, no money moves).
 * - Not monitored: once the endorsed back of the check is uploaded, the user is asked
 *   to send it to Endorsing, which moves the check and closes this file.
 * - Override: Review always closes the file and returns the check to Review;
 *   Endorsing only for not-monitored files.
 */

/** Override targets the API accepts: "review" closes the file, "endorsing" (not monitored) too. */
export const LOSS_DRAFT_OVERRIDE_REVIEW = "review";
export const LOSS_DRAFT_OVERRIDE_ENDORSING = "endorsing";

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
  /** The file was closed (sent to Endorsing or overridden to Review): return to the list. */
  onClosed?: () => void;
}

const fmtMoney = (v: number) =>
  `$${(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export function LossDraftActionsTab({ lossDraftId, draft, onChanged, onClosed }: Props) {
  const { user } = useAuth();
  const canMoveChecks = useCanMoveChecks();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [actionAmount, setActionAmount] = useState("");
  const [actionNotes, setActionNotes] = useState("");
  const [actionTracking, setActionTracking] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showAdminEdit, setShowAdminEdit] = useState(false);
  const [adminTargetStatus, setAdminTargetStatus] = useState("");
  const [adminResetNotes, setAdminResetNotes] = useState("");
  const [endorsePromptOpen, setEndorsePromptOpen] = useState(false);


  const { data: returnAlert } = useMortgageDeskReturnAlert(draft.check_intake_item_id);
  const acknowledgeReturn = useAcknowledgeMortgageDeskReturn();
  const isMonitored = draft.monitoring_type !== "not_monitored";
  const actionButtons = isMonitored ? MONITORED_ACTIONS : NOT_MONITORED_ACTIONS;
  const availableActions = actionButtons.filter(a =>
    a.fromStatuses.includes(draft.escrow_status)
  );
  const isOpen = draft.escrow_status !== "endorsing" && draft.escrow_status !== "final_release_complete";

  /**
   * The file was closed and its check moved to another lane: refresh the check
   * queues and counts (so the check shows in its new tab) and return to the list.
   */
  const afterFileClosed = () => {
    void refreshCheckQueues(qc, { includeInactive: true, checkId: draft.check_intake_item_id });
    qc.invalidateQueries({ queryKey: ["loss-draft-dashboard"] });
    if (draft.check_intake_item_id) {
      qc.invalidateQueries({ queryKey: ["check-loss-draft-link", draft.check_intake_item_id] });
    }
    onChanged();
    onClosed?.();
  };

  const executeAction = async (action: string, def?: ActionDef) => {
    if (!user?.id) return;
    const amountText = actionAmount.trim();
    if (def?.needsAmount && !/^\d{1,10}(\.\d{1,2})?$/.test(amountText)) {
      toast({ title: "Enter an amount", description: "Use dollars and cents, for example 2500.00.", variant: "destructive" });
      return;
    }
    if (def?.needsAmount && Number(amountText) <= 0) {
      toast({ title: "Enter an amount", description: "The amount must be more than zero.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const extra: Record<string, string> = {};
      if (actionTracking) extra.tracking_number = actionTracking;
      const { data, error } = await supabase.rpc("loss_draft_action", {
        p_loss_draft_id: lossDraftId,
        p_action: action,
        p_actor_id: user.id,
        // At most 2 decimals (checked above), so the number serializes back to the same cents.
        p_amount: def?.needsAmount ? Number(amountText) : null,
        p_notes: actionNotes || null,
        p_extra: extra,
      });
      if (error) throw error;
      let ackError: string | null = null;
      if (draft.check_intake_item_id && returnAlert?.actionRequired && returnAlert.unackedRequestIds.length) {
        const ack = await acknowledgeReturn({
          checkId: draft.check_intake_item_id,
          requestIds: returnAlert.unackedRequestIds,
          senderId: user.id,
        });
        if (ack.error) ackError = ack.error.message || "unknown error";
      }
      if (ackError) {
        toast({
          title: "Action completed, but the Mortgage Desk return was not acknowledged",
          description: ackError,
          variant: "destructive",
        });
      } else if (action === "send_for_endorsements") {
        toast({ title: "Sent to Endorsing", description: "The check is in Endorsing and this loss draft file is closed." });
      } else if ((data as { release_recorded?: boolean } | null)?.release_recorded === false) {
        toast({
          title: "Release recorded",
          description: "The amount was recorded, but the draw could not be added to the Draws list.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Action completed", description: `${action.replace(/_/g, " ")} applied successfully.` });
      }
      setPendingAction(null);
      setActionAmount("");
      setActionNotes("");
      setActionTracking("");
      setEndorsePromptOpen(false);
      if (action === "send_for_endorsements") afterFileClosed();
      else onChanged();
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
        title: "Loss draft closed",
        description: adminTargetStatus === LOSS_DRAFT_OVERRIDE_REVIEW
          ? "The check was moved to Review."
          : "The check was moved to Endorsing.",
      });
      setShowAdminEdit(false);
      setAdminTargetStatus("");
      setAdminResetNotes("");
      afterFileClosed();
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
            onUploaded={(recorded) => {
              onChanged();
              // Not monitored: the endorsed back is the evidence the check came back,
              // so offer to send it to Endorsing right away (monitored never goes there).
              if (recorded && !isMonitored && isOpen) setEndorsePromptOpen(true);
            }}
          />
        )}

        <AlertDialog open={endorsePromptOpen} onOpenChange={setEndorsePromptOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Send this check to Endorsing?</AlertDialogTitle>
              <AlertDialogDescription>
                The endorsed back of the check is on file. Sending it moves the check to
                Endorsing and closes this loss draft file.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={submitting}>Not now</AlertDialogCancel>
              <AlertDialogAction
                disabled={submitting}
                onClick={(e) => {
                  e.preventDefault();
                  executeAction("send_for_endorsements");
                }}
              >
                {submitting ? "Sending..." : "Send to Endorsing"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>


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
                      onClick={() => executeAction(a.action, a)}
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

        {/* Status override — available to every tenant user */}
        {canMoveChecks && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <Shield className="h-3 w-3" /> Override
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
                    Send the check to another lane. This closes the loss draft file and overrides normal workflow.
                  </p>
                  <div>
                    <Label className="text-xs">Send check to</Label>
                    <select
                      className="w-full h-8 rounded-md border border-input bg-background px-3 text-xs"
                      value={adminTargetStatus}
                      onChange={e => setAdminTargetStatus(e.target.value)}
                    >
                      <option value="">Select status...</option>
                      <option value={LOSS_DRAFT_OVERRIDE_REVIEW}>Review</option>
                      {!isMonitored && (
                        <option value={LOSS_DRAFT_OVERRIDE_ENDORSING}>Endorsing</option>
                      )}
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
              Next follow-up: {formatIssueDateDisplay(draft.follow_up_date)}
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
  /** recorded: the upload is in the check audit log (the API's evidence for Endorsing). */
  onUploaded: (recorded: boolean) => void;
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
        .update({
          // Make this returned mortgage-endorsed image the new pristine base
          // and invalidate outputs generated from the previous back image.
          back_image_path: newPath,
          back_image_original_path: newPath,
          back_image_deposit_path: null,
          endorsement_render_status: "idle",
          endorsement_render_meta: null,
        })
        .eq("id", checkId);
      if (updateErr) throw updateErr;

      const { error: auditErr } = await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "back_image_reuploaded",
        actor_id: user?.id ?? null,
        event_description: "Endorsed back of check uploaded from Loss Draft",
        event_data: { old_path: existing?.back_image_path ?? null, new_path: newPath },
      });

      if (auditErr) {
        toast({
          title: "Endorsed check uploaded, but not recorded",
          description: `The audit log entry failed (${auditErr.message}); it cannot be sent to Endorsing until it is recorded.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Endorsed check uploaded",
          description: "Back of check updated with mortgage endorsement.",
        });
      }
      onUploaded(!auditErr);
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

